import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { DirectionVersion, DirectionTokens, KeyartConfig } from "../types.js";
import { CommandError } from "../errors.js";
import type { SlotKind, SurfaceSlot } from "./schema.js";
import { composeSlotDescribe, runSurfaceFill } from "./fill.js";
import { runSurfaceBind } from "./bind.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { createSurfaceCore } from "./store.js";
import { readAssetIndex, retireExtractedAsset } from "../asset/asset-store.js";
import { runAssetRegenerate } from "../asset/extract.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});
vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return {
    ...actual,
    hasApiKey: vi.fn(actual.hasApiKey),
    generateImage: vi.fn(actual.generateImage),
  };
});

import { hasApiKey, generateImage } from "../openai.js";

const VERSION_ID = "2026-08-05T00-00-00-000Z";

const FIXTURE_TOKENS: DirectionTokens = {
  palette: [
    { role: "primary", name: "Hot Pink", hex: "#e84393" },
    { role: "secondary", name: "Sky Blue", hex: "#2d98da" },
    { role: "background", name: "Cream", hex: "#faf6f0" },
    { role: "surface", name: "White", hex: "#ffffff" },
    { role: "text", name: "Ink", hex: "#1c1a17" },
    { role: "muted", name: "Slate", hex: "#6c757d" },
  ],
  brand: [
    { hex: "#e84393", name: "pink", label: "Hot Pink" },
    { hex: "#2d98da", name: "sky-blue" },
  ],
  typography: { heading: "Space Grotesk", body: "Inter", scale: 1.25 },
  shape: { radius: "8px", spacingUnit: "8px" },
};

function makeDirectionVersion(
  tokens: DirectionTokens,
  overrides: Partial<DirectionVersion> = {},
): DirectionVersion {
  return {
    id: VERSION_ID,
    createdAt: "2026-08-05T00:00:00.000Z",
    briefSnapshot: "brief snapshot",
    contextSnapshot: "context snapshot",
    name: "Direction A",
    summary: "A summary.",
    positioning: "A positioning statement.",
    character: {},
    homepageMockupPrompt: "",
    styleTilePrompt: "",
    copyExamples: { headline: "h", subheadline: "s", cta: "c" },
    usage: { rules: [], antiRules: [] },
    tokens,
    ...overrides,
  };
}

function makeSlot(
  id: string,
  kind: SlotKind,
  overrides: Partial<SurfaceSlot> = {},
): SurfaceSlot {
  return {
    id,
    kind,
    description: `Description for ${id}`,
    criticality: "required",
    origin: "authored",
    attributions: [],
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-surface-fill-"));
  delete process.env.OPENAI_API_KEY;

  const actualOpenai = await vi.importActual<typeof import("../openai.js")>("../openai.js");
  vi.mocked(hasApiKey).mockImplementation(actualOpenai.hasApiKey);
  vi.mocked(generateImage).mockImplementation(actualOpenai.generateImage);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function mockConfig(): KeyartConfig {
  return {
    project: { name: "Test Project", type: "prototype", framework: "next" },
    brand: {
      root: path.join(tmpDir, "brand"),
      references: path.join(tmpDir, "brand", "input", "references"),
      approved: path.join(tmpDir, "brand", "approved"),
      rejected: path.join(tmpDir, "brand", "rejected"),
    },
    models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
    outputs: {
      cursorRules: path.join(tmpDir, ".cursor", "rules", "keyart-brand.mdc"),
      cssVars: path.join(tmpDir, "brand", "generated", "brand.css"),
      implementationBrief: path.join(
        tmpDir,
        "brand",
        "generated",
        "implementation-brief.md",
      ),
    },
    store: { driver: "file" },
  };
}

async function useConfig(config: KeyartConfig): Promise<void> {
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(config);
}

function directionDirOf(directionId: string): string {
  return path.join(tmpDir, "brand", "directions", directionId);
}

async function writeDirectionVersionFile(
  config: KeyartConfig,
  directionId: string,
  version: DirectionVersion,
): Promise<void> {
  const versionDir = path.join(directionDirOf(directionId), "versions", version.id);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(
    path.join(versionDir, "direction-version.json"),
    JSON.stringify(version),
    "utf-8",
  );
  await createDirectionCore(tmpDir, config).appendVersion(directionId, version.id);
}

/** Seeds direction-a@VERSION_ID and approves it. */
async function seedApprovedDirection(config: KeyartConfig): Promise<void> {
  await createDirectionCore(tmpDir, config).create({ id: "direction-a", name: "Direction A" });
  await writeDirectionVersionFile(config, "direction-a", makeDirectionVersion(FIXTURE_TOKENS));
  await createBrandCore(tmpDir, config).setPointer({
    directionId: "direction-a",
    versionId: VERSION_ID,
  });
}

async function findFiles(dir: string, suffix: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.name.endsWith(suffix)) {
        out.push(abs);
      }
    }
  }
  await walk(dir);
  return out;
}

function mockKeyedGeneration(): void {
  process.env.OPENAI_API_KEY = "test-key";
  vi.mocked(hasApiKey).mockReturnValue(true);
  vi.mocked(generateImage).mockImplementation(async (opts) => {
    await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
    await fs.writeFile(opts.outPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    return { written: true, dryRun: false };
  });
}

// ---------------------------------------------------------------------------
// composeSlotDescribe — pure, deterministic (Test 2, unit half)
// ---------------------------------------------------------------------------

describe("composeSlotDescribe — purity", () => {
  it("fixed field order, absent fields omitted, byte-identical for the same input", () => {
    const slot = makeSlot("icon.restaurant", "icon", {
      context: {
        sitsOn: "primary",
        sizes: [24, 16],
        usedIn: ["nav", "empty-state"],
        tone: "friendly, rounded",
        note: "keep it simple",
      },
    });

    const first = composeSlotDescribe(slot);
    const second = composeSlotDescribe(slot);
    expect(first).toBe(second);
    expect(first.split("\n")).toEqual([
      "Description for icon.restaurant",
      "Surface slot: icon.restaurant (icon).",
      "Rendered at 16px, 24px — keep the silhouette bold and legible at 16px.",
      'It sits on the brand\'s "primary" color — ensure the shape stays clearly visible against that role.',
      "Used in: nav, empty-state.",
      "Tone: friendly, rounded.",
      "Note: keep it simple.",
    ]);
  });

  it("omits every absent context field — no empty lines, no placeholders", () => {
    const slot = makeSlot("icon.plain", "icon");
    expect(composeSlotDescribe(slot)).toBe(
      "Description for icon.plain\nSurface slot: icon.plain (icon).",
    );
  });
});

// ---------------------------------------------------------------------------
// Test 1 — keyless fill records honest pending state, no image.
// ---------------------------------------------------------------------------

describe("runSurfaceFill — keyless pending (Test 1, SC-05)", () => {
  it("fills every asset-slot gap in manifest order, no image, no fabrication", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);
    await createSurfaceCore(tmpDir, config).setManifest([
      makeSlot("icon.restaurant", "icon", {
        context: {
          sitsOn: "primary",
          sizes: [24, 16],
          usedIn: ["nav"],
          tone: "friendly",
        },
      }),
      makeSlot("illustration.empty-cart", "illustration"),
      makeSlot("color.background", "color-role"),
    ]);

    const result = await runSurfaceFill({ cwd: tmpDir });

    expect(result.dryRun).toBe(true);
    expect(result.filled).toHaveLength(2);
    expect(result.filled.map((f) => f.slotId)).toEqual([
      "icon.restaurant",
      "illustration.empty-cart",
    ]);

    for (const f of result.filled) {
      expect(f.dryRun).toBe(true);
      const index = await readAssetIndex(directionDirOf("direction-a"), f.assetId);
      expect(index.slotId).toBe(f.slotId);
      expect(index.directionId).toBe("direction-a");
    }

    const pngs = await findFiles(path.join(directionDirOf("direction-a"), "extracted-assets"), ".png");
    expect(pngs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2 — slot context + art direction reach the composed prompt.
// ---------------------------------------------------------------------------

describe("runSurfaceFill — context + art direction reach the prompt (Test 2, SC-05)", () => {
  it("the composed asset-prompt.md carries description, provenance, legibility, contrast, tone, isolation, MUST/AVOID", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);

    const HARD_RULE = "Never use stock-photo people";
    const DISCARD_NOTE = "washed-out pastel wash";
    await createBrandCore(tmpDir, config).addRule({
      text: HARD_RULE,
      severity: "hard",
      author: "test",
      source: "test",
    });
    await createDirectionCore(tmpDir, config).appendFeedback("direction-a", {
      body: DISCARD_NOTE,
      author: "test",
      source: "test",
      channel: "visual",
      polarity: "avoid",
    });

    await createSurfaceCore(tmpDir, config).setManifest([
      makeSlot("icon.restaurant", "icon", {
        context: { sitsOn: "primary", sizes: [24, 16], tone: "friendly" },
      }),
    ]);

    const result = await runSurfaceFill({ cwd: tmpDir });
    const f = result.filled[0];
    const promptPath = path.join(
      directionDirOf("direction-a"),
      "extracted-assets",
      f.assetId,
      "versions",
      f.versionId,
      "asset-prompt.md",
    );
    const prompt = await fs.readFile(promptPath, "utf-8");

    expect(prompt).toContain("Description for icon.restaurant");
    expect(prompt).toContain("Surface slot: icon.restaurant (icon).");
    expect(prompt).toContain("legible at 16px");
    expect(prompt).toContain('"primary" color');
    expect(prompt).toContain("Tone: friendly.");
    expect(prompt).toContain("fully transparent background");
    expect(prompt).toContain(HARD_RULE);
    expect(prompt).toContain(DISCARD_NOTE);
    expect(prompt).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});

// ---------------------------------------------------------------------------
// Test 3 — the next bind resolves keyless as pending, keyed as bound.
// ---------------------------------------------------------------------------

describe("runSurfaceFill — closes the loop with bind (Test 3, SC-05)", () => {
  it("keyless fill resolves pending; a keyed fill resolves bound with a PNG file", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);
    const surfaceCore = createSurfaceCore(tmpDir, config);
    await surfaceCore.setManifest([
      makeSlot("icon.restaurant", "icon"),
      makeSlot("illustration.empty-cart", "illustration"),
    ]);

    await runSurfaceFill({ cwd: tmpDir });

    const bind1 = await runSurfaceBind({ cwd: tmpDir });
    for (const slotId of ["icon.restaurant", "illustration.empty-cart"]) {
      const row = bind1.binding.slots.find((s) => s.slotId === slotId)!;
      expect(row.status).toBe("pending");
      expect(row.assetId).toBeTruthy();
    }

    // A THIRD gap slot, added after the keyless fill above.
    await surfaceCore.patchSlots([makeSlot("icon.scooter", "icon")]);

    mockKeyedGeneration();
    const keyedResult = await runSurfaceFill({ cwd: tmpDir, slot: "icon.scooter" });
    expect(keyedResult.dryRun).toBe(false);
    expect(keyedResult.filled[0].dryRun).toBe(false);

    const bind2 = await runSurfaceBind({ cwd: tmpDir });
    const scooterRow = bind2.binding.slots.find((s) => s.slotId === "icon.scooter")!;
    expect(scooterRow.status).toBe("bound");
    expect(scooterRow.file).toMatch(/icon-scooter\.png$/);
  });
});

// ---------------------------------------------------------------------------
// Test 4 — repeated keyless fill is idempotent.
// ---------------------------------------------------------------------------

describe("runSurfaceFill — repeated keyless fill is idempotent (Test 4)", () => {
  it("a second keyless run mints nothing new", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);
    await createSurfaceCore(tmpDir, config).setManifest([
      makeSlot("icon.restaurant", "icon"),
      makeSlot("illustration.empty-cart", "illustration"),
    ]);

    const first = await runSurfaceFill({ cwd: tmpDir });
    expect(first.filled).toHaveLength(2);

    const before = await fs.readdir(path.join(directionDirOf("direction-a"), "extracted-assets"));

    const second = await runSurfaceFill({ cwd: tmpDir });
    expect(second.filled).toHaveLength(0);

    const after = await fs.readdir(path.join(directionDirOf("direction-a"), "extracted-assets"));
    expect(after.sort()).toEqual(before.sort());
  });
});

// ---------------------------------------------------------------------------
// Test 5 — --slot targets exactly one slot.
// ---------------------------------------------------------------------------

describe("runSurfaceFill — --slot targets exactly one slot (Test 5)", () => {
  it("mints only the named slot, leaving the other a gap", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);
    await createSurfaceCore(tmpDir, config).setManifest([
      makeSlot("icon.restaurant", "icon"),
      makeSlot("illustration.empty-cart", "illustration"),
    ]);

    const result = await runSurfaceFill({ cwd: tmpDir, slot: "icon.restaurant" });
    expect(result.filled).toHaveLength(1);
    expect(result.filled[0].slotId).toBe("icon.restaurant");

    const bind = await runSurfaceBind({ cwd: tmpDir });
    const other = bind.binding.slots.find((s) => s.slotId === "illustration.empty-cart")!;
    expect(other.status).toBe("gap");
  });
});

// ---------------------------------------------------------------------------
// Test 6 — --slot on color-role/type-role is a teaching rejection.
// ---------------------------------------------------------------------------

describe("runSurfaceFill — --slot on a color-role/type-role rejects, naming bind (Test 6, SC-05)", () => {
  it("rejects both kinds, minting nothing", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);
    await createSurfaceCore(tmpDir, config).setManifest([
      makeSlot("color.success", "color-role", { context: { sitsOn: "background" } }),
      makeSlot("type.heading", "type-role"),
    ]);

    await expect(runSurfaceFill({ cwd: tmpDir, slot: "color.success" })).rejects.toThrow(
      CommandError,
    );
    await expect(runSurfaceFill({ cwd: tmpDir, slot: "color.success" })).rejects.toThrow(
      /surface bind/,
    );
    await expect(runSurfaceFill({ cwd: tmpDir, slot: "type.heading" })).rejects.toThrow(
      /surface bind/,
    );

    await expect(
      fs.access(path.join(directionDirOf("direction-a"), "extracted-assets")),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 7 — --slot on unknown/retired/other slots.
// ---------------------------------------------------------------------------

describe("runSurfaceFill — --slot on unknown/retired/other slots refuses (Test 7)", () => {
  it("rejects each case, minting nothing", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);
    const core = createSurfaceCore(tmpDir, config);
    await core.setManifest([
      makeSlot("icon.will-retire", "icon"),
      makeSlot("other.mystery", "other", { context: { note: "unclassified need" } }),
    ]);
    await core.retireSlot("icon.will-retire");

    await expect(runSurfaceFill({ cwd: tmpDir, slot: "icon.unknown" })).rejects.toThrow(
      /Unknown or retired slot/,
    );
    await expect(runSurfaceFill({ cwd: tmpDir, slot: "icon.will-retire" })).rejects.toThrow(
      /Unknown or retired slot/,
    );
    await expect(runSurfaceFill({ cwd: tmpDir, slot: "other.mystery" })).rejects.toThrow(
      /taxonomy demand|surface patch/,
    );

    await expect(
      fs.access(path.join(directionDirOf("direction-a"), "extracted-assets")),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 8 — --slot on an already-claimed slot refuses, naming the asset.
// ---------------------------------------------------------------------------

describe("runSurfaceFill — --slot on an already-claimed slot refuses (Test 8)", () => {
  it("names the claiming asset and the remedies; never mints a second claimant", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);
    await createSurfaceCore(tmpDir, config).setManifest([makeSlot("icon.restaurant", "icon")]);

    const first = await runSurfaceFill({ cwd: tmpDir });
    const assetId = first.filled[0].assetId;

    await expect(runSurfaceFill({ cwd: tmpDir, slot: "icon.restaurant" })).rejects.toThrow(
      CommandError,
    );
    await expect(runSurfaceFill({ cwd: tmpDir, slot: "icon.restaurant" })).rejects.toThrow(
      new RegExp(assetId),
    );
    await expect(runSurfaceFill({ cwd: tmpDir, slot: "icon.restaurant" })).rejects.toThrow(
      /asset regenerate/,
    );
    await expect(runSurfaceFill({ cwd: tmpDir, slot: "icon.restaurant" })).rejects.toThrow(
      /asset remove/,
    );

    const bind = await runSurfaceBind({ cwd: tmpDir });
    const row = bind.binding.slots.find((s) => s.slotId === "icon.restaurant")!;
    expect(row.status).toBe("pending");
    expect(row.assetId).toBe(assetId);
  });
});

// ---------------------------------------------------------------------------
// Test 9 — the fill result is an ordinary ExtractedAsset.
// ---------------------------------------------------------------------------

describe("runSurfaceFill — the result is an ordinary asset (Test 9, SC-05)", () => {
  it("tweakable, retirable (retire -> gap), and never a token source", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);
    await createSurfaceCore(tmpDir, config).setManifest([makeSlot("icon.restaurant", "icon")]);

    const directionVersionPath = path.join(
      directionDirOf("direction-a"),
      "versions",
      VERSION_ID,
      "direction-version.json",
    );
    const before = await fs.readFile(directionVersionPath);

    const fillResult = await runSurfaceFill({ cwd: tmpDir });
    const assetId = fillResult.filled[0].assetId;

    // (a) tweak survives, slotId linkage preserved.
    const regen = await runAssetRegenerate({
      cwd: tmpDir,
      directionId: "direction-a",
      assetId,
      tweak: "face left",
    });
    expect(regen.versionId).not.toBe(fillResult.filled[0].versionId);
    const indexAfterRegen = await readAssetIndex(directionDirOf("direction-a"), assetId);
    expect(indexAfterRegen.slotId).toBe("icon.restaurant");
    expect(indexAfterRegen.versions).toHaveLength(2);

    // (b) retire -> next bind reports the slot a gap again.
    await retireExtractedAsset(directionDirOf("direction-a"), assetId);
    const bindAfterRetire = await runSurfaceBind({ cwd: tmpDir });
    const row = bindAfterRetire.binding.slots.find((s) => s.slotId === "icon.restaurant")!;
    expect(row.status).toBe("gap");

    // (c) no token artifacts: the direction version record is byte-untouched.
    const after = await fs.readFile(directionVersionPath);
    expect(after.equals(before)).toBe(true);
    await expect(fs.access(config.outputs.cssVars)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 10 — fill extracts against the pinned approved version.
// ---------------------------------------------------------------------------

describe("runSurfaceFill — extracts against the pinned approved version (Test 10)", () => {
  it("uses the approved v1, not a later head", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);

    const v2 = makeDirectionVersion(FIXTURE_TOKENS, {
      id: "2026-08-06T00-00-00-000Z",
      name: "Direction A v2",
    });
    await writeDirectionVersionFile(config, "direction-a", v2);

    await createSurfaceCore(tmpDir, config).setManifest([makeSlot("icon.restaurant", "icon")]);
    const fillResult = await runSurfaceFill({ cwd: tmpDir });
    const f = fillResult.filled[0];

    const versionRecordPath = path.join(
      directionDirOf("direction-a"),
      "extracted-assets",
      f.assetId,
      "versions",
      f.versionId,
      "asset-version.json",
    );
    const versionRecord = JSON.parse(await fs.readFile(versionRecordPath, "utf-8"));
    expect(versionRecord.source.versionId).toBe(VERSION_ID);
    expect(versionRecord.source.versionId).not.toBe(v2.id);
  });
});

// ---------------------------------------------------------------------------
// Test 11 — the concept-mismatch guard (`--concept`) was removed wholesale in
// WS-01 (direction-aggregate-root): fill always targets the approved
// pointer's direction, and `runSurfaceFill` no longer accepts a `concept`
// option to guard against. There is nothing left to test here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test 12 — no manifest / no pointer inherit WS-03's teaching errors.
// ---------------------------------------------------------------------------

describe("runSurfaceFill — inherits gatherBindInputs' teaching errors (Test 12)", () => {
  it("no manifest names surface schema/set", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedApprovedDirection(config);

    await expect(runSurfaceFill({ cwd: tmpDir })).rejects.toThrow(/surface schema/);
    await expect(runSurfaceFill({ cwd: tmpDir })).rejects.toThrow(/surface set/);
  });

  it("no approved pointer names keyart approve", async () => {
    const config = mockConfig();
    await useConfig(config);
    await createSurfaceCore(tmpDir, config).setManifest([
      makeSlot("color.background", "color-role"),
    ]);

    await expect(runSurfaceFill({ cwd: tmpDir })).rejects.toThrow(/keyart approve/);
  });
});
