import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";

// Mock loadConfig (tmp project) AND openai. Every other export keeps its real
// implementation — the openai fns default to `actual` (genuine dry-run without
// a key). Mirrors asset-extraction-pipeline.test.ts.
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
    classifySurfaceCandidates: vi.fn(actual.classifySurfaceCandidates),
  };
});

import { runExplore } from "../commands/explore.js";
import { runApprove } from "../commands/approve.js";
import { createDirectionCore } from "../direction/core.js";
import { dispatchCommand } from "../mcp/registry.js";
import { directionsRoot } from "../config.js";
import { hasApiKey, generateImage, classifySurfaceCandidates } from "../openai.js";
import { createSurfaceCore } from "../surface/store.js";
import { runSurfaceBind } from "../surface/bind.js";
import { runSurfaceFill } from "../surface/fill.js";
import { runSurfaceRefine } from "../surface/refine.js";
import { candidateToSlot, type ScanCandidate, type ScanProposal } from "../surface/scan.js";
import type { SurfaceSlot, SurfaceManifest } from "../surface/schema.js";
import { readAssetIndex } from "../asset/asset-store.js";
import { loadDashboardData } from "../ui/api.js";

// ── Config ────────────────────────────────────────────────────────────────────
// Deliberately carries NO `brand.surface` / `outputs.binding` keys — both are
// additive optional config paths with defaults, so this config (written before
// they existed) loads and resolves unchanged.
function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Surface Pipeline ITest", type: "prototype", framework: "next" },
    brand: {
      root: path.join(cwd, "brand"),
      references: path.join(cwd, "brand", "input", "references"),
      approved: path.join(cwd, "brand", "approved"),
      rejected: path.join(cwd, "brand", "rejected"),
    },
    models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
    outputs: {
      cursorRules: path.join(cwd, ".cursor", "rules", "keyart-brand.mdc"),
      cssVars: path.join(cwd, "brand", "generated", "brand.css"),
      implementationBrief: path.join(cwd, "brand", "generated", "implementation-brief.md"),
    },
  };
}

// ── Path helpers ──────────────────────────────────────────────────────────────
function directionDirOf(cwd: string, directionId: string): string {
  return path.join(directionsRoot(cwd, buildTestConfig(cwd)), directionId);
}

function bindingPathOf(cwd: string): string {
  return path.join(cwd, "brand", "generated", "binding.json");
}

function surfaceManifestPathOf(cwd: string): string {
  return path.join(cwd, "brand", "surface.yaml");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readBinding(cwd: string): Promise<{
  pointer: { directionId: string; versionId: string; approvedAt: string };
  slots: {
    slotId: string;
    kind: string;
    status: string;
    value?: string;
    derived?: true;
    file?: string;
    svgFile?: string;
    assetId?: string;
    assetVersionId?: string;
  }[];
}> {
  return JSON.parse(await fs.readFile(bindingPathOf(cwd), "utf-8"));
}

// ── Fixture slots ─────────────────────────────────────────────────────────────
// icon.mascot: an asset slot never seeded with an asset — stays a gap until
// filled. color.rating-star: a color-role NOT one of the six semantic roles,
// so bind always DERIVES it. pattern.hero-texture: kind "other" — always a
// gap, surfaced as taxonomy demand.
const ICON_MASCOT_SLOT: SurfaceSlot = {
  id: "icon.mascot",
  kind: "icon",
  description: "the brand mascot icon",
  criticality: "required",
  origin: "authored",
  attributions: [],
  context: { sitsOn: "surface", sizes: [32] },
};
const COLOR_RATING_STAR_SLOT: SurfaceSlot = {
  id: "color.rating-star",
  kind: "color-role",
  description: "star rating color",
  criticality: "preferred",
  origin: "authored",
  attributions: [],
  context: { sitsOn: "surface" },
};
const PATTERN_HERO_TEXTURE_SLOT: SurfaceSlot = {
  id: "pattern.hero-texture",
  kind: "other",
  description: "tiling background texture",
  criticality: "preferred",
  origin: "authored",
  attributions: [],
  context: { note: "tiling background texture" },
};
const BASE_SLOTS: SurfaceSlot[] = [
  ICON_MASCOT_SLOT,
  COLOR_RATING_STAR_SLOT,
  PATTERN_HERO_TEXTURE_SLOT,
];

/** Seeds the base manifest via the MCP `surface set` verb (keyless). */
async function seedManifest(cwd: string, slots: SurfaceSlot[] = BASE_SLOTS): Promise<void> {
  const res = await dispatchCommand(
    { command: "surface", input: ["set", JSON.stringify(slots)] },
    { defaultCwd: cwd },
  );
  if (res.isError) {
    throw new Error(`seedManifest failed: ${res.text}`);
  }
}

/** Scripts a keyed image generation writing a real (tiny) PNG to disk — the
 *  asset-extraction-pipeline `mockKeyedGeneration` idiom. */
function mockKeyedGeneration(): void {
  process.env.OPENAI_API_KEY = "test-key";
  vi.mocked(hasApiKey).mockReturnValue(true);
  vi.mocked(generateImage).mockImplementation(async (opts) => {
    await fs.mkdir(path.dirname(opts.outPath), { recursive: true });
    await fs.writeFile(opts.outPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
    return { written: true, dryRun: false };
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
let tmpDir: string;
let savedKey: string | undefined;
let dirA: string;
let dirB: string;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-surfacex-"));
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

  const actualOpenai = await vi.importActual<typeof import("../openai.js")>("../openai.js");
  vi.mocked(hasApiKey).mockImplementation(actualOpenai.hasApiKey);
  vi.mocked(generateImage).mockImplementation(actualOpenai.generateImage);
  vi.mocked(classifySurfaceCandidates).mockImplementation(actualOpenai.classifySurfaceCandidates);

  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  // Two seed directions: alpha (the focus) and echo (the isolation witness).
  const directionCore = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
  await directionCore.create({ id: "alpha", name: "Alpha" });
  await directionCore.create({ id: "echo", name: "Echo" });
  const briefPath = path.join(directionsRoot(tmpDir, buildTestConfig(tmpDir)), "alpha", "brief.md");
  await fs.writeFile(briefPath, "Alpha is a precision fintech analytics dashboard.", "utf-8");

  // Dry-run divergent explore mints two directions from alpha: dirA (focus) + dirB (rebrand target).
  const exploreRun = await runExplore({ cwd: tmpDir, from: "alpha", count: 2 });
  expect(exploreRun.dryRun).toBe(true);
  expect(exploreRun.directionIds).toHaveLength(2);
  dirA = exploreRun.directionIds[0];
  dirB = exploreRun.directionIds[1];
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function logText(): string {
  return logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
}

describe("surface-manifest pipeline (end-to-end, network-free / key-free, SC-13)", () => {
  it("schema publish via MCP, keylessly (step 1)", async () => {
    const res = await dispatchCommand({ command: "surface", input: ["schema"] }, { defaultCwd: tmpDir });
    expect(res.isError).toBe(false);
    for (const kind of ["icon", "illustration", "color-role", "type-role", "other"]) {
      expect(res.text).toContain(`### ${kind}`);
    }
    expect(res.text).toContain("## Taxonomy");
    expect(res.text).toContain("No manifest exists yet.");
  });

  it("host-agent manifest write via MCP → teaching rejection on a bad kind (steps 2-3)", async () => {
    await seedManifest(tmpDir);

    const manifest = await createSurfaceCore(tmpDir, buildTestConfig(tmpDir)).read();
    expect(manifest?.slots.map((s) => s.id)).toEqual([
      "icon.mascot",
      "color.rating-star",
      "pattern.hero-texture",
    ]);

    const before = await fs.readFile(surfaceManifestPathOf(tmpDir), "utf-8");

    const badPatch = [{ ...ICON_MASCOT_SLOT, kind: "graphic" }];
    const patchRes = await dispatchCommand(
      { command: "surface", input: ["patch", JSON.stringify(badPatch)] },
      { defaultCwd: tmpDir },
    );
    expect(patchRes.isError).toBe(true);
    expect(patchRes.text).toContain("valid kinds");
    expect(patchRes.text).toContain("icon");

    const after = await fs.readFile(surfaceManifestPathOf(tmpDir), "utf-8");
    expect(after).toBe(before); // byte-unchanged on rejection
  });

  it("bind with gaps + double-run byte-equality (step 4)", async () => {
    await seedManifest(tmpDir);
    const approveResult = await runApprove({ cwd: tmpDir, directionId: dirA });
    expect(approveResult.surface).toBeDefined();
    expect(approveResult.filesWritten).toContain("brand/generated/binding.json");

    const binding = await readBinding(tmpDir);
    const byId = Object.fromEntries(binding.slots.map((s) => [s.slotId, s]));

    // color.rating-star isn't one of the six semantic roles ⇒ always DERIVED,
    // and its hex is byte-identical to the hex printed in brand.css.
    const brandCss = await fs.readFile(path.join(tmpDir, "brand", "generated", "brand.css"), "utf-8");
    expect(byId["color.rating-star"].status).toBe("derived");
    expect(byId["color.rating-star"].derived).toBe(true);
    expect(byId["color.rating-star"].value).toBeTruthy();
    expect(brandCss).toContain(byId["color.rating-star"].value!);

    // icon.mascot has no active asset ⇒ gap. pattern.hero-texture is kind
    // "other" ⇒ always a gap, flagged as taxonomy demand.
    expect(byId["icon.mascot"].status).toBe("gap");
    expect(byId["pattern.hero-texture"].status).toBe("gap");

    const logs = logText();
    expect(logs).toContain("Surface gaps");
    expect(logs).toContain("icon.mascot");
    expect(logs).toContain("taxonomy demand");
    expect(logs).toContain("pattern.hero-texture");

    // Double-run byte-equality: the stamps reuse the pointer's approvedAt,
    // never now() — re-binding directly reproduces the SAME bytes.
    const before = await fs.readFile(bindingPathOf(tmpDir));
    await runSurfaceBind({ cwd: tmpDir });
    const after = await fs.readFile(bindingPathOf(tmpDir));
    expect(after.equals(before)).toBe(true);
  });

  it("dry-run fill is honest pending (step 5)", async () => {
    await seedManifest(tmpDir);
    await runApprove({ cwd: tmpDir, directionId: dirA });

    const fillResult = await runSurfaceFill({ cwd: tmpDir, slot: "icon.mascot" });
    expect(fillResult.dryRun).toBe(true);
    const mascotFill = fillResult.filled.find((f) => f.slotId === "icon.mascot");
    expect(mascotFill).toBeDefined();
    expect(mascotFill!.dryRun).toBe(true);

    const directionDir = directionDirOf(tmpDir, dirA);
    const index = await readAssetIndex(directionDir, mascotFill!.assetId);
    expect(index.slotId).toBe("icon.mascot");
    const versionDir = path.join(
      directionDir,
      "extracted-assets",
      mascotFill!.assetId,
      "versions",
      mascotFill!.versionId,
    );
    expect(await pathExists(path.join(versionDir, "asset.png"))).toBe(false); // no fabrication

    const bind2 = await runSurfaceBind({ cwd: tmpDir });
    const row = bind2.binding.slots.find((s) => s.slotId === "icon.mascot");
    expect(row?.status).toBe("pending");
  });

  it("mocked-model fill → re-bind resolves (steps 6-7)", async () => {
    await seedManifest(tmpDir);
    await runApprove({ cwd: tmpDir, directionId: dirA });

    mockKeyedGeneration();
    const fillResult = await runSurfaceFill({ cwd: tmpDir, slot: "icon.mascot" });
    expect(fillResult.dryRun).toBe(false);
    const mascotFill = fillResult.filled[0];
    expect(mascotFill.dryRun).toBe(false);

    const index = await readAssetIndex(directionDirOf(tmpDir, dirA), mascotFill.assetId);
    expect(index.slotId).toBe("icon.mascot");
    const headPngPath = path.join(
      directionDirOf(tmpDir, dirA),
      "extracted-assets",
      mascotFill.assetId,
      "versions",
      mascotFill.versionId,
      "asset.png",
    );
    expect(await pathExists(headPngPath)).toBe(true);

    // runSurfaceBind refreshes the pack itself (gatherBindInputs) before resolving.
    const bind2 = await runSurfaceBind({ cwd: tmpDir });
    const row = bind2.binding.slots.find((s) => s.slotId === "icon.mascot");
    expect(row?.status).toBe("bound");
    expect(row?.file).toMatch(/icon-mascot\.png$/);
    expect(row?.assetId).toBe(mascotFill.assetId);
    expect(row?.assetVersionId).toBeTruthy();
  });

  it("`surface request` via MCP lands attributed + dedupes (step 8)", async () => {
    await seedManifest(tmpDir);
    await runApprove({ cwd: tmpDir, directionId: dirA });

    const requestPayload = {
      id: "icon.scooter",
      kind: "icon",
      description: "delivery scooter marker",
      criticality: "preferred",
      context: { sitsOn: "surface", usedIn: ["order-tracking"] },
    };

    const req1 = await dispatchCommand(
      { command: "surface", input: ["request", JSON.stringify(requestPayload)] },
      { defaultCwd: tmpDir },
    );
    expect(req1.isError).toBe(false);

    let manifest = await createSurfaceCore(tmpDir, buildTestConfig(tmpDir)).read();
    let scooter = manifest?.slots.filter((s) => s.id === "icon.scooter") ?? [];
    expect(scooter).toHaveLength(1);
    expect(scooter[0].origin).toBe("request");
    expect(scooter[0].attributions).toHaveLength(1);
    expect(scooter[0].attributions[0]).toMatchObject({ author: "agent", source: "cli" });

    // Re-requesting the SAME id dedupes — appends an attribution, not a slot.
    const req2 = await dispatchCommand(
      { command: "surface", input: ["request", JSON.stringify(requestPayload)] },
      { defaultCwd: tmpDir },
    );
    expect(req2.isError).toBe(false);

    manifest = await createSurfaceCore(tmpDir, buildTestConfig(tmpDir)).read();
    scooter = manifest?.slots.filter((s) => s.id === "icon.scooter") ?? [];
    expect(scooter).toHaveLength(1);
    expect(scooter[0].attributions).toHaveLength(2);

    const bind = await runSurfaceBind({ cwd: tmpDir });
    const gap = bind.gaps.find((g) => g.slotId === "icon.scooter");
    expect(gap).toBeDefined();
    expect(gap!.attributionCount).toBe(2);
  });

  it("mocked refine enriches the proposal without applying (step 9)", async () => {
    const scanDir = path.join(tmpDir, "brand", "generated", "surface-scan");
    const cropsDir = path.join(scanDir, "crops");
    await fs.mkdir(cropsDir, { recursive: true });
    const cropFile = "brand/generated/surface-scan/crops/abc123signature.png";
    await fs.writeFile(path.join(tmpDir, cropFile), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const proposal: ScanProposal = {
      createdAt: "2026-01-01T00:00:00.000Z",
      urls: ["http://localhost:3000"],
      candidates: [
        {
          signature: "abc123signature",
          kind: "icon",
          proposedId: "icon.unnamed-1",
          cropFile,
          hints: {},
        },
      ],
      rejectedSignatures: [],
      migrations: [],
      skipped: [],
    };
    await fs.writeFile(path.join(scanDir, "proposal.json"), JSON.stringify(proposal), "utf-8");

    const surfaceYamlPath = surfaceManifestPathOf(tmpDir);
    const before = (await pathExists(surfaceYamlPath))
      ? await fs.readFile(surfaceYamlPath, "utf-8")
      : null;

    process.env.OPENAI_API_KEY = "test-key";
    vi.mocked(hasApiKey).mockReturnValue(true);
    vi.mocked(classifySurfaceCandidates).mockResolvedValue({
      candidates: [
        {
          signature: "abc123signature",
          suggestedId: "icon.restaurant",
          kind: "icon",
          description: "Fork-and-knife glyph",
        },
      ],
      dryRun: false,
    });

    const result = await runSurfaceRefine({ cwd: tmpDir });
    expect(result.dryRun).toBe(false);
    expect(result.refinedCount).toBe(1);

    const refreshed = JSON.parse(
      await fs.readFile(path.join(scanDir, "proposal.json"), "utf-8"),
    ) as ScanProposal;
    const candidate = refreshed.candidates[0];
    expect(candidate.proposedId).toBe("icon.restaurant");
    expect(candidate.kind).toBe("icon");
    expect(candidate.refined).toMatchObject({ proposedId: true, kind: true, description: true });

    // Refinement upgrades the PROPOSAL only — the manifest is byte-unchanged
    // (never applied).
    const after = (await pathExists(surfaceYamlPath))
      ? await fs.readFile(surfaceYamlPath, "utf-8")
      : null;
    expect(after).toBe(before);
  });

  it("approve codifies bindings + protocol into the guides (step 10)", async () => {
    await seedManifest(tmpDir);
    await runApprove({ cwd: tmpDir, directionId: dirA });

    mockKeyedGeneration();
    await runSurfaceFill({ cwd: tmpDir, slot: "icon.mascot" });
    delete process.env.OPENAI_API_KEY;

    const requestPayload = {
      id: "icon.scooter",
      kind: "icon",
      description: "delivery scooter marker",
      criticality: "preferred",
    };
    await dispatchCommand(
      { command: "surface", input: ["request", JSON.stringify(requestPayload)] },
      { defaultCwd: tmpDir },
    );
    await dispatchCommand(
      { command: "surface", input: ["request", JSON.stringify(requestPayload)] },
      { defaultCwd: tmpDir },
    );

    await runApprove({ cwd: tmpDir, directionId: dirA });

    const brief = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "implementation-brief.md"),
      "utf-8",
    );
    const cursor = await fs.readFile(
      path.join(tmpDir, ".cursor", "rules", "keyart-brand.mdc"),
      "utf-8",
    );
    for (const doc of [brief, cursor]) {
      expect(doc).toContain("## Surface Bindings (slot → value)");
      expect(doc).toContain("`icon.mascot`");
      expect(doc).toContain("icon-mascot.png");
      expect(doc).toMatch(/icon\.scooter.*requested 2×/);
      expect(doc).toContain('other (taxonomy demand): "tiling background texture"');
      expect(doc).toContain("## Surface Requests (when a brand element is missing)");
      expect(doc).toContain(
        'keyart_brand { command: "surface", input: ["request", "<json>"] }',
      );
    }
  });

  it("repoint/re-approve re-binds against the new direction — the rebrand property (SC-09, step 11)", async () => {
    await seedManifest(tmpDir);
    await runApprove({ cwd: tmpDir, directionId: dirA });

    mockKeyedGeneration();
    await runSurfaceFill({ cwd: tmpDir, slot: "icon.mascot" });
    delete process.env.OPENAI_API_KEY;

    const requestPayload = {
      id: "icon.scooter",
      kind: "icon",
      description: "delivery scooter marker",
      criticality: "preferred",
    };
    await dispatchCommand(
      { command: "surface", input: ["request", JSON.stringify(requestPayload)] },
      { defaultCwd: tmpDir },
    );

    const bindBefore = await runSurfaceBind({ cwd: tmpDir });
    expect(bindBefore.binding.slots.find((s) => s.slotId === "icon.mascot")?.status).toBe("bound");

    // Repoint + re-approve onto dirB — the rebrand.
    await runApprove({ cwd: tmpDir, directionId: dirB });

    const binding = await readBinding(tmpDir);
    expect(binding.pointer.directionId).toBe(dirB);

    const brandCssB = await fs.readFile(path.join(tmpDir, "brand", "generated", "brand.css"), "utf-8");
    const ratingRow = binding.slots.find((s) => s.slotId === "color.rating-star");
    expect(ratingRow?.value).toBeTruthy();
    expect(brandCssB).toContain(ratingRow!.value!);

    // dirA's fill is direction-scoped — it does NOT bind against dirB.
    const mascotRow = binding.slots.find((s) => s.slotId === "icon.mascot");
    expect(mascotRow?.status).toBe("gap");

    const bindAgain = await runSurfaceBind({ cwd: tmpDir });
    const gapNames = bindAgain.gaps.map((g) => g.slotId);
    expect(gapNames).toContain("icon.mascot");

    // The request slot's attributions survive the rebrand untouched.
    const manifest = await createSurfaceCore(tmpDir, buildTestConfig(tmpDir)).read();
    const scooter = manifest?.slots.find((s) => s.id === "icon.scooter");
    expect(scooter?.attributions).toHaveLength(1);
  });

  it("per-direction isolation + keyless parity closers (SC-11/SC-12)", async () => {
    await seedManifest(tmpDir);
    const approveResult = await runApprove({ cwd: tmpDir, directionId: dirA });
    expect(approveResult.surface).toBeDefined();

    mockKeyedGeneration();
    const fillResult = await runSurfaceFill({ cwd: tmpDir, slot: "icon.mascot" });
    expect(fillResult.dryRun).toBe(false);
    delete process.env.OPENAI_API_KEY;

    await runSurfaceBind({ cwd: tmpDir });

    // The witness direction `echo` has no extracted-assets tree and zero memory
    // after the full alpha-focused chain above.
    const echoDirectionDir = directionDirOf(tmpDir, "echo");
    expect(await pathExists(path.join(echoDirectionDir, "extracted-assets"))).toBe(false);
    const echoCore = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    expect(await echoCore.memoryEntries("echo", { includeRetired: true })).toHaveLength(0);
    expect((await echoCore.get("echo")).assets).toHaveLength(0);

    // `brand/surface.yaml` is deliberately PROJECT-level (demand belongs to
    // the app, not a direction) — isolation here means direction trees +
    // memory, not the manifest, which is intentionally shared across directions.
    const manifest = await createSurfaceCore(tmpDir, buildTestConfig(tmpDir)).read();
    expect(manifest).not.toBeNull();

    // Every step except the one explicitly-mocked fill above ran genuinely
    // keyless.
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });
});

// ── WS-10 closeout: scan → refine → apply → bind/dashboard seam ────────────
// The seam the WS-07 proof above deliberately stopped short of. Reuses the
// same harness verbatim (config/openai mocks, buildTestConfig, alpha/echo +
// dirA/dirB scaffold, MCP dispatch). Network-free, key-free throughout.

/**
 * Replicates the SAME write path `POST /api/surface/proposal/apply` (WS-09)
 * and the CLI `surface scan --apply` flow (WS-05) are each built from:
 * `candidateToSlot` mapping accepted candidates to slots, `createSurfaceCore`'s
 * validated `patchSlots` as the ONE write, and the identical proposal rewrite
 * (candidates cleared, rejectedSignatures appended + deduped). There is no
 * single exported "apply" function shared between the two callers — each
 * inlines this exact sequence from the same two exported primitives — so this
 * helper drives those primitives directly rather than standing up an HTTP
 * harness (the envelope is owned by the serve-api suite; the CLI path needs a
 * live Playwright page, which the proposal here is deliberately synthesized
 * to avoid).
 */
async function applyProposal(
  cwd: string,
  acceptedSignatures: string[],
): Promise<{ manifest: SurfaceManifest; appliedSlotIds: string[]; rejectedCount: number }> {
  const config = buildTestConfig(cwd);
  const proposalPath = path.join(cwd, "brand", "generated", "surface-scan", "proposal.json");
  const proposal = JSON.parse(await fs.readFile(proposalPath, "utf-8")) as ScanProposal;

  const acceptedSet = new Set(acceptedSignatures);
  const accepted = proposal.candidates.filter((c) => acceptedSet.has(c.signature));
  const rejected = proposal.candidates.filter((c) => !acceptedSet.has(c.signature));

  const nowIso = new Date().toISOString();
  const slots = accepted.map((c) => candidateToSlot(c, nowIso));
  const manifest = await createSurfaceCore(cwd, config).patchSlots(slots);

  const rejectedSignatures = [
    ...proposal.rejectedSignatures,
    ...rejected.map((c) => c.signature),
  ].filter((sig, i, arr) => arr.indexOf(sig) === i);
  const nextProposal: ScanProposal = { ...proposal, candidates: [], rejectedSignatures };
  await fs.writeFile(proposalPath, JSON.stringify(nextProposal), "utf-8");

  return { manifest, appliedSlotIds: slots.map((s) => s.id), rejectedCount: rejected.length };
}

async function writeCrop(cwd: string, signature: string): Promise<string> {
  const rel = `brand/generated/surface-scan/crops/${signature}.png`;
  const abs = path.join(cwd, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  return rel;
}

async function writeProposal(cwd: string, candidates: ScanCandidate[]): Promise<void> {
  const scanDir = path.join(cwd, "brand", "generated", "surface-scan");
  await fs.mkdir(scanDir, { recursive: true });
  const proposal: ScanProposal = {
    createdAt: "2026-01-01T00:00:00.000Z",
    urls: ["http://localhost:3000"],
    candidates,
    rejectedSignatures: [],
    migrations: [],
    skipped: [],
  };
  await fs.writeFile(path.join(scanDir, "proposal.json"), JSON.stringify(proposal), "utf-8");
}

describe("surface-manifest closeout: scan → refine → apply → bind/dashboard (WS-10, SC-13 extension)", () => {
  it("refine upgrades a two-candidate floor proposal in place, never applies, and re-refine upgrades idempotently (SC-07)", async () => {
    await seedManifest(tmpDir, [ICON_MASCOT_SLOT]);

    const iconCrop = await writeCrop(tmpDir, "iconsig0000001");
    const illoCrop = await writeCrop(tmpDir, "illosig0000002");
    await writeProposal(tmpDir, [
      {
        signature: "iconsig0000001",
        kind: "icon",
        proposedId: "icon.unnamed-1",
        cropFile: iconCrop,
        hints: { ariaLabel: "Restaurant icon" },
      },
      {
        signature: "illosig0000002",
        kind: "illustration",
        proposedId: "illustration.unnamed-2",
        cropFile: illoCrop,
        hints: { alt: "Farmers market illustration" },
      },
    ]);

    const surfaceYamlPath = surfaceManifestPathOf(tmpDir);
    const before = await fs.readFile(surfaceYamlPath, "utf-8");

    process.env.OPENAI_API_KEY = "test-key";
    vi.mocked(hasApiKey).mockReturnValue(true);
    vi.mocked(classifySurfaceCandidates).mockResolvedValue({
      candidates: [
        {
          signature: "iconsig0000001",
          suggestedId: "icon.restaurant",
          kind: "icon",
          description: "Fork-and-knife glyph",
        },
        {
          signature: "illosig0000002",
          suggestedId: "illustration.hero-market",
          kind: "illustration",
          description: "Farmers market hero illustration",
        },
      ],
      dryRun: false,
    });

    const result = await runSurfaceRefine({ cwd: tmpDir });
    expect(result.dryRun).toBe(false);
    expect(result.refinedCount).toBe(2);

    const scanDir = path.join(tmpDir, "brand", "generated", "surface-scan");
    let refreshed = JSON.parse(
      await fs.readFile(path.join(scanDir, "proposal.json"), "utf-8"),
    ) as ScanProposal;
    expect(refreshed.candidates).toHaveLength(2);
    const icon = refreshed.candidates.find((c) => c.signature === "iconsig0000001")!;
    const illo = refreshed.candidates.find((c) => c.signature === "illosig0000002")!;
    expect(icon.proposedId).toBe("icon.restaurant");
    expect(icon.refined).toMatchObject({ proposedId: true, kind: true, description: true });
    // The floor's raw DOM observation stays readable beside the refined fields.
    expect(icon.hints.ariaLabel).toBe("Restaurant icon");
    expect(illo.proposedId).toBe("illustration.hero-market");
    expect(illo.refined).toMatchObject({ proposedId: true, kind: true, description: true });
    expect(illo.hints.alt).toBe("Farmers market illustration");
    expect(refreshed.refinedAt).toBeTruthy();

    // Refinement upgrades the proposal ONLY — the manifest is byte-unchanged.
    const after = await fs.readFile(surfaceYamlPath, "utf-8");
    expect(after).toBe(before);

    // Re-running refine with an UPDATED script upgrades the SAME proposal in
    // place — no duplicate proposal, no duplicate candidates.
    vi.mocked(classifySurfaceCandidates).mockResolvedValue({
      candidates: [
        {
          signature: "iconsig0000001",
          description: "A stylized fork-and-knife glyph, rounded corners",
        },
      ],
      dryRun: false,
    });
    const result2 = await runSurfaceRefine({ cwd: tmpDir });
    expect(result2.dryRun).toBe(false);
    expect(result2.refinedCount).toBe(1);

    refreshed = JSON.parse(
      await fs.readFile(path.join(scanDir, "proposal.json"), "utf-8"),
    ) as ScanProposal;
    expect(refreshed.candidates).toHaveLength(2); // still no duplicates
    const iconAgain = refreshed.candidates.find((c) => c.signature === "iconsig0000001")!;
    expect(iconAgain.proposedId).toBe("icon.restaurant"); // untouched this round
    expect(iconAgain.description).toBe("A stylized fork-and-knife glyph, rounded corners");
  });

  it("apply merges accepted-only through the validated patchSlots write path with origin: scan; rejected signature remembered; invalid candidate teaches (SC-06)", async () => {
    await seedManifest(tmpDir, [ICON_MASCOT_SLOT]);
    const beforeManifest = await createSurfaceCore(tmpDir, buildTestConfig(tmpDir)).read();
    expect(beforeManifest?.version).toBe(1);

    await writeCrop(tmpDir, "iconsig0000001");
    await writeCrop(tmpDir, "illosig0000002");
    await writeProposal(tmpDir, [
      {
        signature: "iconsig0000001",
        kind: "icon",
        proposedId: "icon.restaurant",
        description: "Fork-and-knife glyph",
        cropFile: "brand/generated/surface-scan/crops/iconsig0000001.png",
        hints: {},
      },
      {
        signature: "illosig0000002",
        kind: "illustration",
        proposedId: "illustration.hero-market",
        description: "Farmers market hero illustration",
        cropFile: "brand/generated/surface-scan/crops/illosig0000002.png",
        hints: {},
      },
    ]);

    const { manifest, appliedSlotIds, rejectedCount } = await applyProposal(tmpDir, [
      "iconsig0000001",
    ]);
    expect(appliedSlotIds).toEqual(["icon.restaurant"]);
    expect(rejectedCount).toBe(1);
    expect(manifest.version).toBe(2); // one write through the versioned core, no direct-fs bypass

    const applied = manifest.slots.find((s) => s.id === "icon.restaurant")!;
    expect(applied.origin).toBe("scan");
    expect(applied.attributions).toHaveLength(1);
    expect(applied.attributions[0]).toMatchObject({
      author: "scan",
      source: "surface-scan:iconsig0000001",
    });

    // The pre-existing authored slot is untouched.
    expect(manifest.slots.find((s) => s.id === "icon.mascot")).toMatchObject(ICON_MASCOT_SLOT);
    // Only the accepted candidate landed — the rejected candidate never became a slot.
    expect(manifest.slots.find((s) => s.id === "illustration.hero-market")).toBeUndefined();

    const proposalAfter = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, "brand", "generated", "surface-scan", "proposal.json"),
        "utf-8",
      ),
    ) as ScanProposal;
    expect(proposalAfter.rejectedSignatures).toContain("illosig0000002");

    // A second apply of an invalid candidate (bad kind) is a teaching
    // rejection and writes nothing — the version stays at 2.
    const badCandidate = {
      signature: "badsig0000003",
      kind: "graphic",
      proposedId: "graphic.bad",
      cropFile: "brand/generated/surface-scan/crops/badsig0000003.png",
      hints: {},
    };
    const config = buildTestConfig(tmpDir);
    await expect(
      createSurfaceCore(tmpDir, config).patchSlots([
        candidateToSlot(badCandidate as unknown as ScanCandidate, new Date().toISOString()),
      ]),
    ).rejects.toThrow(/valid kinds/);
    const manifestAfterBad = await createSurfaceCore(tmpDir, config).read();
    expect(manifestAfterBad?.version).toBe(2);
  });

  it("the applied slot reaches the next bind's gap report, with origin scan (SC-13 seam, half 1)", async () => {
    await seedManifest(tmpDir, [ICON_MASCOT_SLOT]);
    await runApprove({ cwd: tmpDir, directionId: dirA });

    await writeCrop(tmpDir, "iconsig0000001");
    await writeProposal(tmpDir, [
      {
        signature: "iconsig0000001",
        kind: "icon",
        proposedId: "icon.restaurant",
        description: "Fork-and-knife glyph",
        cropFile: "brand/generated/surface-scan/crops/iconsig0000001.png",
        hints: {},
      },
    ]);
    await applyProposal(tmpDir, ["iconsig0000001"]);

    const bind = await runSurfaceBind({ cwd: tmpDir });
    const gap = bind.gaps.find((g) => g.slotId === "icon.restaurant");
    expect(gap).toBeDefined();
    expect(gap!.kind).toBe("icon");
    expect(gap!.origin).toBe("scan");

    const row = bind.binding.slots.find((s) => s.slotId === "icon.restaurant");
    expect(row?.status).toBe("gap");

    // Double-run byte-equality still holds with the scan-origin slot present.
    const before = await fs.readFile(bindingPathOf(tmpDir));
    await runSurfaceBind({ cwd: tmpDir });
    const after = await fs.readFile(bindingPathOf(tmpDir));
    expect(after.equals(before)).toBe(true);
  });

  it("the applied slot reaches the dashboard surface? read — the read never writes binding.json, the proposal rides along verbatim, and null holds when nothing exists (SC-13 seam, half 2; SC-10)", async () => {
    // Null case first: a fresh project with no manifest and no proposal.
    const fresh = await loadDashboardData(tmpDir);
    expect(fresh.surface).toBeNull();

    await seedManifest(tmpDir, [ICON_MASCOT_SLOT]);
    await runApprove({ cwd: tmpDir, directionId: dirA });

    const cropFile = await writeCrop(tmpDir, "iconsig0000001");
    await writeProposal(tmpDir, [
      {
        signature: "iconsig0000001",
        kind: "icon",
        proposedId: "icon.restaurant",
        description: "Fork-and-knife glyph",
        cropFile,
        hints: { ariaLabel: "Restaurant icon" },
        refined: { proposedId: true, kind: true, description: true },
      },
    ]);

    // Before apply: the dashboard serves the proposal VERBATIM — refined
    // flags and the crop path intact, directly /api/asset-servable.
    const beforeApply = await loadDashboardData(tmpDir);
    expect(beforeApply.surface).not.toBeNull();
    const servedCandidate = beforeApply.surface!.proposal?.candidates.find(
      (c) => c.signature === "iconsig0000001",
    );
    expect(servedCandidate).toMatchObject({
      proposedId: "icon.restaurant",
      cropFile,
      refined: { proposedId: true, kind: true, description: true },
    });

    await applyProposal(tmpDir, ["iconsig0000001"]);
    await runSurfaceBind({ cwd: tmpDir });

    const before = await fs.readFile(bindingPathOf(tmpDir));
    const dashboard = await loadDashboardData(tmpDir);
    const after = await fs.readFile(bindingPathOf(tmpDir));
    expect(after.equals(before)).toBe(true); // the read never writes binding.json

    const row = dashboard.surface!.slots.find((s) => s.id === "icon.restaurant");
    expect(row).toBeDefined();
    expect(row!.status).toBe("gap");
    expect(row!.origin).toBe("scan");
    expect(row!.attributionCount).toBe(1);
  });

  it("keyless refine degrades honestly across the seam — no throw, no fabrication (SC-07 + standing invariant)", async () => {
    await writeCrop(tmpDir, "iconsig0000009");
    await writeProposal(tmpDir, [
      {
        signature: "iconsig0000009",
        kind: "icon",
        proposedId: "icon.unnamed-1",
        cropFile: "brand/generated/surface-scan/crops/iconsig0000009.png",
        hints: {},
      },
    ]);

    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    const result = await runSurfaceRefine({ cwd: tmpDir });
    expect(result.dryRun).toBe(true);
    expect(result.refinedCount).toBe(0);

    const proposal = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, "brand", "generated", "surface-scan", "proposal.json"),
        "utf-8",
      ),
    ) as ScanProposal;
    // Floor-labeled unrefined — the anonymous id survives untouched.
    expect(proposal.candidates[0].proposedId).toBe("icon.unnamed-1");
    expect(proposal.candidates[0].refined).toBeUndefined();

    // The anonymous floor id is still legal to apply.
    const { manifest, appliedSlotIds } = await applyProposal(tmpDir, ["iconsig0000009"]);
    expect(appliedSlotIds).toEqual(["icon.unnamed-1"]);
    expect(manifest.slots.find((s) => s.id === "icon.unnamed-1")?.origin).toBe("scan");

    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("per-direction isolation closer across the full seam", async () => {
    await seedManifest(tmpDir, [ICON_MASCOT_SLOT]);
    await runApprove({ cwd: tmpDir, directionId: dirA });

    await writeCrop(tmpDir, "iconsig0000001");
    await writeProposal(tmpDir, [
      {
        signature: "iconsig0000001",
        kind: "icon",
        proposedId: "icon.restaurant",
        cropFile: "brand/generated/surface-scan/crops/iconsig0000001.png",
        hints: {},
      },
    ]);
    await applyProposal(tmpDir, ["iconsig0000001"]);
    await runSurfaceBind({ cwd: tmpDir });
    await loadDashboardData(tmpDir);

    const echoDirectionDir = directionDirOf(tmpDir, "echo");
    expect(await pathExists(path.join(echoDirectionDir, "extracted-assets"))).toBe(false);
    const echoCore = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    expect(await echoCore.memoryEntries("echo", { includeRetired: true })).toHaveLength(0);
    expect((await echoCore.get("echo")).assets).toHaveLength(0);
  });
});
