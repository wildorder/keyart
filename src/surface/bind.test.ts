import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { DirectionVersion, DirectionTokens, KeyartConfig } from "../types.js";
import { CommandError } from "../errors.js";
import { resolveBrandVars, renderBrandCss } from "../approve/render-guides.js";
import { contrastRatio } from "../brand/palette.js";
import type { ExtractedAssetIndex, AssetSource, AssetVersion } from "../asset/schema.js";
import type { SurfaceManifest, SurfaceSlot, SlotKind } from "./schema.js";
import {
  resolveSlots,
  buildGapReport,
  runSurfaceBind,
  type PackManifestLike,
} from "./bind.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { createSurfaceCore } from "./store.js";
import { appendVersionToIndex as appendAssetVersion } from "../asset/asset-store.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

const NOW = "2026-08-05T00:00:00.000Z";
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

/** A token set where the very first candidate (a brand primitive) already
 * passes AA against the background — proves the derivation is a verbatim
 * candidate scan, not a synthesized color. */
const PASS_TOKENS: DirectionTokens = {
  palette: [
    { role: "primary", name: "P", hex: "#334455" },
    { role: "secondary", name: "S", hex: "#556677" },
    { role: "background", name: "Bg", hex: "#ffffff" },
    { role: "surface", name: "Sf", hex: "#f5f5f5" },
    { role: "text", name: "Tx", hex: "#111111" },
    { role: "muted", name: "Mu", hex: "#666666" },
  ],
  brand: [{ hex: "#000000", name: "black" }],
  typography: { heading: "Inter", body: "Inter" },
  shape: { radius: "8px", spacingUnit: "8px" },
};

/** A token set where every candidate is a near-identical mid-gray to the
 * `sitsOn` ground, so none passes AA and the ensureContrastAA fallback engages. */
const FAIL_TOKENS: DirectionTokens = {
  palette: [
    { role: "primary", name: "P", hex: "#787878" },
    { role: "secondary", name: "S", hex: "#7c7c7c" },
    { role: "background", name: "Bg", hex: "#828282" },
    { role: "surface", name: "Sf", hex: "#808080" },
    { role: "text", name: "Tx", hex: "#7e7e7e" },
    { role: "muted", name: "Mu", hex: "#818181" },
  ],
  brand: [{ hex: "#797979", name: "gray" }],
  typography: { heading: "Inter", body: "Inter" },
  shape: { radius: "8px", spacingUnit: "8px" },
};

function makeManifest(slots: SurfaceSlot[]): SurfaceManifest {
  return { version: 1, updatedAt: NOW, slots };
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

function makeDirectionVersion(
  tokens: DirectionTokens,
  overrides: Partial<DirectionVersion> = {},
): DirectionVersion {
  return {
    id: "v1",
    createdAt: NOW,
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

function makeAssetIndex(
  id: string,
  overrides: Partial<ExtractedAssetIndex> = {},
): ExtractedAssetIndex {
  return {
    id,
    name: id,
    directionId: "direction-a",
    versions: ["v1"],
    head: "v1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure resolveSlots/buildGapReport — no fs, no config.
// ---------------------------------------------------------------------------

describe("resolveSlots — purity (Test 1)", () => {
  it("same input -> same output, inputs unmutated; null packManifest tolerated", () => {
    const manifest = makeManifest([
      makeSlot("color.background", "color-role"),
      makeSlot("icon.restaurant", "icon"),
    ]);
    const direction = makeDirectionVersion(FIXTURE_TOKENS);
    const assets = [makeAssetIndex("restaurant", { slotId: "icon.restaurant" })];
    const packManifest: PackManifestLike = {
      packDir: "brand/generated/asset-pack/direction-a",
      assets: [{ id: "restaurant", headVersionId: "v1", pending: false, file: "restaurant.png" }],
    };

    const manifestSnapshot = JSON.parse(JSON.stringify(manifest));
    const directionSnapshot = JSON.parse(JSON.stringify(direction));
    const assetsSnapshot = JSON.parse(JSON.stringify(assets));
    const packSnapshot = JSON.parse(JSON.stringify(packManifest));

    const first = resolveSlots({ manifest, direction, packManifest, assets });
    const second = resolveSlots({ manifest, direction, packManifest, assets });
    expect(second).toEqual(first);

    expect(manifest).toEqual(manifestSnapshot);
    expect(direction).toEqual(directionSnapshot);
    expect(assets).toEqual(assetsSnapshot);
    expect(packManifest).toEqual(packSnapshot);

    const third = resolveSlots({ manifest, direction, packManifest: null, assets });
    expect(third.find((r) => r.slotId === "icon.restaurant")?.status).toBe("pending");
  });
});

describe("resolveSlots — token projection matches brand.css (Test 3)", () => {
  it("color-role and type-role values are byte-identical to resolveBrandVars/brand.css", () => {
    const manifest = makeManifest([
      makeSlot("color.background", "color-role"),
      makeSlot("type.heading", "type-role"),
      makeSlot("type.caption", "type-role"),
    ]);
    const direction = makeDirectionVersion(FIXTURE_TOKENS);
    const vars = resolveBrandVars(direction);
    const css = renderBrandCss(direction);

    const resolved = resolveSlots({ manifest, direction, packManifest: null, assets: [] });

    const bg = resolved.find((r) => r.slotId === "color.background")!;
    expect(bg.status).toBe("bound");
    expect(bg.derived).toBeUndefined();
    expect(bg.value).toBe(vars.background);
    expect(css).toContain(vars.background);

    const heading = resolved.find((r) => r.slotId === "type.heading")!;
    expect(heading.status).toBe("bound");
    expect(heading.value).toBe(vars.fontHeading);
    expect(css).toContain(vars.fontHeading);

    const caption = resolved.find((r) => r.slotId === "type.caption")!;
    expect(caption.status).toBe("bound");
    expect(caption.value).toBe(vars.fontBody);
    expect(css).toContain(vars.fontBody);
  });
});

describe("resolveSlots — derived color role (Test 4)", () => {
  it("derives a WCAG-AA color against sitsOn, marked derived; a passing brand primitive wins verbatim", () => {
    const manifest = makeManifest([
      makeSlot("color.success", "color-role", { context: { sitsOn: "background" } }),
    ]);
    const direction = makeDirectionVersion(PASS_TOKENS);
    const vars = resolveBrandVars(direction);

    const resolved = resolveSlots({ manifest, direction, packManifest: null, assets: [] });
    const row = resolved[0];
    expect(row.status).toBe("derived");
    expect(row.derived).toBe(true);
    expect(contrastRatio(row.value!, vars.background)).toBeGreaterThanOrEqual(4.5);
    expect(row.value).toBe("#000000"); // the brand primitive, verbatim — not synthesized

    const resolved2 = resolveSlots({ manifest, direction, packManifest: null, assets: [] });
    expect(resolved2[0].value).toBe(row.value);
  });
});

describe("resolveSlots — derivation fallback (Test 5)", () => {
  it("walks to AA via ensureContrastAA when no candidate already passes", () => {
    const manifest = makeManifest([
      makeSlot("color.fail-role", "color-role", { context: { sitsOn: "surface" } }),
    ]);
    const direction = makeDirectionVersion(FAIL_TOKENS);
    const vars = resolveBrandVars(direction);

    const resolved = resolveSlots({ manifest, direction, packManifest: null, assets: [] });
    const row = resolved[0];
    expect(row.status).toBe("derived");
    expect(row.derived).toBe(true);
    expect(contrastRatio(row.value!, vars.surface)).toBeGreaterThanOrEqual(4.5);

    const resolved2 = resolveSlots({ manifest, direction, packManifest: null, assets: [] });
    expect(resolved2[0].value).toBe(row.value);
  });
});

describe("resolveSlots — asset slot matching is slotId-only (Test 6)", () => {
  it("does not bind on name; matches only via slotId", () => {
    const manifest = makeManifest([makeSlot("icon.restaurant", "icon")]);
    const direction = makeDirectionVersion(FIXTURE_TOKENS);

    const unlinked = [makeAssetIndex("restaurant")]; // no slotId
    const gapResult = resolveSlots({ manifest, direction, packManifest: null, assets: unlinked });
    expect(gapResult[0].status).toBe("gap");

    const linked = [makeAssetIndex("restaurant", { slotId: "icon.restaurant" })];
    const packManifest: PackManifestLike = {
      packDir: "brand/generated/asset-pack/direction-a",
      assets: [{ id: "restaurant", headVersionId: "v1", pending: false, file: "restaurant.png" }],
    };
    const row = resolveSlots({ manifest, direction, packManifest, assets: linked })[0];
    expect(row.status).toBe("bound");
    expect(row.assetId).toBe("restaurant");
    expect(row.assetVersionId).toBe("v1");
    expect(row.file).toBe("brand/generated/asset-pack/direction-a/restaurant.png");
  });
});

describe("resolveSlots — a retired fill drops from the next bind (Test 7)", () => {
  it("re-resolves to a gap, no error, carrying the slot's origin/attributions in the gap row", () => {
    const manifest = makeManifest([makeSlot("icon.restaurant", "icon", { origin: "request" })]);
    const direction = makeDirectionVersion(FIXTURE_TOKENS);
    const retired = [makeAssetIndex("restaurant", { slotId: "icon.restaurant", retiredAt: NOW })];

    const resolved = resolveSlots({ manifest, direction, packManifest: null, assets: retired });
    expect(resolved[0].status).toBe("gap");

    const gaps = buildGapReport(manifest, resolved);
    expect(gaps).toEqual([
      {
        slotId: "icon.restaurant",
        kind: "icon",
        criticality: "required",
        origin: "request",
        attributionCount: 0,
        description: "Description for icon.restaurant",
        taxonomyDemand: false,
      },
    ]);
  });
});

describe("resolveSlots — a retired slot drops entirely (Test 8)", () => {
  it("appears in neither slots nor gaps", () => {
    const manifest = makeManifest([
      makeSlot("color.background", "color-role", { retiredAt: NOW }),
    ]);
    const direction = makeDirectionVersion(FIXTURE_TOKENS);
    const resolved = resolveSlots({ manifest, direction, packManifest: null, assets: [] });
    expect(resolved).toEqual([]);
    expect(buildGapReport(manifest, resolved)).toEqual([]);
  });
});

describe("resolveSlots — duplicate claim (Test 9, pure half)", () => {
  it("throws CommandError naming both asset ids and the slot id", () => {
    const manifest = makeManifest([makeSlot("icon.restaurant", "icon")]);
    const direction = makeDirectionVersion(FIXTURE_TOKENS);
    const assets = [
      makeAssetIndex("restaurant", { slotId: "icon.restaurant" }),
      makeAssetIndex("restaurant-2", { slotId: "icon.restaurant" }),
    ];

    let caught: unknown;
    try {
      resolveSlots({ manifest, direction, packManifest: null, assets });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommandError);
    const message = (caught as Error).message;
    expect(message).toContain("restaurant");
    expect(message).toContain("restaurant-2");
    expect(message).toContain("icon.restaurant");
  });
});

describe("resolveSlots — pending status (Test 10)", () => {
  it("a claimed asset with no packed image resolves pending, never a gap or a fabricated file", () => {
    const manifest = makeManifest([makeSlot("icon.restaurant", "icon")]);
    const direction = makeDirectionVersion(FIXTURE_TOKENS);
    const assets = [makeAssetIndex("restaurant", { slotId: "icon.restaurant" })];
    const packManifest: PackManifestLike = {
      packDir: "pd",
      assets: [{ id: "restaurant", headVersionId: "v1", pending: true }],
    };

    const resolved = resolveSlots({ manifest, direction, packManifest, assets });
    const row = resolved[0];
    expect(row.status).toBe("pending");
    expect(row.assetId).toBe("restaurant");
    expect(row.assetVersionId).toBe("v1");
    expect(row.file).toBeUndefined();
    expect(row.svgFile).toBeUndefined();
    expect(buildGapReport(manifest, resolved)).toEqual([]);
  });
});

describe("buildGapReport — shapes (Test 11)", () => {
  it("shapes request/attribution/taxonomy-demand rows in manifest order, excluding bound/derived/pending", () => {
    const requested = makeSlot("icon.scooter", "icon", {
      origin: "request",
      attributions: [
        { author: "a", source: "cli", date: NOW },
        { author: "b", source: "mcp", date: NOW },
        { author: "c", source: "cli", date: NOW },
      ],
    });
    const other = makeSlot("other.mystery", "other", { context: { note: "unclassified" } });
    const bound = makeSlot("color.background", "color-role");
    const manifest = makeManifest([requested, other, bound]);
    const direction = makeDirectionVersion(FIXTURE_TOKENS);

    const resolved = resolveSlots({ manifest, direction, packManifest: null, assets: [] });
    const gaps = buildGapReport(manifest, resolved);

    expect(gaps.map((g) => g.slotId)).toEqual(["icon.scooter", "other.mystery"]);
    const scooter = gaps.find((g) => g.slotId === "icon.scooter")!;
    expect(scooter.attributionCount).toBe(3);
    expect(scooter.origin).toBe("request");
    expect(scooter.taxonomyDemand).toBe(false);
    const mystery = gaps.find((g) => g.slotId === "other.mystery")!;
    expect(mystery.taxonomyDemand).toBe(true);
  });
});

describe("resolveSlots — svgFile tolerance, both landing orders (Test 12)", () => {
  it("carries svgFile only when fresh; ignores unknown extra keys", () => {
    const manifest = makeManifest([makeSlot("icon.restaurant", "icon")]);
    const direction = makeDirectionVersion(FIXTURE_TOKENS);
    const assets = [makeAssetIndex("restaurant", { slotId: "icon.restaurant" })];
    const base = { id: "restaurant", headVersionId: "v1", pending: false, file: "restaurant.png" };

    const withSvg = resolveSlots({
      manifest,
      direction,
      assets,
      packManifest: { packDir: "pd", assets: [{ ...base, svgFile: "restaurant.svg" }] },
    })[0];
    expect(withSvg.file).toBe("pd/restaurant.png");
    expect(withSvg.svgFile).toBe("pd/restaurant.svg");

    const staleSvg = resolveSlots({
      manifest,
      direction,
      assets,
      packManifest: {
        packDir: "pd",
        assets: [{ ...base, svgFile: "restaurant.svg", vectorStale: true }],
      },
    })[0];
    expect(staleSvg.file).toBe("pd/restaurant.png");
    expect(staleSvg.svgFile).toBeUndefined();

    const pngOnly = resolveSlots({
      manifest,
      direction,
      assets,
      packManifest: { packDir: "pd", assets: [base] },
    })[0];
    expect(pngOnly.file).toBe("pd/restaurant.png");
    expect(pngOnly.svgFile).toBeUndefined();

    const unknownKeyIgnored = resolveSlots({
      manifest,
      direction,
      assets,
      packManifest: { packDir: "pd", assets: [{ ...base, mysteryField: "ignored" }] },
    })[0];
    expect(unknownKeyIgnored.file).toBe("pd/restaurant.png");
    expect(unknownKeyIgnored.status).toBe("bound");
  });
});

// ---------------------------------------------------------------------------
// runSurfaceBind — full fs harness (mirrors the src/asset/pack.test.ts idiom).
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-surface-bind-"));
  delete process.env.OPENAI_API_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
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

async function seedDirection(config: KeyartConfig, id: string): Promise<void> {
  await createDirectionCore(tmpDir, config).create({ id, name: id });
}

function directionDirOf(directionId: string): string {
  return path.join(tmpDir, "brand", "directions", directionId);
}

async function writeDirectionVersions(
  config: KeyartConfig,
  directionId: string,
  versions: DirectionVersion[],
): Promise<void> {
  const core = createDirectionCore(tmpDir, config);
  const versionsDir = path.join(directionDirOf(directionId), "versions");
  for (const v of versions) {
    const versionDir = path.join(versionsDir, v.id);
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(
      path.join(versionDir, "direction-version.json"),
      JSON.stringify(v),
      "utf-8",
    );
    await core.appendVersion(directionId, v.id);
  }
}

async function writeAssetFixture(
  assetId: string,
  opts: {
    name: string;
    directionId: string;
    versionId: string;
    slotId?: string;
    description?: string;
    source: AssetSource;
    withPng?: boolean;
  },
): Promise<void> {
  const directionDir = directionDirOf(opts.directionId);
  const version: AssetVersion = {
    id: opts.versionId,
    createdAt: NOW,
    description: opts.description ?? `${opts.name} description`,
    source: opts.source,
    files: opts.withPng ? ["asset.png"] : [],
  };
  await appendAssetVersion(
    directionDir,
    assetId,
    { name: opts.name, directionId: opts.directionId, slotId: opts.slotId },
    version,
  );
  if (opts.withPng) {
    const pngPath = path.join(
      directionDir,
      "extracted-assets",
      assetId,
      "versions",
      opts.versionId,
      "asset.png",
    );
    await fs.writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  }
}

const SRC_A: AssetSource = {
  directionId: "direction-a",
  versionId: VERSION_ID,
  image: "styleTile",
};

async function pathExists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

describe("runSurfaceBind — double-run byte-equality (Test 2, SC-04)", () => {
  it("writes byte-identical binding.json and asset-pack output across two runs", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedDirection(config, "direction-a");
    await writeDirectionVersions(config, "direction-a", [
      makeDirectionVersion(FIXTURE_TOKENS, { id: VERSION_ID }),
    ]);
    await writeAssetFixture("restaurant", {
      name: "Restaurant",
      directionId: "direction-a",
      versionId: "av1",
      slotId: "icon.restaurant",
      source: SRC_A,
      withPng: true,
    });
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a",
      versionId: VERSION_ID,
    });
    await createSurfaceCore(tmpDir, config).setManifest([
      makeSlot("icon.restaurant", "icon"),
      makeSlot("illustration.empty-cart", "illustration"),
      makeSlot("color.background", "color-role"),
      makeSlot("color.success", "color-role", { context: { sitsOn: "background" } }),
      makeSlot("type.heading", "type-role"),
      makeSlot("other.mystery", "other"),
    ]);

    const first = await runSurfaceBind({ cwd: tmpDir });
    const firstSnapshot = await snapshotGeneratedDir();
    const second = await runSurfaceBind({ cwd: tmpDir });
    const secondSnapshot = await snapshotGeneratedDir();

    expect(secondSnapshot).toEqual(firstSnapshot);
    expect(second.binding).toEqual(first.binding);

    async function snapshotGeneratedDir(): Promise<Record<string, string>> {
      const root = path.join(tmpDir, "brand", "generated");
      const out: Record<string, string> = {};
      async function walk(dir: string): Promise<void> {
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else {
            out[path.relative(root, full)] = (await fs.readFile(full)).toString("base64");
          }
        }
      }
      await walk(root);
      return out;
    }
  });
});

describe("runSurfaceBind — duplicate claim (Test 9, fs half)", () => {
  it("rejects naming both asset ids; binding.json is never written", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedDirection(config, "direction-a");
    await writeDirectionVersions(config, "direction-a", [
      makeDirectionVersion(FIXTURE_TOKENS, { id: VERSION_ID }),
    ]);
    await writeAssetFixture("restaurant", {
      name: "Restaurant",
      directionId: "direction-a",
      versionId: "av1",
      slotId: "icon.restaurant",
      source: SRC_A,
      withPng: true,
    });
    await writeAssetFixture("restaurant-2", {
      name: "Restaurant 2",
      directionId: "direction-a",
      versionId: "av1",
      slotId: "icon.restaurant",
      source: SRC_A,
      withPng: true,
    });
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a",
      versionId: VERSION_ID,
    });
    await createSurfaceCore(tmpDir, config).setManifest([makeSlot("icon.restaurant", "icon")]);

    await expect(runSurfaceBind({ cwd: tmpDir })).rejects.toThrow(CommandError);
    await expect(runSurfaceBind({ cwd: tmpDir })).rejects.toThrow(/restaurant.*restaurant-2/s);
    expect(await pathExists(path.join(tmpDir, "brand", "generated", "binding.json"))).toBe(
      false,
    );
  });
});

describe("runSurfaceBind — no manifest (Test 13)", () => {
  it("throws CommandError naming the resolved manifest path + both remedy verbs; writes nothing", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedDirection(config, "direction-a");
    await writeDirectionVersions(config, "direction-a", [
      makeDirectionVersion(FIXTURE_TOKENS, { id: VERSION_ID }),
    ]);
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a",
      versionId: VERSION_ID,
    });

    await expect(runSurfaceBind({ cwd: tmpDir })).rejects.toThrow(CommandError);
    await expect(runSurfaceBind({ cwd: tmpDir })).rejects.toThrow(/brand\/surface\.yaml/);
    await expect(runSurfaceBind({ cwd: tmpDir })).rejects.toThrow(/surface schema/);
    await expect(runSurfaceBind({ cwd: tmpDir })).rejects.toThrow(/surface set/);
    expect(await pathExists(path.join(tmpDir, "brand", "generated", "binding.json"))).toBe(
      false,
    );
  });
});

describe("runSurfaceBind — no approved pointer (Test 14)", () => {
  it("throws CommandError naming `keyart approve`; writes nothing", async () => {
    const config = mockConfig();
    await useConfig(config);
    await createSurfaceCore(tmpDir, config).setManifest([makeSlot("color.background", "color-role")]);

    await expect(runSurfaceBind({ cwd: tmpDir })).rejects.toThrow(CommandError);
    await expect(runSurfaceBind({ cwd: tmpDir })).rejects.toThrow(/keyart approve/);
    expect(await pathExists(path.join(tmpDir, "brand", "generated", "binding.json"))).toBe(
      false,
    );
  });
});

describe("runSurfaceBind — outputs.binding config path (Test 15)", () => {
  it("defaults to brand/generated/binding.json; a custom relative path is honored", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedDirection(config, "direction-a");
    await writeDirectionVersions(config, "direction-a", [
      makeDirectionVersion(FIXTURE_TOKENS, { id: VERSION_ID }),
    ]);
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a",
      versionId: VERSION_ID,
    });
    await createSurfaceCore(tmpDir, config).setManifest([makeSlot("color.background", "color-role")]);

    const defaultResult = await runSurfaceBind({ cwd: tmpDir });
    expect(defaultResult.bindingPath).toBe("brand/generated/binding.json");
    expect(
      await pathExists(path.join(tmpDir, "brand", "generated", "binding.json")),
    ).toBe(true);

    const customConfig = mockConfig();
    customConfig.outputs.binding = "custom/out/binding.json";
    await useConfig(customConfig);

    const customResult = await runSurfaceBind({ cwd: tmpDir });
    expect(customResult.bindingPath).toBe("custom/out/binding.json");
    expect(await pathExists(path.join(tmpDir, "custom", "out", "binding.json"))).toBe(true);
  });
});

describe("runSurfaceBind — refreshes the pack (Test 16)", () => {
  it("resolves a fill minted after the first bind, with no manual `asset pack` step", async () => {
    const config = mockConfig();
    await useConfig(config);
    await seedDirection(config, "direction-a");
    await writeDirectionVersions(config, "direction-a", [
      makeDirectionVersion(FIXTURE_TOKENS, { id: VERSION_ID }),
    ]);
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a",
      versionId: VERSION_ID,
    });
    await createSurfaceCore(tmpDir, config).setManifest([makeSlot("icon.restaurant", "icon")]);

    const first = await runSurfaceBind({ cwd: tmpDir });
    expect(first.binding.slots[0].status).toBe("gap");

    await writeAssetFixture("restaurant", {
      name: "Restaurant",
      directionId: "direction-a",
      versionId: "av1",
      slotId: "icon.restaurant",
      source: SRC_A,
      withPng: true,
    });

    const second = await runSurfaceBind({ cwd: tmpDir });
    expect(second.binding.slots[0].status).toBe("bound");
    expect(second.binding.slots[0].file).toBe(
      "brand/generated/asset-pack/direction-a/restaurant.png",
    );
  });
});
