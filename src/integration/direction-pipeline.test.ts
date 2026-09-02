import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";

// Mock loadConfig only — every other config.js export (directionsRoot,
// globalBrandPath, storeDriver, bindingOutputPath) keeps its real
// implementation so the cores resolve real on-disk paths under the tmp
// project. Deterministic, network-free, key-free (SC-14).
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

import { runDirectionNew, runDirectionFork, runRule } from "../commands/direction.js";
import { runExplore } from "../commands/explore.js";
import { runRegenerateVisuals } from "../commands/regenerate-visuals.js";
import { runApprove } from "../commands/approve.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { createSurfaceCore } from "../surface/store.js";
import { resolveDirection } from "../direction/store.js";
import { VersionConflictError } from "../store/versioned-store.js";

// Distinct, searchable fixture strings so isolation is asserted by substring.
const HARD_RULE = "Never use pure black (#000)";
const OTHER_DIRECTION_TOKEN = "zanzibar-spice-market-of-the-mind";
const LOCKED_HEX = "#12ab34";
const SEED_HEX = "#ff5722";

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Direction Pipeline ITest", type: "prototype", framework: "next" },
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
      implementationBrief: path.join(
        cwd,
        "brand",
        "generated",
        "implementation-brief.md",
      ),
    },
  };
}

// One tmp project for the WHOLE spine — the cases below are sequential stages
// of one end-to-end story, each asserting the state the previous one left.
let tmpDir: string;
let config: KeyartConfig;

// Ids threaded through the stages.
let mainId: string; // the direction the spine drives (v1 → v2 → approve)
let otherId: string; // the isolation fixture (its brief token must never bleed)
let v1Id: string;
let v2Id: string;
let v1Bytes: Buffer;
let forkId: string;
let divergentIds: string[] = [];

const core = () => createDirectionCore(tmpDir, config);
const brand = () => createBrandCore(tmpDir, config);

async function readVersionSnapshot(directionId: string, versionId: string): Promise<string> {
  const resolved = await resolveDirection(tmpDir, config, directionId);
  return fs.readFile(
    path.join(resolved.versionsDir, versionId, "context-snapshot.md"),
    "utf-8",
  );
}

/** No brief field may carry a hex or look like a color spec (sanitizer floor). */
function expectNoHexInBrief(brief: unknown): void {
  expect(JSON.stringify(brief)).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-direction-pipeline-"));
  config = buildTestConfig(tmpDir);
  // Genuinely dry-run / deterministic: no API key, no network.
  delete process.env.OPENAI_API_KEY;
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(config);
  // Silence the cores' progress logging.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterAll(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("direction pipeline (SC-14 end-to-end, no network / no key)", () => {
  it("1. `direction new` mints a draft; brief writes are versioned and a stale PATCH 409s", async () => {
    const created = await runDirectionNew({ cwd: tmpDir, name: "Warm Editorial" });
    mainId = created.directionId;
    expect(created.isDraft).toBe(true);
    // `core.create` builds the record at version 0; the store persists
    // (current ?? 0) + 1 — a fresh direction round-trips at version 1.
    expect(created.version).toBe(1);

    const record = await core().get(mainId);
    expect(record.versions).toEqual([]);
    expect(record.head).toBeNull();
    expect(record.version).toBe(1);

    // Structured brief write through the core; brief.md is the deterministic
    // projection of the record — never an authored source.
    await core().setBriefFields(mainId, {
      oneLiner: "A warm editorial identity for a slow-journalism magazine.",
      positioning: "Long-form warmth over feed-speed churn.",
    });
    const brief = await core().getBrief(mainId);
    expect(brief.oneLiner).toBe(
      "A warm editorial identity for a slow-journalism magazine.",
    );
    expect(brief.positioning).toBe("Long-form warmth over feed-speed churn.");

    const resolved = await resolveDirection(tmpDir, config, mainId);
    const briefMd = await fs.readFile(resolved.briefPath, "utf-8");
    expect(briefMd).toBe(await core().getRenderedBrief(mainId));
    expect(briefMd).toContain("slow-journalism magazine");

    // Versioned writes survived the collapse: a stale expectedVersion PATCH
    // rejects with the store's VersionConflictError (409 semantics).
    await expect(
      core().setBriefFields(
        mainId,
        { positioning: "stale write" },
        { expectedVersion: 1 },
      ),
    ).rejects.toThrow(VersionConflictError);
    // ...and wrote nothing.
    expect((await core().getBrief(mainId)).positioning).toBe(
      "Long-form warmth over feed-speed churn.",
    );
  });

  it("2. moodboard attach → explore v1 with an ISOLATED context snapshot; a second explore teaches regenerate", async () => {
    // A global hard rule recorded up front — it must reach every assembled
    // context and survive to stage 6's repoint.
    await runRule({ cwd: tmpDir, verb: "add", text: HARD_RULE, severity: "hard" });

    // A SECOND direction with a distinctive brief token — the isolation fixture.
    const other = await runDirectionNew({ cwd: tmpDir, name: "Cool Modernist" });
    otherId = other.directionId;
    await core().setBriefFields(otherId, { oneLiner: OTHER_DIRECTION_TOKEN });

    // Moodboard attach (an `inspire` AssetRef) on the main direction.
    const moodboardAbs = path.join(tmpDir, "brand", "input", "references", "mood.png");
    await fs.mkdir(path.dirname(moodboardAbs), { recursive: true });
    await fs.writeFile(moodboardAbs, "not-a-real-png");
    await core().addAsset(mainId, {
      kind: "image",
      path: "brand/input/references/mood.png",
      intent: "inspire",
      note: "warm paper texture",
    });

    // Positional explore writes v1 INTO the existing draft — keyless floor.
    const result = await runExplore({ cwd: tmpDir, directionId: mainId });
    expect(result.dryRun).toBe(true);
    expect(result.directionIds).toEqual([mainId]);

    const record = await core().get(mainId);
    expect(record.head).not.toBeNull();
    expect(record.versions).toEqual([record.head]);
    v1Id = record.head!;

    // The frozen v1 snapshot carries THIS direction's brief, its moodboard
    // reference (with intent), and the global rule — and NOTHING from the
    // sibling direction (per-direction memory/brief isolation).
    const snapshot = await readVersionSnapshot(mainId, v1Id);
    expect(snapshot).toContain("slow-journalism magazine");
    expect(snapshot).toContain("brand/input/references/mood.png");
    expect(snapshot).toContain("inspire");
    expect(snapshot).toContain(HARD_RULE);
    expect(snapshot).not.toContain(OTHER_DIRECTION_TOKEN);

    // A direction that already has versions gets `regenerate`, never a second
    // explore — the teaching error names the fix.
    await expect(runExplore({ cwd: tmpDir, directionId: mainId })).rejects.toThrow(
      /regenerate/,
    );
  });

  it("3. element feedback → regenerate appends v2; v1 is byte-immutable; the color lock reaches v2's context", async () => {
    // The three element-feedback gestures, direction-scoped by construction:
    // keep → an `inspire` AssetRef.
    const cropAbs = path.join(tmpDir, "brand", "input", "references", "kept-crop.png");
    await fs.writeFile(cropAbs, "kept-crop-bytes");
    await core().addAsset(mainId, {
      kind: "image",
      path: "brand/input/references/kept-crop.png",
      intent: "inspire",
      note: "keep the masthead treatment",
    });
    // discard → an attributed `feedback` entry carrying a stored thumbnail.
    const thumbAbs = path.join(tmpDir, "brand", "assets", "feedback", "discard-1.png");
    await fs.mkdir(path.dirname(thumbAbs), { recursive: true });
    await fs.writeFile(thumbAbs, "discard-thumb-bytes");
    await core().appendFeedback(mainId, {
      body: "Discard the neon gradient band",
      author: "tim",
      source: "element-feedback",
      asset: "brand/assets/feedback/discard-1.png",
    });
    // eyedropper → a color-lock `decision` with the EXACT hex.
    await core().recordColorLock(mainId, {
      hex: LOCKED_HEX,
      author: "tim",
      source: "element-feedback",
    });
    const decisions = (await core().memoryEntries(mainId)).filter(
      (e) => e.kind === "decision",
    );
    expect(decisions.some((e) => e.body.includes(`Color locked: ${LOCKED_HEX}`))).toBe(
      true,
    );

    // Snapshot v1's version-record bytes BEFORE regenerate.
    const resolved = await resolveDirection(tmpDir, config, mainId);
    const v1RecordPath = path.join(resolved.versionsDir, v1Id, "direction-version.json");
    v1Bytes = await fs.readFile(v1RecordPath);

    const result = await runRegenerateVisuals({ cwd: tmpDir, directionId: mainId });
    expect(result.dryRun).toBe(true);
    v2Id = result.versionId;
    expect(v2Id).not.toBe(v1Id);

    const record = await core().get(mainId);
    expect(record.versions).toEqual([v1Id, v2Id]);
    expect(record.head).toBe(v2Id);

    // Append-only immutability: v1's bytes are IDENTICAL after the append.
    const v1After = await fs.readFile(v1RecordPath);
    expect(v1After.equals(v1Bytes)).toBe(true);

    // The lock's exact hex is present in v2's assembled context — a memory
    // lock, never a brief field.
    const v2Snapshot = await readVersionSnapshot(mainId, v2Id);
    expect(v2Snapshot).toContain(LOCKED_HEX);
    expectNoHexInBrief(await core().getBrief(mainId));
  });

  it("4. `direction fork` — a draft with the copied brief, no versions, source byte-untouched", async () => {
    const resolvedSource = await resolveDirection(tmpDir, config, mainId);
    const sourceRecordBytes = await fs.readFile(
      path.join(resolvedSource.dir, "direction.yaml"),
    );
    const sourceMemoryBytes = await fs.readFile(
      path.join(resolvedSource.dir, "memory.yaml"),
    );

    const forked = await runDirectionFork({ cwd: tmpDir, sourceId: mainId });
    expect(forked.sourceId).toBe(mainId);
    expect(forked.forks).toHaveLength(1);
    const fork = forked.forks[0];
    forkId = fork.directionId;
    expect(fork.isDraft).toBe(true);
    expect(fork.version).toBe(1);

    const forkRecord = await core().get(forkId);
    expect(forkRecord.versions).toEqual([]);
    expect(forkRecord.head).toBeNull();
    // The brief is copied deep-equal from the source.
    expect(forkRecord.brief).toEqual((await core().get(mainId)).brief);

    // No versions/ and no extracted-assets/ folder — a fork is a new
    // exploration, never a duplicate of a render.
    const resolvedFork = await resolveDirection(tmpDir, config, forkId);
    await expect(fs.access(resolvedFork.versionsDir)).rejects.toThrow();
    await expect(fs.access(resolvedFork.extractedAssetsDir)).rejects.toThrow();

    // Exactly ONE fork-provenance `decision` naming the source (memory was not
    // copied — no --with-memory).
    const forkMemory = await core().memoryEntries(forkId);
    expect(forkMemory).toHaveLength(1);
    expect(forkMemory[0].kind).toBe("decision");
    expect(forkMemory[0].body).toContain(mainId);

    // The source's snapshotted bytes are UNCHANGED.
    expect(
      (await fs.readFile(path.join(resolvedSource.dir, "direction.yaml"))).equals(
        sourceRecordBytes,
      ),
    ).toBe(true);
    expect(
      (await fs.readFile(path.join(resolvedSource.dir, "memory.yaml"))).equals(
        sourceMemoryBytes,
      ),
    ).toBe(true);
  });

  it("5. `explore --describe --count 2` mints two DISTINCT briefs on the keyless floor; a seed hex lands as a color-lock decision, never a brief field", async () => {
    const result = await runExplore({
      cwd: tmpDir,
      describe: `warm editorial with ${SEED_HEX} accents`,
      count: 2,
    });
    expect(result.dryRun).toBe(true);
    expect(result.directionIds).toHaveLength(2);
    // Keyless: both briefs came from the deterministic floor.
    expect(result.floorCount).toBe(2);
    divergentIds = result.directionIds;

    const [a, b] = await Promise.all(divergentIds.map((id) => core().get(id)));
    // Each minted draft got its v1.
    expect(a.head).not.toBeNull();
    expect(b.head).not.toBeNull();
    // Constructive distinctness — the floor's ordinal-embedded positioning.
    expect(a.brief.positioning).toBeDefined();
    expect(a.brief.positioning).not.toBe(b.brief.positioning);

    for (const id of divergentIds) {
      // The typed hex routed to a per-direction color-lock DECISION...
      const memory = await core().memoryEntries(id);
      expect(
        memory.some(
          (e) => e.kind === "decision" && e.body.includes(`Color locked: ${SEED_HEX}`),
        ),
      ).toBe(true);
      // ...and appears in NO brief field (the sanitizer's forbidden shapes).
      expectNoHexInBrief((await core().get(id)).brief);
    }
  });

  it("6. author a surface manifest → approve pins v2 and codifies binding.json → repoint/rebrand with the global rule surviving", async () => {
    // Author a project surface manifest so the manifest-present codify arm runs.
    await createSurfaceCore(tmpDir, config).setManifest([
      {
        id: "color.text",
        kind: "color-role",
        description: "primary body text color",
        criticality: "required",
        origin: "authored",
        attributions: [],
      },
    ]);

    const approve = await runApprove({
      cwd: tmpDir,
      directionId: mainId,
      versionId: v2Id,
      force: true,
    });

    // The pointer pins the EXACT approved version.
    const globalAfter = await brand().read();
    expect(globalAfter.approvedPointer?.directionId).toBe(mainId);
    expect(globalAfter.approvedPointer?.versionId).toBe(v2Id);
    expect(globalAfter.approvedPointer?.approvedAt).toBeDefined();

    // Codify wrote the pack manifest, the binding (present BECAUSE a surface
    // manifest exists), and the guides.
    expect(approve.filesWritten.some((f) => f.endsWith("pack-manifest.json"))).toBe(true);
    expect(approve.filesWritten).toContain("brand/generated/binding.json");
    expect(approve.surface).toBeDefined();
    expect(approve.filesWritten.some((f) => f.includes("guides/"))).toBe(true);

    // The surface rows are projected into the implementation brief.
    const implBrief = await fs.readFile(
      config.outputs.implementationBrief,
      "utf-8",
    );
    expect(implBrief).toContain("color.text");

    // The codified guides carry the global hard rule.
    const guidePath = path.join(config.brand.root, "guides", "visual-style-guide.md");
    expect(await fs.readFile(guidePath, "utf-8")).toContain(HARD_RULE);

    // REPOINT/REBRAND: approve a DIFFERENT direction (one of the divergent
    // drafts, whose head is its v1). The pointer moves; the global hard rule
    // SURVIVES the switch, never duplicated.
    const nextId = divergentIds[0];
    await runApprove({ cwd: tmpDir, directionId: nextId, force: true });

    const afterRepoint = await brand().read();
    expect(afterRepoint.approvedPointer?.directionId).toBe(nextId);
    expect(afterRepoint.rules).toHaveLength(1);
    expect(afterRepoint.rules[0].text).toBe(HARD_RULE);
    // ...and reaches the NEWLY codified guides too (precedence in output).
    expect(await fs.readFile(guidePath, "utf-8")).toContain(HARD_RULE);

    // Dry-run parity held throughout: the whole spine ran keyless and still
    // produced deterministic artifacts (binding, pack, guides, brand.css).
    await expect(
      fs.access(path.join(tmpDir, "brand", "generated", "brand.css")),
    ).resolves.toBeUndefined();
  });
});
