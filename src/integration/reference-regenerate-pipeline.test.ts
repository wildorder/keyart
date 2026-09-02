import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";

// Mock loadConfig only — every other config.js export (directionsRoot,
// globalBrandPath, storeDriver) keeps its real implementation so the cores
// resolve real on-disk paths under the tmp project. This is a deterministic,
// network-free, key-free exercise of reference-grounded explore + the single
// iterate path (feedback → regenerate appends a version).
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

import { runDirection } from "../commands/direction.js";
import { runExplore } from "../commands/explore.js";
import { runRegenerateVisuals } from "../commands/regenerate-visuals.js";
import { createDirectionCore } from "../direction/core.js";
import {
  readDirection,
  readHead,
  readVersion,
  listDirectionIds,
} from "../direction/store.js";
import type { DirectionVersion } from "../types.js";
import { directionsRoot } from "../config.js";

const ASSET_NOTE = "primary moodboard — warm editorial palette";

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Reference/Refine ITest", type: "prototype", framework: "next" },
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

let tmpDir: string;
let savedKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-refpipe-"));
  // Genuinely dry-run / deterministic: no API key, no network. Save + restore so
  // we never leak a change into the ambient environment.
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = savedKey;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** cwd-relative, forward-slash path — the shared reporting convention. */
function rel(abs: string): string {
  return path.relative(tmpDir, abs).split(path.sep).join("/");
}

/** Absolute path to a direction's dir under the tmp project. */
function directionDir(id: string): string {
  return path.join(directionsRoot(tmpDir, buildTestConfig(tmpDir)), id);
}

/**
 * Registers an image AssetRef on a direction, writing a tiny placeholder file
 * under the direction's `assets/` and recording it via the core (version-safe).
 * Returns the cwd-relative asset path that lands in the assembled context.
 */
async function addImageReference(id: string): Promise<string> {
  const assetsDir = path.join(directionDir(id), "assets");
  await fs.mkdir(assetsDir, { recursive: true });
  const assetAbs = path.join(assetsDir, "moodboard.png");
  await fs.writeFile(assetAbs, "not-a-real-png", "utf-8");
  const assetPath = rel(assetAbs);
  const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
  await core.addAsset(id, { kind: "image", path: assetPath, note: ASSET_NOTE });
  return assetPath;
}

/** Absolute `directions/` dir for a direction. */
function directionsDir(id: string): string {
  return directionsRoot(tmpDir, buildTestConfig(tmpDir));
}

/** Absolute head-version folder of a direction. */
async function headVersionDir(directionId: string): Promise<string> {
  const dir = directionsDir(directionId);
  const head = (await readHead(dir, directionId)).id;
  return path.join(dir, directionId, "versions", head);
}

describe("reference-grounded explore + regenerate pipeline (end-to-end, no network / no key)", () => {
  it("elevates a direction's image asset into the version's context-snapshot (SC-04)", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    const assetPath = await addImageReference("moody");

    const run = await runExplore({ cwd: tmpDir, directionId: "moody" });
    expect(run.dryRun).toBe(true); // proved key-free

    // The frozen context snapshot now lives inside each direction's version folder.
    const verDir = await headVersionDir(run.directionIds[0]);
    const context = await fs.readFile(
      path.join(verDir, "context-snapshot.md"),
      "utf-8",
    );
    // The reference section exists and names the asset — provenance without a key.
    expect(context).toContain("## Reference Images");
    expect(context).toContain(assetPath);
    expect(context).toContain(ASSET_NOTE);
  });

  it("feedback → regenerate appends a version, keeps prior versions immutable, and logs isolated attributed memory (SC-06/SC-07/SC-11)", async () => {
    // Two directions prove per-direction isolation: a regenerate on `moody` must
    // never touch `calm`'s memory.
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    await runDirection({ cwd: tmpDir, verb: "new", id: "calm" });
    await runExplore({ cwd: tmpDir, directionId: "moody" });

    const dir = directionsDir("moody");
    const directionId = "moody"; // positional explore wrote v1 into the draft itself

    // The v1 head record — captured to prove append-only immutability.
    const v1Id = (await readHead(dir, directionId)).id;
    const v1Before = await readVersion(dir, directionId, v1Id);

    // Feedback → regenerate (the single iterate path). Dry-run (no key) still
    // appends a cloned-token version and never throws.
    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId,
      keep: ["palette"],
      tweak: "warm the type",
    });
    expect(result.dryRun).toBe(true);

    // A NEW version was appended and is the head; v1 is byte-unchanged.
    const index = await readDirection(dir, directionId);
    expect(index.versions).toHaveLength(2);
    expect(index.versions.at(-1)?.id).toBe(result.versionId);
    expect(index.versions.at(-1)?.id).not.toBe(v1Id);
    const v1After: DirectionVersion = await readVersion(dir, directionId, v1Id);
    expect(v1After).toEqual(v1Before);

    // The keep+tweak gesture is logged as attributed `regenerate` feedback on
    // `moody` — and ONLY on `moody` (per-direction isolation).
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    const moodyFeedback = (await core.memoryEntries(directionId)).filter((entry) => entry.kind === "feedback");
    const entry = moodyFeedback.find((e) => e.source === "regenerate");
    expect(entry).toBeDefined();
    expect(entry!.body).toContain("palette");
    expect(entry!.body).toContain("warm the type");

    const calmMemory = await core.memoryEntries("calm");
    expect(calmMemory).toHaveLength(0);
  });

  it("generate another option adds a single NEW sibling direction (SC-06)", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    const run = await runExplore({ cwd: tmpDir, from: "moody" });
    // A divergent explore mints three brand-new directions from the seed.
    expect(run.directionIds).toHaveLength(3);
    const before = await listDirectionIds(directionsDir("moody"));
    expect(before).toHaveLength(4); // seed direction + three minted directions

    // "Generate another option" is `explore --from moody --count 1` — one more sibling at v1.
    const appended = await runExplore({
      cwd: tmpDir,
      from: "moody",
      count: 1,
    });

    // Exactly one new sibling direction was added; the originals are untouched.
    expect(appended.directionIds).toHaveLength(1);
    const after = await listDirectionIds(directionsDir("moody"));
    expect(after).toHaveLength(5);
    expect(after).toEqual(
      expect.arrayContaining([...before, appended.directionIds[0]]),
    );
  });
});
