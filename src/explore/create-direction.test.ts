import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";

// Mock loadConfig but keep all other config.js exports (directionsRoot,
// globalBrandPath, storeDriver) real so the cores resolve real on-disk paths.
// This is the same approach used by the concept-pipeline integration test.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

import { createAuthoredDirection } from "./create-direction.js";
import { createDirectionCore } from "../direction/core.js";
import { CommandError } from "../errors.js";
import { directionsRoot } from "../config.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Create Direction Test", type: "prototype", framework: "next" },
    brand: {
      root: path.join(cwd, "brand"),
      references: path.join(cwd, "brand", "input", "references"),
      approved: path.join(cwd, "brand", "approved"),
      rejected: path.join(cwd, "brand", "rejected"),
      directions: path.join(cwd, "brand", "directions"),
    },
    models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
    outputs: {
      cursorRules: path.join(cwd, ".cursor", "rules", "keyart-brand.mdc"),
      cssVars: path.join(cwd, "brand", "generated", "brand.css"),
      implementationBrief: path.join(cwd, "brand", "generated", "implementation-brief.md"),
    },
    store: { driver: "file" },
  };
}

const FULL_CONTENT = {
  name: "Bold & Modern",
  summary: "A strong, geometric direction for a tech startup.",
  character: {
    mood: "confident, energetic",
    composition: "asymmetric with clear focal points",
    layout: "dense grid with generous breathing room",
  },
  usage: {
    rules: ["use the primary role for all CTAs"],
    antiRules: ["never use the muted role for critical UI"],
  },
  copyExamples: {
    headline: "Built for what comes next",
    subheadline: "A modern platform designed for clarity.",
    cta: "Get started",
  },
};

/** Resolve the absolute (flat) directions root. */
function directionsDirFor(cwd: string): string {
  const config = buildTestConfig(cwd);
  return directionsRoot(cwd, config);
}

/** Create a seed direction (the pre-existing direction whose brief seeds a create). */
async function createSeedDirection(
  cwd: string,
  id = "seed",
  name = "Seed",
): Promise<void> {
  const config = buildTestConfig(cwd);
  await createDirectionCore(cwd, config).create({ id, name });
}

/** Read a version's direction-version.json as a parsed object. */
async function readVersionJson(
  directionsDir: string,
  directionId: string,
  versionId: string,
): Promise<Record<string, unknown>> {
  const p = path.join(directionsDir, directionId, "versions", versionId, "direction-version.json");
  return JSON.parse(await fs.readFile(p, "utf-8")) as Record<string, unknown>;
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-create-dir-"));
  delete process.env.OPENAI_API_KEY;
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
});

afterEach(async () => {
  delete process.env.OPENAI_API_KEY;
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── 1. Creates a direction at v1 (SC-02) ─────────────────────────────────────

describe("createAuthoredDirection — v1 creation (SC-02)", () => {
  it("writes a valid v1 direction with the authored name/summary/character/usage/copyExamples", async () => {
    await createSeedDirection(tmpDir);
    const result = await createAuthoredDirection({
      cwd: tmpDir,
      directionId: "seed",
      content: FULL_CONTENT,
    });

    expect(result.versionId).toBeTruthy();
    expect(result.directionId).toBeTruthy();
    expect(result.seedDirection).toBe("seed");

    // direction.yaml has versions: [v1] and head: v1
    const config = buildTestConfig(tmpDir);
    const record = await createDirectionCore(tmpDir, config).get(result.directionId);
    expect(record.versions).toEqual([result.versionId]);
    expect(record.head).toBe(result.versionId);

    // direction-version.json carries the authored fields
    const directionsDir = directionsDirFor(tmpDir);
    const vj = await readVersionJson(directionsDir, result.directionId, result.versionId);
    expect(vj.name).toBe(FULL_CONTENT.name);
    expect(vj.summary).toBe(FULL_CONTENT.summary);
    expect(vj.character).toEqual(FULL_CONTENT.character);
    expect(vj.usage).toEqual(FULL_CONTENT.usage);
    expect(vj.copyExamples).toEqual(FULL_CONTENT.copyExamples);
    expect(vj.producedBy).toBe("authored");
  });

  it("filesWritten are cwd-relative, forward-slash, and non-empty", async () => {
    await createSeedDirection(tmpDir);
    const result = await createAuthoredDirection({
      cwd: tmpDir,
      directionId: "seed",
      content: FULL_CONTENT,
    });

    expect(result.filesWritten.length).toBeGreaterThan(0);
    for (const p of result.filesWritten) {
      expect(p).not.toContain("\\");
      expect(path.isAbsolute(p)).toBe(false);
    }
  });
});

// ── 2. Engine tokens present + never token-less (SC-05) ──────────────────────

describe("createAuthoredDirection — engine tokens (SC-05)", () => {
  it("the created version carries all six palette roles, typography, and shape", async () => {
    await createSeedDirection(tmpDir);
    const result = await createAuthoredDirection({
      cwd: tmpDir,
      directionId: "seed",
      content: FULL_CONTENT,
    });

    const directionsDir = directionsDirFor(tmpDir);
    const vj = await readVersionJson(directionsDir, result.directionId, result.versionId);
    const tokens = vj.tokens as Record<string, unknown>;

    expect(tokens).toBeDefined();
    const palette = tokens.palette as Array<{ role: string; hex: string }>;
    expect(Array.isArray(palette)).toBe(true);
    expect(palette).toHaveLength(6);
    const roles = palette.map((t) => t.role).sort();
    expect(roles).toEqual(["background", "muted", "primary", "secondary", "surface", "text"].sort());

    const typography = tokens.typography as Record<string, string>;
    expect(typeof typography.heading).toBe("string");
    expect(typeof typography.body).toBe("string");

    const shape = tokens.shape as Record<string, string>;
    expect(typeof shape.radius).toBe("string");
    expect(typeof shape.spacingUnit).toBe("string");
  });
});

// ── 3. Memory-locked hex held verbatim in seed palette (SC-04) ───────────────

describe("createAuthoredDirection — memory color-lock in palette (SC-04)", () => {
  it("a recorded color-lock hex appears unchanged in the seed palette", async () => {
    const LOCKED_HEX = "#123456";
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);

    await core.create({ id: "seed", name: "Seed" });
    await core.recordColorLock("seed", {
      hex: LOCKED_HEX,
      author: "test",
      source: "test",
    });

    const result = await createAuthoredDirection({
      cwd: tmpDir,
      directionId: "seed",
      content: FULL_CONTENT,
    });

    const directionsDir = directionsDirFor(tmpDir);
    const vj = await readVersionJson(directionsDir, result.directionId, result.versionId);
    const tokens = vj.tokens as Record<string, unknown>;
    const palette = tokens.palette as Array<{ role: string; hex: string }>;

    const hexes = palette.map((t) => t.hex.toLowerCase());
    expect(hexes).toContain(LOCKED_HEX);
  });
});

// ── 4. No model call / keyless (SC-02, SC-08) ────────────────────────────────

describe("createAuthoredDirection — keyless / no model call (SC-02, SC-08)", () => {
  it("never calls generateImage or describeImageBrand; succeeds with no key; dryRun is true", async () => {
    await createSeedDirection(tmpDir);

    // Spy on openai module — no key set, so hasApiKey() returns false.
    const openaiModule = await import("../openai.js");
    const genSpy = vi.spyOn(openaiModule, "generateImage");
    const describeSpy = vi.spyOn(openaiModule, "describeImageBrand");

    const result = await createAuthoredDirection({
      cwd: tmpDir,
      directionId: "seed",
      content: FULL_CONTENT,
    });

    expect(genSpy).not.toHaveBeenCalled();
    expect(describeSpy).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
  });
});

// ── 5. Snapshots frozen (SC-05) ──────────────────────────────────────────────

describe("createAuthoredDirection — frozen snapshots (SC-05)", () => {
  it("brief-snapshot.md equals getRenderedBrief and context-snapshot.md has the authored-direction header", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "seed", name: "Seed" });

    const result = await createAuthoredDirection({
      cwd: tmpDir,
      directionId: "seed",
      content: FULL_CONTENT,
    });

    const directionsDir = directionsDirFor(tmpDir);
    const versionDir = path.join(
      directionsDir, result.directionId, "versions", result.versionId,
    );

    const briefSnapshot = await fs.readFile(path.join(versionDir, "brief-snapshot.md"), "utf-8");
    const expectedBrief = await core.getRenderedBrief("seed");
    expect(briefSnapshot).toBe(expectedBrief);

    const contextSnapshot = await fs.readFile(path.join(versionDir, "context-snapshot.md"), "utf-8");
    expect(contextSnapshot).toContain("## Authored direction");
    expect(contextSnapshot).toContain("keyless, no model call");
    // Context block is appended after the header — verify it has content.
    expect(contextSnapshot.length).toBeGreaterThan(60);
  });
});

// ── 6. directionId collision-safe (SC-02) ────────────────────────────────────

describe("createAuthoredDirection — collision-safe directionId (SC-02)", () => {
  it("two creates with the same name yield distinct suffixed ids, no clobber", async () => {
    await createSeedDirection(tmpDir);

    const result1 = await createAuthoredDirection({
      cwd: tmpDir,
      directionId: "seed",
      content: FULL_CONTENT,
    });
    const result2 = await createAuthoredDirection({
      cwd: tmpDir,
      directionId: "seed",
      content: FULL_CONTENT,
    });

    expect(result1.directionId).not.toBe(result2.directionId);

    // Both version folders must exist (no clobber).
    const directionsDir = directionsDirFor(tmpDir);
    const vDir1 = path.join(directionsDir, result1.directionId, "versions", result1.versionId);
    const vDir2 = path.join(directionsDir, result2.directionId, "versions", result2.versionId);
    await expect(fs.access(vDir1)).resolves.toBeUndefined();
    await expect(fs.access(vDir2)).resolves.toBeUndefined();

    // The second id is the suffixed sibling (e.g. bold-modern-2).
    expect(result2.directionId).toMatch(/-2$/);
  });
});

// ── 7. Prompts composed when omitted (SC-05) ─────────────────────────────────

describe("createAuthoredDirection — deterministic prompt composition (SC-05)", () => {
  it("omitting both prompts yields non-empty files referencing the authored name", async () => {
    await createSeedDirection(tmpDir);
    const result = await createAuthoredDirection({
      cwd: tmpDir,
      directionId: "seed",
      content: FULL_CONTENT,
    });

    const directionsDir = directionsDirFor(tmpDir);
    const versionDir = path.join(
      directionsDir, result.directionId, "versions", result.versionId,
    );
    const styleMd = await fs.readFile(path.join(versionDir, "style-tile-prompt.md"), "utf-8");
    const homeMd = await fs.readFile(path.join(versionDir, "homepage-mockup-prompt.md"), "utf-8");

    expect(styleMd.trim().length).toBeGreaterThan(0);
    expect(homeMd.trim().length).toBeGreaterThan(0);
    // Deterministic composition embeds the authored name.
    expect(styleMd).toContain(FULL_CONTENT.name);
    expect(homeMd).toContain(FULL_CONTENT.name);
  });

  it("explicit prompts are stored verbatim (modulo writer decoration)", async () => {
    await createSeedDirection(tmpDir);
    const EXPLICIT_STYLE = "My custom style tile prompt for testing.";
    const EXPLICIT_HOME = "My custom homepage mockup prompt for testing.";
    const content = { ...FULL_CONTENT, styleTilePrompt: EXPLICIT_STYLE, homepageMockupPrompt: EXPLICIT_HOME };

    const result = await createAuthoredDirection({ cwd: tmpDir, directionId: "seed", content });

    const directionsDir = directionsDirFor(tmpDir);
    const versionDir = path.join(
      directionsDir, result.directionId, "versions", result.versionId,
    );
    const styleMd = await fs.readFile(path.join(versionDir, "style-tile-prompt.md"), "utf-8");
    const homeMd = await fs.readFile(path.join(versionDir, "homepage-mockup-prompt.md"), "utf-8");

    // The explicit prompt text must appear in the written file (the writer appends
    // a CONTENT LOCK + optional negatives after the base prose, so the base is present).
    expect(styleMd).toContain(EXPLICIT_STYLE);
    expect(homeMd).toContain(EXPLICIT_HOME);
  });
});

// ── 8. Guard rejects hex-in-prose at the core (SC-03) ────────────────────────

describe("createAuthoredDirection — hex-in-prose rejection (SC-03)", () => {
  it("calling the core directly with a hex in character.mood throws CommandError", async () => {
    await createSeedDirection(tmpDir);
    const bad = {
      ...FULL_CONTENT,
      character: { ...FULL_CONTENT.character, mood: "warm #1a2b3c grounding" },
    };
    await expect(
      createAuthoredDirection({ cwd: tmpDir, directionId: "seed", content: bad }),
    ).rejects.toThrow(CommandError);
  });

  it("a tokens key in the raw payload throws CommandError", async () => {
    await createSeedDirection(tmpDir);
    const bad = {
      ...FULL_CONTENT,
      tokens: { palette: [], typography: { heading: "Inter", body: "Inter" }, shape: { radius: "4px", spacingUnit: "8px" } },
    };
    await expect(
      createAuthoredDirection({ cwd: tmpDir, directionId: "seed", content: bad }),
    ).rejects.toThrow(CommandError);
  });
});

// ── 9. Per-direction isolation (SC-08) ───────────────────────────────────────

describe("createAuthoredDirection — per-direction isolation (SC-08)", () => {
  it("creating a direction seeded from direction B does not include direction A's lock in B's palette", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);

    const HEX_A = "#aabbcc";
    const HEX_B = "#112233";

    // Create seed directions A and B with distinct color-locks.
    await core.create({ id: "seed-a", name: "Seed A" });
    await core.create({ id: "seed-b", name: "Seed B" });
    await core.recordColorLock("seed-a", { hex: HEX_A, author: "test", source: "test" });
    await core.recordColorLock("seed-b", { hex: HEX_B, author: "test", source: "test" });

    // Create a direction seeded from B.
    const result = await createAuthoredDirection({
      cwd: tmpDir,
      directionId: "seed-b",
      content: FULL_CONTENT,
    });

    expect(result.seedDirection).toBe("seed-b");

    // Directions live flat under the (single) directions root.
    const directionsDir = directionsDirFor(tmpDir);

    const vj = await readVersionJson(directionsDir, result.directionId, result.versionId);
    const tokens = vj.tokens as Record<string, unknown>;
    const palette = tokens.palette as Array<{ role: string; hex: string }>;
    const hexes = palette.map((t) => t.hex.toLowerCase());

    // B's lock must appear in B's palette (it was locked in the context).
    expect(hexes).toContain(HEX_B);

    // A's lock must NOT appear in B's palette (isolation: B never read A's memory).
    expect(hexes).not.toContain(HEX_A);

    // The context snapshot must not contain A's hex either.
    const versionDir = path.join(directionsDir, result.directionId, "versions", result.versionId);
    const contextSnapshot = await fs.readFile(path.join(versionDir, "context-snapshot.md"), "utf-8");
    expect(contextSnapshot.toLowerCase()).not.toContain(HEX_A);
  });
});
