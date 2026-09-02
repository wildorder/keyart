import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig, DirectionVersion } from "../types.js";

// Mock loadConfig only — every other config.js export keeps its real
// implementation so the cores resolve real on-disk paths under the tmp project.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

import { runDirection } from "../commands/direction.js";
import { runExplore } from "../commands/explore.js";
import { runEditDirection, runSaveVariant } from "../commands/edit-direction.js";
import { runRegenerateVisuals } from "../commands/regenerate-visuals.js";
import { readHead, readVersion } from "../direction/store.js";
import { createDirectionCore } from "../direction/core.js";
import { directionsRoot } from "../config.js";

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Edit ITest", type: "prototype", framework: "next" },
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

let tmpDir: string;
let savedKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-edit-"));
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Flat `directions/` root — directions no longer nest under a parent aggregate. */
function directionsDir(): string {
  return directionsRoot(tmpDir, buildTestConfig(tmpDir));
}

/** Absolute version folder for a direction's head (or a given version). */
async function versionDir(directionId: string, versionId?: string): Promise<string> {
  const dir = directionsDir();
  const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
  const vid = versionId ?? (await core.get(directionId)).head!;
  return path.join(dir, directionId, "versions", vid);
}

async function snapshotDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string, prefix: string): Promise<void> {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      const relPath = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, relPath);
      else out[relPath] = await fs.readFile(abs, "utf-8");
    }
  }
  await walk(dir, "");
  return out;
}

/**
 * Seeds two fully independent draft directions (direction-a / direction-b,
 * each an aggregate root with its own embedded brief/memory) and
 * positional-explores each into its v1.
 */
async function seedAndExplore(): Promise<void> {
  await runDirection({ cwd: tmpDir, verb: "new", id: "direction-a" });
  await runDirection({ cwd: tmpDir, verb: "new", id: "direction-b" });
  await runExplore({ cwd: tmpDir, directionId: "direction-a" });
  await runExplore({ cwd: tmpDir, directionId: "direction-b" });
}

describe("edit direction (in-place + save-as-variant, no network / no key)", () => {
  it("edits a direction VERSION in place, rewriting its direction-version.json", async () => {
    await seedAndExplore();

    const result = await runEditDirection({
      cwd: tmpDir,
      directionId: "direction-a",
      edits: { name: "Renamed A", summary: "A brand-new summary." },
    });
    expect(result.directionId).toBe("direction-a");

    // (a) The head version's record reflects the edit; identity preserved.
    const edited = await readHead(directionsDir(), "direction-a");
    expect(edited.name).toBe("Renamed A");
    expect(edited.summary).toBe("A brand-new summary.");
    expect(result.versionId).toBe(edited.id);

    // (b) A sibling direction is untouched (siblings are fully independent).
    const sibling = await readHead(directionsDir(), "direction-b");
    expect(sibling.name).not.toBe("Renamed A");

    // (c) The persisted direction-version.json on disk carries the edit.
    const verDir = await versionDir("direction-a");
    const perVersion = JSON.parse(
      await fs.readFile(path.join(verDir, "direction-version.json"), "utf-8"),
    ) as DirectionVersion;
    expect(perVersion.name).toBe("Renamed A");
  });

  it("edits structured character + usage, persisting them with no legacy prose fields", async () => {
    await seedAndExplore();

    await runEditDirection({
      cwd: tmpDir,
      directionId: "direction-a",
      edits: {
        character: { mood: "calm", layout: "grid" },
        usage: {
          rules: ["use --brand-text for body"],
          antiRules: ["never hardcode hex"],
        },
      },
    });

    // The head version's direction-version.json carries the structured fields.
    const verDir = await versionDir("direction-a");
    const raw = await fs.readFile(
      path.join(verDir, "direction-version.json"),
      "utf-8",
    );
    const perVersion = JSON.parse(raw) as DirectionVersion;
    expect(perVersion.character).toEqual({ mood: "calm", layout: "grid" });
    expect(perVersion.usage).toEqual({
      rules: ["use --brand-text for body"],
      antiRules: ["never hardcode hex"],
    });

    // The freeform fields the structured shape replaced never appear on disk:
    // no top-level visualStyle/designRules/antiRules.
    expect(perVersion).not.toHaveProperty("visualStyle");
    expect(perVersion).not.toHaveProperty("designRules");
    expect(perVersion).not.toHaveProperty("antiRules");
    expect(raw).not.toContain("visualStyle");
    expect(raw).not.toContain("designRules");
  });

  it("rejects an in-place edit that drops below the schema minimums", async () => {
    await seedAndExplore();

    await expect(
      runEditDirection({
        cwd: tmpDir,
        directionId: "direction-a",
        edits: { summary: "   " },
      }),
    ).rejects.toThrow(/summary is required/);
  });

  it("saves a variant as a NEW VERSION of the SAME direction (head advances), leaving prior versions immutable", async () => {
    await seedAndExplore();

    const parentVerDir = await versionDir("direction-a"); // v1 folder
    const before = await snapshotDir(parentVerDir);
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    const recordBefore = await core.get("direction-a");
    const parentVersionId = recordBefore.head;
    expect(recordBefore.versions).toHaveLength(1);

    const variant = await runSaveVariant({
      cwd: tmpDir,
      directionId: "direction-a",
      edits: { name: "Hand Tuned", summary: "A hand-authored take." },
    });

    // (a) The SAME direction — a variant is now a new VERSION, not a new direction.
    expect(variant.directionId).toBe("direction-a");
    const recordAfter = await core.get("direction-a");
    expect(recordAfter.versions).toHaveLength(2);
    expect(recordAfter.head).toBe(variant.versionId);
    expect(variant.versionId).not.toBe(parentVersionId);

    // (b) The new head carries the edited content + manual-edit provenance, no lineage.
    const child = await readVersion(directionsDir(), "direction-a", variant.versionId);
    expect(child.name).toBe("Hand Tuned");
    expect(child.summary).toBe("A hand-authored take.");
    expect(child.producedBy).toBe("manual edit");
    expect(child).not.toHaveProperty("lineage");

    // (c) skipImages: an edited version never writes preview PNGs.
    const files = await snapshotDir(
      path.join(directionsDir(), "direction-a", "versions", variant.versionId),
    );
    expect(Object.keys(files).some((f) => f.endsWith(".png"))).toBe(false);

    // (d) The prior version folder is byte-identical before/after (append-only).
    const after = await snapshotDir(parentVerDir);
    expect(after).toEqual(before);
  });

  it("regenerates visuals only — never rewrites text, appends a version, dry-run-safe", async () => {
    await seedAndExplore();

    const v1Dir = await versionDir("direction-a"); // v1 folder
    const v1JsonPath = path.join(v1Dir, "direction-version.json");
    const textBefore = await fs.readFile(v1JsonPath, "utf-8");
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    const recordBefore = await core.get("direction-a");

    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: "direction-a",
      tweak: "warmer palette",
    });

    // (a) Dry-run (no key) writes no IMAGES and never throws — but the
    //     deterministic style board (SVG + markdown) is model-free, so it
    //     re-renders even keyless. A NEW version was appended (the head advances).
    expect(result.dryRun).toBe(true);
    expect(result.boardWritten).toBe(true);
    const recordAfter = await core.get("direction-a");
    expect(recordAfter.versions).toHaveLength(recordBefore.versions.length + 1);
    expect(recordAfter.head).toBe(result.versionId);

    // (b) The NEW version folder holds the deterministic board + the writer's
    //     records; no PNG in a keyless run.
    const newDir = await versionDir("direction-a"); // now the v2 head
    const newFiles = await snapshotDir(newDir);
    expect(Object.keys(newFiles)).toEqual(
      expect.arrayContaining([
        "direction-version.json",
        "style-board.md",
        "style-board.svg",
      ]),
    );
    expect(Object.keys(newFiles).some((f) => f.endsWith(".png"))).toBe(false);

    // (c) The prior version's record is byte-identical — regenerate never rewrites
    //     text and prior versions are immutable (append-only).
    const textAfter = await fs.readFile(v1JsonPath, "utf-8");
    expect(textAfter).toBe(textBefore);
  });
});
