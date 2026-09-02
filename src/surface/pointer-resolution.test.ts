import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { DirectionVersion, DirectionTokens, KeyartConfig } from "../types.js";
import { CommandError } from "../errors.js";
import type { SlotKind, SurfaceSlot } from "./schema.js";
import { runSurfaceFill } from "./fill.js";
import { runSurfaceBind } from "./bind.js";
import { runApprove } from "../commands/approve.js";
import { createDirectionCore } from "../direction/core.js";
import { createSurfaceCore } from "./store.js";
import {
  appendVersionToIndex,
  setExtractedAssetSlotId,
} from "../asset/asset-store.js";
import type { AssetVersion } from "../asset/schema.js";

/**
 * WS-10 (SC-11, R-3): the DISCRIMINATING pointer-only proof for `surface
 * bind`/`fill`. Two directions share ONE project-level asset slot; only the
 * APPROVED direction's asset may resolve or fill it. Neither command takes a
 * direction argument (a draft is not a representable input — no draft guard),
 * and with nothing approved both refuse with the teaching approve-first error.
 * Network-free + key-free throughout (`hasApiKey` false — keyless fills mint
 * honest pending records, never a fabricated image).
 */

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

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
  overrides: Partial<DirectionVersion> = {},
): DirectionVersion {
  return {
    id: VERSION_ID,
    createdAt: "2026-08-05T00:00:00.000Z",
    briefSnapshot: "brief snapshot",
    contextSnapshot: "context snapshot",
    name: "Direction",
    summary: "A summary.",
    positioning: "A positioning statement.",
    character: {},
    homepageMockupPrompt: "",
    styleTilePrompt: "",
    copyExamples: { headline: "h", subheadline: "s", cta: "c" },
    usage: { rules: [], antiRules: [] },
    tokens: FIXTURE_TOKENS,
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-pointer-res-"));
  delete process.env.OPENAI_API_KEY;
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

/** Creates a direction (real DirectionCore) and seeds one version as its head. */
async function seedDirection(
  config: KeyartConfig,
  directionId: string,
): Promise<void> {
  const core = createDirectionCore(tmpDir, config);
  await core.create({ id: directionId, name: directionId });
  const version = makeDirectionVersion({ name: directionId });
  const versionDir = path.join(directionDirOf(directionId), "versions", version.id);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(
    path.join(versionDir, "direction-version.json"),
    JSON.stringify(version),
    "utf-8",
  );
  await core.appendVersion(directionId, version.id);
}

const ASSET_VERSION_ID = "2026-08-05T01-00-00-000Z";

/**
 * Seeds one extracted asset at v1 under a direction's own tree via the real
 * store, claiming `slotId`. `png: true` writes a stub head `asset.png` so a
 * pack ships it (a bound — not pending — bind row).
 */
async function seedClaimingAsset(
  directionId: string,
  assetId: string,
  slotId: string,
  opts: { png: boolean },
): Promise<void> {
  const directionDir = directionDirOf(directionId);
  const version: AssetVersion = {
    id: ASSET_VERSION_ID,
    createdAt: "2026-08-05T01:00:00.000Z",
    description: `the ${assetId} element`,
    source: { directionId, versionId: VERSION_ID, image: "styleTile" },
    files: ["asset-prompt.md", ...(opts.png ? ["asset.png"] : [])],
  };
  await appendVersionToIndex(
    directionDir,
    assetId,
    { name: assetId, directionId },
    version,
  );
  await setExtractedAssetSlotId(directionDir, assetId, slotId);
  if (opts.png) {
    await fs.writeFile(
      path.join(
        directionDir,
        "extracted-assets",
        assetId,
        "versions",
        ASSET_VERSION_ID,
        "asset.png",
      ),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
    );
  }
}

async function setMascotManifest(config: KeyartConfig): Promise<void> {
  await createSurfaceCore(tmpDir, config).setManifest([
    makeSlot("icon.mascot", "icon", {
      description: "the brand mascot icon",
    }),
  ]);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Bind — the APPROVED direction's asset wins the shared slot (SC-11, R-3).
// ---------------------------------------------------------------------------

describe("runSurfaceBind — resolves the approved direction's asset (SC-11 discriminator)", () => {
  it("two directions claim icon.mascot; bind resolves direction-a's asset id, throwing nothing", async () => {
    const config = mockConfig();
    await useConfig(config);
    await setMascotManifest(config);
    await seedDirection(config, "direction-a");
    await seedDirection(config, "direction-b");
    // BOTH directions claim the ONE project-level slot — distinct asset ids so
    // the discriminator is visible. A wrong implementation that gathered every
    // direction's assets would either bind mascot-b or throw the
    // duplicate-claim CommandError; the pointer-scoped gather does neither.
    await seedClaimingAsset("direction-a", "mascot-a", "icon.mascot", { png: true });
    await seedClaimingAsset("direction-b", "mascot-b", "icon.mascot", { png: true });

    vi.spyOn(console, "log").mockImplementation(() => {});
    await runApprove({ cwd: tmpDir, directionId: "direction-a", force: true });

    const bind = await runSurfaceBind({ cwd: tmpDir });

    // The binding's pointer names the approved direction.
    expect(bind.binding.pointer.directionId).toBe("direction-a");
    expect(bind.binding.pointer.versionId).toBe(VERSION_ID);

    const row = bind.binding.slots.find((s) => s.slotId === "icon.mascot")!;
    expect(row.assetId).toBe("mascot-a"); // NOT mascot-b — assets scoped to pointer.directionId
    expect(row.status).toBe("bound");
    expect(row.file).toMatch(/asset-pack\/direction-a\/mascot-a\.png$/);

    // binding.json on disk agrees.
    const binding = JSON.parse(
      await fs.readFile(path.join(tmpDir, "brand", "generated", "binding.json"), "utf-8"),
    );
    expect(binding.pointer.directionId).toBe("direction-a");
    expect(
      binding.slots.find((s: { slotId: string }) => s.slotId === "icon.mascot").assetId,
    ).toBe("mascot-a");
  });
});

// ---------------------------------------------------------------------------
// Fill — the APPROVED direction's slot is what fills (SC-11 discriminating fill).
// ---------------------------------------------------------------------------

describe("runSurfaceFill — fills the approved direction's slot from its pinned version (SC-11 discriminating fill)", () => {
  it("mints under direction-a's tree with direction-a@pinned provenance — never direction-b's asset", async () => {
    const config = mockConfig();
    await useConfig(config);
    await setMascotManifest(config);
    // direction-a (about to be approved) has the slot as a GAP; the
    // UN-approved direction-b claims it with an asset. A fill that silently
    // resolved direction-b's asset/version fails every assertion below.
    await seedDirection(config, "direction-a");
    await seedDirection(config, "direction-b");
    await seedClaimingAsset("direction-b", "mascot-b", "icon.mascot", { png: true });

    vi.spyOn(console, "log").mockImplementation(() => {});
    await runApprove({ cwd: tmpDir, directionId: "direction-a", force: true });

    const result = await runSurfaceFill({ cwd: tmpDir, slot: "icon.mascot" });

    expect(result.directionId).toBe("direction-a");
    expect(result.versionId).toBe(VERSION_ID); // the approved PINNED version
    expect(result.filled).toHaveLength(1);
    const filled = result.filled[0];
    expect(filled.slotId).toBe("icon.mascot");
    expect(filled.assetId).not.toBe("mascot-b");

    // The minted asset lives under the APPROVED direction's own tree.
    const mintedDir = path.join(
      directionDirOf("direction-a"),
      "extracted-assets",
      filled.assetId,
    );
    expect(await pathExists(path.join(mintedDir, "asset.json"))).toBe(true);

    // Its recorded provenance names direction-a and direction-a's PINNED
    // version — the fill targeted the approved direction, not direction-b.
    const versionRecord = JSON.parse(
      await fs.readFile(
        path.join(mintedDir, "versions", filled.versionId, "asset-version.json"),
        "utf-8",
      ),
    );
    expect(versionRecord.source.directionId).toBe("direction-a");
    expect(versionRecord.source.versionId).toBe(VERSION_ID);

    // Nothing was written under direction-b: its tree still holds exactly the
    // one pre-seeded claimant.
    const bEntries = await fs.readdir(
      path.join(directionDirOf("direction-b"), "extracted-assets"),
    );
    expect(bEntries).toEqual(["mascot-b"]);

    // The very next bind resolves the slot to the newly-minted asset
    // (pending — the fill was keyless), never to direction-b's.
    const bind = await runSurfaceBind({ cwd: tmpDir });
    const row = bind.binding.slots.find((s) => s.slotId === "icon.mascot")!;
    expect(row.status).toBe("pending");
    expect(row.assetId).toBe(filled.assetId);
    expect(row.assetId).not.toBe("mascot-b");
  });
});

// ---------------------------------------------------------------------------
// Nothing approved ⇒ the teaching approve-first error, for BOTH commands (R-3).
// ---------------------------------------------------------------------------

describe("runSurfaceBind/runSurfaceFill — nothing approved teaches approve-first (SC-11, R-3)", () => {
  it("both reject with a CommandError naming `keyart approve`, writing nothing", async () => {
    const config = mockConfig();
    await useConfig(config);
    await setMascotManifest(config);
    await seedDirection(config, "direction-a"); // exists on disk but is NOT approved

    // Neither command takes a direction argument — a draft is not a
    // representable input, so this is the pointer-anchored refusal, never a
    // draft guard.
    await expect(runSurfaceBind({ cwd: tmpDir })).rejects.toThrow(CommandError);
    await expect(runSurfaceBind({ cwd: tmpDir })).rejects.toThrow(/keyart approve/);
    await expect(
      runSurfaceFill({ cwd: tmpDir, slot: "icon.mascot" }),
    ).rejects.toThrow(CommandError);
    await expect(
      runSurfaceFill({ cwd: tmpDir, slot: "icon.mascot" }),
    ).rejects.toThrow(/keyart approve/);

    // Nothing was written: no binding.json, no extracted asset.
    expect(
      await pathExists(path.join(tmpDir, "brand", "generated", "binding.json")),
    ).toBe(false);
    expect(
      await pathExists(path.join(directionDirOf("direction-a"), "extracted-assets")),
    ).toBe(false);
  });
});
