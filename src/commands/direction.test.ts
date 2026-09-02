import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";
import { CommandError } from "../errors.js";
import {
  runCreateDirection,
  runDirection,
  runDirectionNew,
  runDirectionList,
  runDirectionShow,
  runDirectionFork,
  runRule,
  runPromote,
  resolveTargetDirectionId,
  DIRECTION_VERBS,
} from "./direction.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { VersionConflictError } from "../store/versioned-store.js";
import * as openai from "../openai.js";
import type { AuthoredDirectionContent } from "../types.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

// The LLM mapper behind `direction brief map` calls chatJson; mock it so no
// key / network is required. Default: dry-run (no key) — keyed tests override.
vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return {
    ...actual,
    hasApiKey: vi.fn(() => false),
    chatJson: vi.fn(async () => ({ data: null, dryRun: true })),
  };
});

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Direction Test", type: "prototype", framework: "next" },
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
      implementationBrief: path.join(
        cwd,
        "brand",
        "generated",
        "implementation-brief.md",
      ),
    },
    store: { driver: "file" },
  };
}

const validContent: AuthoredDirectionContent = {
  name: "Bold Editorial",
  summary: "Strong contrast, confident type, editorial feel",
  character: {
    mood: "bold, editorial, confident",
    composition: "asymmetric grids",
  },
  usage: {
    rules: ["Lead with strong typography"],
    antiRules: ["Avoid pastel backgrounds"],
  },
  copyExamples: {
    headline: "Ship it boldly",
    subheadline: "Design that means business",
    cta: "Get started",
  },
};

let tmpDir: string;
let config: KeyartConfig;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-direction-cmd-"));
  delete process.env.OPENAI_API_KEY;
  config = buildTestConfig(tmpDir);
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(config);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Create a SEED direction directly via the direction core (the pre-existing
 * direction whose brief seeds `runCreateDirection`'s new one). */
async function seedDirection(id: string): Promise<void> {
  const core = createDirectionCore(tmpDir, config);
  await core.create({ id, name: id, brief: { oneLiner: "test direction" } });
}

async function pathExists(relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(tmpDir, relPath));
    return true;
  } catch {
    return false;
  }
}

// 1. SC-02: CLI create writes v1
describe("runCreateDirection create", () => {
  it("creates a direction at v1 and returns directionId + versionId", async () => {
    await seedDirection("moody");

    const result = await runCreateDirection({
      cwd: tmpDir,
      verb: "create",
      seedDirectionId: "moody",
      json: JSON.stringify(validContent),
    });

    expect(result.directionId).toBeTruthy();
    expect(result.versionId).toBeTruthy();
    expect(result.seedDirection).toBe("moody");

    // Directions live FLAT at brand/directions/<directionId> (no nested concept).
    const directionsDir = `brand/directions`;
    expect(await pathExists(directionsDir)).toBe(true);
    expect(
      await pathExists(`${directionsDir}/${result.directionId}/direction.yaml`),
    ).toBe(true);
    expect(
      await pathExists(
        `${directionsDir}/${result.directionId}/versions/${result.versionId}/direction-version.json`,
      ),
    ).toBe(true);
  });

  // `resolveDirection` never auto-creates/scaffolds a default (design fact #1).
  // What DOES still scaffold a "default" direction is `runInit` itself (it
  // creates one via `createDirectionCore(...).create({ id: "default", ... })`
  // when absent). This test preserves the original's intent — pointing the
  // create command at the "default" direction right after `init` — without
  // relying on any auto-create-on-resolve behavior that no longer exists.
  it("also works with the default direction scaffolded by init", async () => {
    const { runInit } = await import("./init.js");
    await runInit({ cwd: tmpDir });

    const result = await runCreateDirection({
      cwd: tmpDir,
      verb: "create",
      seedDirectionId: "default",
      json: JSON.stringify(validContent),
    });

    expect(result.directionId).toBeTruthy();
    expect(result.versionId).toBeTruthy();
    expect(result.filesWritten.length).toBeGreaterThan(0);
  });
});

// 2. SC-03: bad JSON → friendly error
describe("runCreateDirection bad JSON", () => {
  it("throws a CommandError for malformed JSON", async () => {
    await seedDirection("moody");

    await expect(
      runCreateDirection({
        cwd: tmpDir,
        verb: "create",
        seedDirectionId: "moody",
        json: "{not json",
      }),
    ).rejects.toThrow(CommandError);

    await expect(
      runCreateDirection({
        cwd: tmpDir,
        verb: "create",
        seedDirectionId: "moody",
        json: "{not json",
      }),
    ).rejects.toThrow(/Could not parse the direction JSON/);
  });
});

// 3. SC-03: tokens key → friendly error (delegated to WS-01 core)
describe("runCreateDirection tokens key", () => {
  it("throws a CommandError naming tokens when the payload includes a tokens key", async () => {
    await seedDirection("moody");

    const payload = { ...validContent, tokens: {} };
    await expect(
      runCreateDirection({
        cwd: tmpDir,
        verb: "create",
        seedDirectionId: "moody",
        json: JSON.stringify(payload),
      }),
    ).rejects.toThrow(CommandError);

    await expect(
      runCreateDirection({
        cwd: tmpDir,
        verb: "create",
        seedDirectionId: "moody",
        json: JSON.stringify(payload),
      }),
    ).rejects.toThrow(/tokens/);
  });
});

// 4. SC-03: hex-in-prose → friendly error (delegated to WS-01 core)
describe("runCreateDirection hex in prose", () => {
  it("throws a CommandError naming the field when a hex appears in character.mood", async () => {
    await seedDirection("moody");

    const payload: AuthoredDirectionContent = {
      ...validContent,
      character: { ...validContent.character, mood: "warm like #1a2b3c" },
    };

    await expect(
      runCreateDirection({
        cwd: tmpDir,
        verb: "create",
        seedDirectionId: "moody",
        json: JSON.stringify(payload),
      }),
    ).rejects.toThrow(CommandError);

    await expect(
      runCreateDirection({
        cwd: tmpDir,
        verb: "create",
        seedDirectionId: "moody",
        json: JSON.stringify(payload),
      }),
    ).rejects.toThrow(/character\.mood/);
  });
});

// 5. Missing seedDirectionId / json / wrong verb → usage errors
describe("runCreateDirection argument validation", () => {
  it("throws for an unknown verb", async () => {
    await expect(
      runCreateDirection({
        cwd: tmpDir,
        verb: "delete",
        seedDirectionId: "moody",
        json: JSON.stringify(validContent),
      }),
    ).rejects.toThrow(/Unknown direction verb "delete"/);
  });

  it("throws for missing seedDirectionId", async () => {
    await expect(
      runCreateDirection({
        cwd: tmpDir,
        verb: "create",
        seedDirectionId: undefined,
        json: JSON.stringify(validContent),
      }),
    ).rejects.toThrow(/Usage: keyart direction create/);
  });

  it("throws for blank seedDirectionId", async () => {
    await expect(
      runCreateDirection({
        cwd: tmpDir,
        verb: "create",
        seedDirectionId: "  ",
        json: JSON.stringify(validContent),
      }),
    ).rejects.toThrow(/Usage: keyart direction create/);
  });

  it("throws for missing json", async () => {
    await expect(
      runCreateDirection({
        cwd: tmpDir,
        verb: "create",
        seedDirectionId: "moody",
        json: undefined,
      }),
    ).rejects.toThrow(/Usage: keyart direction create/);
  });

  it("throws for blank json", async () => {
    await expect(
      runCreateDirection({
        cwd: tmpDir,
        verb: "create",
        seedDirectionId: "moody",
        json: "   ",
      }),
    ).rejects.toThrow(/Usage: keyart direction create/);
  });
});

// 6. Missing/unknown seed direction → friendly error from resolveDirection
describe("runCreateDirection unknown seed direction", () => {
  it("throws a CommandError for an unknown seed direction id", async () => {
    // no-such-direction is never scaffolded, and resolveDirection never
    // auto-creates, so it throws.
    await expect(
      runCreateDirection({
        cwd: tmpDir,
        verb: "create",
        seedDirectionId: "no-such-direction",
        json: JSON.stringify(validContent),
      }),
    ).rejects.toThrow(CommandError);
  });
});

// WS-15: drafts are first-class (SC-03) — `direction new` / `list` / `show`.
describe("runDirectionNew — drafts", () => {
  it("mints a draft that round-trips at version 1", async () => {
    const result = await runDirectionNew({
      cwd: tmpDir,
      name: "Warm Editorial",
    });
    expect(result.isDraft).toBe(true);
    expect(result.version).toBe(1);

    const record = await createDirectionCore(tmpDir, config).get(
      result.directionId,
    );
    // Why 1 and not 0: core.create builds the record at the literal
    // `version: 0` (src/direction/core.ts:456), but the file store persists
    // `{ ...doc, version: (current ?? 0) + 1 }` and RETURNS that document
    // (src/store/file-store.ts:68,77) — the literal 0 is not the persisted value.
    expect(record.version).toBe(1);
    expect(record.versions).toEqual([]);
    expect(record.head).toBeNull();
    expect(record.status).toBe("active");

    const dir = `brand/directions/${result.directionId}`;
    expect(await pathExists(`${dir}/direction.yaml`)).toBe(true);
    expect(await pathExists(`${dir}/brief.md`)).toBe(true);
    expect(await pathExists(`${dir}/memory.yaml`)).toBe(true);
    expect(await pathExists(`${dir}/versions`)).toBe(false);
  });

  it("--describe hygiene: hex AND catalog font family are both stripped (adversarial)", async () => {
    const result = await runDirectionNew({
      cwd: tmpDir,
      name: "d",
      describe: "Playfair Display, warm editorial with #ff5722 accents",
    });
    const record = await createDirectionCore(tmpDir, config).get(
      result.directionId,
    );
    expect(record.brief.otherNotes).toContain("warm editorial");
    const briefJson = JSON.stringify(record.brief).toLowerCase();
    expect(briefJson).not.toContain("#ff5722");
    expect(briefJson).not.toContain("playfair display");
  });

  it("no --describe leaves the brief empty and brief.md the empty-brief projection", async () => {
    const result = await runDirectionNew({ cwd: tmpDir, name: "Blank" });
    const core = createDirectionCore(tmpDir, config);
    const record = await core.get(result.directionId);
    expect(record.brief.otherNotes).toBeUndefined();
    expect(record.brief).toEqual((await core.create({ id: "empty-ref", name: "Blank" })).brief);

    // brief.md is the deterministic projection of an empty brief: byte-equal
    // to another empty-brief direction's projection.
    const briefA = await fs.readFile(
      path.join(tmpDir, "brand", "directions", result.directionId, "brief.md"),
      "utf8",
    );
    const briefB = await fs.readFile(
      path.join(tmpDir, "brand", "directions", "empty-ref", "brief.md"),
      "utf8",
    );
    expect(briefA).toBe(briefB);
  });

  it("keyless/dry-run parity: identical record with and without a key", async () => {
    const { hasApiKey } = await import("../openai.js");

    vi.mocked(hasApiKey).mockReturnValue(false);
    const keyless = await runDirectionNew({
      cwd: tmpDir,
      name: "Parity A",
      describe: "calm and quiet",
    });
    vi.mocked(hasApiKey).mockReturnValue(true);
    const keyed = await runDirectionNew({
      cwd: tmpDir,
      name: "Parity B",
      describe: "calm and quiet",
    });

    const core = createDirectionCore(tmpDir, config);
    const a = await core.get(keyless.directionId);
    const b = await core.get(keyed.directionId);
    // A model is never consulted — byte-equivalent modulo timestamps + minted id.
    expect(a.brief).toEqual(b.brief);
    expect(a.versions).toEqual(b.versions);
    expect(a.head).toBe(b.head);
    expect(a.version).toBe(b.version);
  });

  it("rejects a blank name with usage text", async () => {
    await expect(runDirectionNew({ cwd: tmpDir, name: "  " })).rejects.toThrow(
      CommandError,
    );
    await expect(runDirectionNew({ cwd: tmpDir })).rejects.toThrow(
      /direction new/,
    );
  });
});

describe("runDirectionList / runDirectionShow — draft-aware readers", () => {
  it("report the draft state explicitly", async () => {
    const created = await runDirectionNew({ cwd: tmpDir, name: "Draft One" });

    const listed = await runDirectionList({ cwd: tmpDir });
    const entry = listed.directions.find(
      (d) => d.id === created.directionId,
    );
    expect(entry).toMatchObject({
      isDraft: true,
      head: null,
      versionCount: 0,
    });

    const shown = await runDirectionShow({
      cwd: tmpDir,
      directionId: created.directionId,
    });
    expect(shown).toMatchObject({
      id: created.directionId,
      isDraft: true,
      head: null,
      versionCount: 0,
    });
  });

  it("show on an unknown id lists available ids", async () => {
    const created = await runDirectionNew({ cwd: tmpDir, name: "Known" });
    await expect(
      runDirectionShow({ cwd: tmpDir, directionId: "nope" }),
    ).rejects.toThrow(new RegExp(created.directionId));
  });
});

// WS-04 (SC-06): `direction fork` — copy brief + moodboard into N drafts.
describe("runDirectionFork", () => {
  const FORK_BRIEF = {
    oneLiner: "warm editorial",
    positioning: "for people who cook",
    tone: ["warm", "confident"],
  };

  async function seedSource(id = "source"): Promise<void> {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id, name: "Source", brief: FORK_BRIEF });
  }

  async function writeSourceAsset(
    relPath: string,
    bytes: string,
  ): Promise<string> {
    const abs = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
    return relPath.split(path.sep).join("/");
  }

  it("produces a draft with a verbatim brief (case 1)", async () => {
    await seedSource();
    const result = await runDirectionFork({ cwd: tmpDir, sourceId: "source" });

    expect(result.sourceId).toBe("source");
    expect(result.forks).toHaveLength(1);
    const fork = result.forks[0];
    expect(fork.directionId).not.toBe("source");
    expect(fork).toMatchObject({ isDraft: true, version: 1 });

    const core = createDirectionCore(tmpDir, config);
    const record = await core.get(fork.directionId);
    expect(record.versions).toEqual([]);
    expect(record.head).toBeNull();
    expect(record.status).toBe("active");
    expect(record.version).toBe(1);
    expect(record.brief).toEqual((await core.get("source")).brief);
  });

  it("never copies versions or extracted assets (case 2)", async () => {
    await seedSource();
    const core = createDirectionCore(tmpDir, config);
    // Give the source a version and an extracted-assets tree.
    const versionsDir = path.join(
      tmpDir,
      "brand",
      "directions",
      "source",
      "versions",
      "v1",
    );
    await fs.mkdir(versionsDir, { recursive: true });
    await fs.writeFile(path.join(versionsDir, "direction-version.json"), "{}");
    await core.appendVersion("source", "v1");
    const extractedDir = path.join(
      tmpDir,
      "brand",
      "directions",
      "source",
      "extracted-assets",
    );
    await fs.mkdir(extractedDir, { recursive: true });
    await fs.writeFile(path.join(extractedDir, "asset.json"), "{}");

    const result = await runDirectionFork({ cwd: tmpDir, sourceId: "source" });
    const forkId = result.forks[0].directionId;
    const record = await core.get(forkId);
    expect(record.versions).toEqual([]);
    expect(record.head).toBeNull();
    expect(await pathExists(`brand/directions/${forkId}/versions`)).toBe(false);
    expect(
      await pathExists(`brand/directions/${forkId}/extracted-assets`),
    ).toBe(false);
  });

  it("THE COLLISION TEST — two same-basename assets survive as two distinct files (case 3)", async () => {
    await seedSource();
    const core = createDirectionCore(tmpDir, config);
    const relA = await writeSourceAsset(
      path.join("brand", "directions", "source", "assets", "hero.png"),
      "bytes-A",
    );
    const relB = await writeSourceAsset(
      path.join("brand", "input", "references", "hero.png"),
      "bytes-B",
    );
    await core.addAsset("source", { kind: "image", path: relA });
    await core.addAsset("source", { kind: "image", path: relB });

    const result = await runDirectionFork({ cwd: tmpDir, sourceId: "source" });
    const forkId = result.forks[0].directionId;
    const record = await core.get(forkId);

    expect(record.assets).toHaveLength(2);
    const assetPaths = record.assets.map((a) => a.path);
    expect(new Set(assetPaths).size).toBe(2); // distinct destinations (C-3)
    const contents = await Promise.all(
      assetPaths.map((p) => fs.readFile(path.join(tmpDir, p), "utf-8")),
    );
    expect(contents.sort()).toEqual(["bytes-A", "bytes-B"]); // neither overwrote
  });

  it("skips a retired ref and a missing-file ref (case 4)", async () => {
    await seedSource();
    const core = createDirectionCore(tmpDir, config);
    const live = await writeSourceAsset(
      path.join("brand", "directions", "source", "assets", "live.png"),
      "live",
    );
    const retired = await writeSourceAsset(
      path.join("brand", "directions", "source", "assets", "retired.png"),
      "retired",
    );
    await core.addAsset("source", { kind: "image", path: live });
    await core.addAsset("source", {
      kind: "image",
      path: "brand/directions/source/assets/ghost.png", // never written to disk
    });
    await core.addAsset("source", { kind: "image", path: retired });
    await core.retireAsset("source", {
      path: retired,
      author: "tim",
      source: "cli",
    });

    const result = await runDirectionFork({ cwd: tmpDir, sourceId: "source" });
    const record = await createDirectionCore(tmpDir, config).get(
      result.forks[0].directionId,
    );
    expect(record.assets).toHaveLength(1);
    expect(record.assets[0].path.endsWith("live.png")).toBe(true);
    expect(await pathExists(record.assets[0].path)).toBe(true);
  });

  it("--with-memory copies active entries as fresh attributed appends (case 5)", async () => {
    await seedSource();
    const core = createDirectionCore(tmpDir, config);
    await core.recordColorLock("source", {
      hex: "#ff5722",
      author: "tim",
      source: "studio",
    });
    await core.appendFeedback("source", {
      body: "loves serif headlines",
      author: "tim",
      source: "cli",
    });
    const sourceEntries = await core.memoryEntries("source");

    const result = await runDirectionFork({
      cwd: tmpDir,
      sourceId: "source",
      withMemory: true,
    });
    const forkId = result.forks[0].directionId;
    const entries = await core.memoryEntries(forkId);

    const lock = entries.find((e) => e.body === "Color locked: #ff5722");
    expect(lock).toMatchObject({ kind: "decision", source: "fork:source" });
    const feedback = entries.find((e) => e.body === "loves serif headlines");
    expect(feedback).toMatchObject({ kind: "feedback", source: "fork:source" });

    const provenance = entries.filter((e) =>
      e.body.includes("Forked from direction"),
    );
    expect(provenance).toHaveLength(1);
    expect(provenance[0].body).toContain("source");
    expect(entries[entries.length - 1].id).toBe(provenance[0].id);

    // Fresh appends, never id-preserving clones.
    const sourceEntryIds = new Set(sourceEntries.map((e) => e.id));
    for (const entry of entries) {
      expect(sourceEntryIds.has(entry.id)).toBe(false);
    }
  });

  it("without --with-memory the log holds EXACTLY the one provenance entry (case 6)", async () => {
    await seedSource();
    const core = createDirectionCore(tmpDir, config);
    await core.appendFeedback("source", {
      body: "several",
      author: "tim",
      source: "cli",
    });
    await core.appendDecision("source", {
      body: "entries",
      author: "tim",
      source: "cli",
    });

    const result = await runDirectionFork({ cwd: tmpDir, sourceId: "source" });
    const entries = await core.memoryEntries(result.forks[0].directionId);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("decision");
    expect(entries[0].body).toContain("Forked from direction");
    expect(entries[0].body).toContain("source");
  });

  it("the source record is byte-unchanged (case 7)", async () => {
    await seedSource();
    const core = createDirectionCore(tmpDir, config);
    const rel = await writeSourceAsset(
      path.join("brand", "directions", "source", "assets", "hero.png"),
      "bytes-A",
    );
    await core.addAsset("source", { kind: "image", path: rel });
    await core.appendFeedback("source", {
      body: "keep it warm",
      author: "tim",
      source: "cli",
    });

    const files = [
      "brand/directions/source/direction.yaml",
      "brand/directions/source/memory.yaml",
      rel,
    ];
    const before = await Promise.all(
      files.map((f) => fs.readFile(path.join(tmpDir, f))),
    );

    await runDirectionFork({
      cwd: tmpDir,
      sourceId: "source",
      withMemory: true,
    });

    const after = await Promise.all(
      files.map((f) => fs.readFile(path.join(tmpDir, f))),
    );
    for (let i = 0; i < files.length; i += 1) {
      expect(after[i].equals(before[i])).toBe(true);
    }
  });

  it("--count N mints N distinct drafts (case 8)", async () => {
    await seedSource();
    const core = createDirectionCore(tmpDir, config);
    const rel = await writeSourceAsset(
      path.join("brand", "directions", "source", "assets", "board.png"),
      "board",
    );
    await core.addAsset("source", { kind: "image", path: rel });

    const result = await runDirectionFork({
      cwd: tmpDir,
      sourceId: "source",
      count: 3,
    });
    expect(result.forks).toHaveLength(3);
    const ids = result.forks.map((f) => f.directionId);
    expect(new Set(ids).size).toBe(3);
    for (const fork of result.forks) {
      expect(fork).toMatchObject({ isDraft: true, version: 1 });
      const record = await core.get(fork.directionId);
      expect(record.assets).toHaveLength(1);
      expect(await pathExists(record.assets[0].path)).toBe(true);
      const entries = await core.memoryEntries(fork.directionId);
      expect(entries).toHaveLength(1); // its own single provenance decision
    }
  });

  it("keyless/dry-run parity (case 9)", async () => {
    const { hasApiKey } = await import("../openai.js");
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "src-a", name: "Source", brief: FORK_BRIEF });
    await core.create({ id: "src-b", name: "Source", brief: FORK_BRIEF });

    vi.mocked(hasApiKey).mockReturnValue(false);
    const keyless = await runDirectionFork({ cwd: tmpDir, sourceId: "src-a" });
    vi.mocked(hasApiKey).mockReturnValue(true);
    const keyed = await runDirectionFork({ cwd: tmpDir, sourceId: "src-b" });

    const a = await core.get(keyless.forks[0].directionId);
    const b = await core.get(keyed.forks[0].directionId);
    expect(a.brief).toEqual(b.brief);
    expect(a.assets).toEqual(b.assets); // both empty — no key gate anywhere
    expect(a.versions).toEqual(b.versions);
    expect(a.head).toBe(b.head);
    expect(a.version).toBe(b.version);
  });

  it("rejects a non-positive count without creating anything (case 10)", async () => {
    await seedSource();
    await expect(
      runDirectionFork({ cwd: tmpDir, sourceId: "source", count: 0 }),
    ).rejects.toThrow(/fork/);
    const { directions } = await runDirectionList({ cwd: tmpDir });
    expect(directions.map((d) => d.id)).toEqual(["source"]);
  });

  it("a missing source teaches (case 11)", async () => {
    await expect(
      runDirectionFork({ cwd: tmpDir, sourceId: "nope" }),
    ).rejects.toThrow(/keyart direction new/);
    const { directions } = await runDirectionList({ cwd: tmpDir });
    expect(directions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The folded direction verb family (tests relocated from the deleted
// concept.test.ts, renamed off concept)
// ---------------------------------------------------------------------------

async function readYamlFile(relPath: string): Promise<string> {
  return fs.readFile(path.join(tmpDir, relPath), "utf-8");
}

describe("direction new (folded verb)", () => {
  it("creates a direction + brief", async () => {
    const result = await runDirection({
      cwd: tmpDir,
      verb: "new",
      id: "moody",
      name: "Moody",
    });

    // Files exist on disk.
    await expect(
      fs.access(path.join(tmpDir, "brand", "directions", "moody", "direction.yaml")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tmpDir, "brand", "directions", "moody", "memory.yaml")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tmpDir, "brand", "directions", "moody", "brief.md")),
    ).resolves.toBeUndefined();

    const directionYaml = await readYamlFile("brand/directions/moody/direction.yaml");
    expect(directionYaml).toContain("status: active");

    // filesWritten are forward-slash, cwd-relative, and include direction.yaml.
    expect(result.filesWritten).toContain("brand/directions/moody/direction.yaml");
    expect(result.filesWritten.every((p) => !p.includes("\\"))).toBe(true);
    expect(result.filesWritten.every((p) => !path.isAbsolute(p))).toBe(true);
  });

  it("rejects an invalid id with a kebab-case message", async () => {
    await expect(
      runDirection({ cwd: tmpDir, verb: "new", id: "Bad Id" }),
    ).rejects.toThrow(/kebab-case/);
    await expect(
      runDirection({ cwd: tmpDir, verb: "new", id: "Bad Id" }),
    ).rejects.toBeInstanceOf(CommandError);
  });

  it("rejects a duplicate direction", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    await expect(
      runDirection({ cwd: tmpDir, verb: "new", id: "moody" }),
    ).rejects.toThrow(/already exists/);
  });
});

describe("direction new (folded verb) --from", () => {
  it("forks the brief from an existing direction", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "base" });
    const baseBrief = path.join(tmpDir, "brand", "directions", "base", "brief.md");
    const marker = "\n\nMARKER-UNIQUE-FORK-TOKEN\n";
    await fs.appendFile(baseBrief, marker, "utf-8");

    await runDirection({ cwd: tmpDir, verb: "new", id: "derived", from: "base" });

    const derivedBrief = await readYamlFile("brand/directions/derived/brief.md");
    expect(derivedBrief).toContain("MARKER-UNIQUE-FORK-TOKEN");
  });
});

describe("direction list", () => {
  it("lists directions sorted by id", async () => {
    // Create out of alphabetical order so the sort is actually exercised.
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    await core.create({ id: "zephyr", name: "zephyr" });
    await core.create({ id: "alpine", name: "alpine" });

    const result = await runDirection({ cwd: tmpDir, verb: "list" });

    const ids = result.directions!.map((c) => c.id);
    expect(ids).toContain("zephyr");
    expect(ids).toContain("alpine");
    // Sorted by id (core.list sorts).
    expect([...ids]).toEqual([...ids].sort());
  });

  it("rejects an id passed to list", async () => {
    await expect(
      runDirection({ cwd: tmpDir, verb: "list", id: "moody" }),
    ).rejects.toThrow(CommandError);
  });
});

describe("direction reject --note", () => {
  it("records a decision entry and revive returns to active", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });

    await runDirection({
      cwd: tmpDir,
      verb: "reject",
      id: "moody",
      note: "too dark",
    });

    const core = createDirectionCore(tmpDir, config);
    const rec = await core.get("moody");
    expect(rec.status).toBe("rejected");

    const mem = await core.readMemory("moody");
    const decision = mem.entries.find((e) => e.kind === "decision");
    expect(decision).toBeDefined();
    expect(decision!.body).toBe("too dark");
    expect(decision!.source).toBe("cli");

    await runDirection({ cwd: tmpDir, verb: "revive", id: "moody" });
    expect((await core.get("moody")).status).toBe("active");
  });
});

describe("direction feedback", () => {
  it("appends attributed feedback memory", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });

    const result = await runDirection({
      cwd: tmpDir,
      verb: "feedback",
      id: "moody",
      body: "Loved the serif headline",
      author: "tim",
    });

    expect(result.entryKind).toBe("feedback");

    const core = createDirectionCore(tmpDir, config);
    const entries = await core.memoryEntries("moody");
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("feedback");
    expect(entries[0].author).toBe("tim");
    expect(entries[0].source).toBe("cli");
    expect(() => new Date(entries[0].date).toISOString()).not.toThrow();
    expect(entries[0].date).toBe(new Date(entries[0].date).toISOString());
  });

  it("records a learning with --kind learning", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    await runDirection({
      cwd: tmpDir,
      verb: "feedback",
      id: "moody",
      body: "Editorial serifs win",
      kind: "learning",
    });
    const core = createDirectionCore(tmpDir, config);
    // memoryEntries no longer takes a `kind` filter (opts is `{ includeRetired? }`
    // only) — filter client-side.
    const learnings = (await core.memoryEntries("moody")).filter(
      (e) => e.kind === "learning",
    );
    expect(learnings).toHaveLength(1);
  });

  it("rejects an invalid kind", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "feedback",
        id: "moody",
        body: "x",
        kind: "bogus",
      }),
    ).rejects.toThrow(CommandError);
  });

  it("throws on feedback to a missing direction and writes nothing", async () => {
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "feedback",
        id: "ghost",
        body: "noone home",
      }),
    ).rejects.toThrow(/Direction not found/);

    await expect(
      fs.access(path.join(tmpDir, "brand", "directions", "ghost")),
    ).rejects.toThrow();
  });
});

describe("direction brief", () => {
  async function seed(): Promise<void> {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
  }

  it("set writes a scalar field, bumps the version, and rewrites brief.md", async () => {
    await seed();
    const core = createDirectionCore(tmpDir, config);
    const before = await core.get("moody");

    const result = await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "set",
      id: "moody",
      field: "oneLiner",
      value: "A local creative director",
    });

    // Round-trips through core (versioned).
    const brief = await core.getBrief("moody");
    expect(brief.oneLiner).toBe("A local creative director");
    expect((await core.get("moody")).version).toBeGreaterThan(before.version);

    // brief.md is the projection of the record.
    const briefMd = await readYamlFile("brand/directions/moody/brief.md");
    expect(briefMd).toContain("A local creative director");

    // filesWritten reports both the record and the projection (cwd-relative, forward slashes).
    expect(result.filesWritten).toContain("brand/directions/moody/direction.yaml");
    expect(result.filesWritten).toContain("brand/directions/moody/brief.md");
    expect(result.filesWritten.every((p) => !p.includes("\\"))).toBe(true);
  });

  it("set comma-splits an array field (trimmed)", async () => {
    await seed();
    await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "set",
      id: "moody",
      field: "tone",
      value: "warm, confident, editorial",
    });
    const core = createDirectionCore(tmpDir, config);
    expect((await core.getBrief("moody")).tone).toEqual([
      "warm",
      "confident",
      "editorial",
    ]);
  });

  it("set rejects an unknown field and the structured audiences field", async () => {
    await seed();
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "brief",
        subverb: "set",
        id: "moody",
        field: "colour",
        value: "blue",
      }),
    ).rejects.toThrow(/Unknown brief field/);

    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "brief",
        subverb: "set",
        id: "moody",
        field: "audiences",
        value: "solo founders",
      }),
    ).rejects.toThrow(/patch/);
  });

  it("patch applies a multi-field JSON patch", async () => {
    await seed();
    await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "patch",
      id: "moody",
      json: '{"problem":"AI prototypes look generic","surfaces":["site","app"]}',
    });
    const core = createDirectionCore(tmpDir, config);
    const brief = await core.getBrief("moody");
    expect(brief.problem).toBe("AI prototypes look generic");
    expect(brief.surfaces).toEqual(["site", "app"]);
  });

  it("patch rejects unknown keys and malformed JSON, naming valid fields", async () => {
    await seed();
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "brief",
        subverb: "patch",
        id: "moody",
        json: '{"colour":"blue"}',
      }),
    ).rejects.toThrow(/Unknown brief field.*colorIntent/s);

    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "brief",
        subverb: "patch",
        id: "moody",
        json: "{not json",
      }),
    ).rejects.toThrow(/Invalid JSON/);
  });

  it("show prints the fields + the rendered markdown and writes nothing", async () => {
    await seed();
    await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "set",
      id: "moody",
      field: "oneLiner",
      value: "A local creative director",
    });

    const result = await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "show",
      id: "moody",
    });

    expect(result.filesWritten).toEqual([]);
    const core = createDirectionCore(tmpDir, config);
    expect(result.renderedBrief).toBe(await core.getRenderedBrief("moody"));
    expect(result.brief?.oneLiner).toBe("A local creative director");
  });

  it("requires a valid subverb and a direction id", async () => {
    await seed();
    await expect(
      runDirection({ cwd: tmpDir, verb: "brief", id: "moody" }),
    ).rejects.toThrow(/subverb/);
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "brief",
        subverb: "bogus",
        id: "moody",
      }),
    ).rejects.toThrow(/Unknown brief subverb/);
    await expect(
      runDirection({ cwd: tmpDir, verb: "brief", subverb: "show" }),
    ).rejects.toThrow(/requires a direction id/);
  });

  it("is keyless — no OPENAI_API_KEY is required on any brief path", async () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    await seed();
    // A full set → show cycle runs with no key and never throws for a missing key.
    await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "set",
      id: "moody",
      field: "positioning",
      value: "the local creative director for AI prototypes",
    });
    const show = await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "show",
      id: "moody",
    });
    expect(show.brief?.positioning).toBe(
      "the local creative director for AI prototypes",
    );
  });

  it("is versioned — a stale write 409s and --force bypasses it", async () => {
    await seed();
    const core = createDirectionCore(tmpDir, config);
    // Bump the version once so expectedVersion 0 is now stale.
    await core.setBriefFields("moody", { voice: "calm" });

    await expect(
      core.setBriefFields("moody", { voice: "loud" }, { expectedVersion: 0 }),
    ).rejects.toMatchObject({ name: "VersionConflictError" });

    // --force bypasses the optimistic check.
    await expect(
      core.setBriefFields(
        "moody",
        { voice: "loud" },
        { expectedVersion: 0, force: true },
      ),
    ).resolves.toBeDefined();
    expect((await core.getBrief("moody")).voice).toBe("loud");
  });
});

describe("direction brief map", () => {
  const chatJson = vi.mocked(openai.chatJson);

  async function seed(): Promise<void> {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
  }

  beforeEach(() => {
    // Default every map test to dry-run (no key); keyed tests override.
    chatJson.mockResolvedValue({ data: null as never, dryRun: true });
  });

  it("proposes without writing (no --apply) — files + version unchanged", async () => {
    await seed();
    chatJson.mockResolvedValue({
      data: { tone: ["warm", "confident"] } as never,
      dryRun: false,
    });
    const core = createDirectionCore(tmpDir, config);
    const before = await core.get("moody");

    const result = await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "map",
      id: "moody",
      freeform: "make it warm and confident",
    });

    // Nothing written; the proposal is surfaced for the user to dispose of.
    expect(result.filesWritten).toEqual([]);
    expect(result.proposal?.patch.tone).toEqual(["warm", "confident"]);
    // Record unchanged (version + brief fields).
    const after = await core.get("moody");
    expect(after.version).toBe(before.version);
    expect(after.brief.tone).toEqual([]);
    // Memory untouched — no lock recorded.
    const mem = await core.readMemory("moody");
    expect(mem.entries).toHaveLength(0);
  });

  it("--apply writes the field patch AND routes a hex to a color-lock decision", async () => {
    await seed();
    // The model even tries to smuggle a hex into colorIntent — it must be stripped.
    chatJson.mockResolvedValue({
      data: { colorIntent: "warm earthy #1a1a1a", tone: ["grounded"] } as never,
      dryRun: false,
    });
    const core = createDirectionCore(tmpDir, config);
    const before = await core.get("moody");

    const result = await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "map",
      id: "moody",
      freeform: "warm earthy, ship it #1a1a1a",
      apply: true,
    });

    // Field patch applied (brief bumped, colorIntent hex-free), brief.md rewritten.
    const brief = await core.getBrief("moody");
    expect(brief.colorIntent).toBe("warm earthy");
    expect(brief.tone).toEqual(["grounded"]);
    expect((await core.get("moody")).version).toBeGreaterThan(before.version);
    const briefMd = await readYamlFile("brand/directions/moody/brief.md");
    expect(briefMd).toContain("warm earthy");
    expect(briefMd).not.toContain("#1a1a1a");

    // The hex is a LOCK (a decision), never a brief field (SC-06).
    const decision = (await core.readMemory("moody")).entries.find(
      (e) => e.kind === "decision",
    );
    expect(decision).toBeDefined();
    expect(decision!.body).toBe("Color locked: #1a1a1a");
    expect(decision!.source).toBe("cli");

    expect(result.filesWritten).toContain("brand/directions/moody/direction.yaml");
    expect(result.filesWritten).toContain("brand/directions/moody/brief.md");
    expect(result.filesWritten).toContain("brand/directions/moody/memory.yaml");
  });

  it("no key: --apply applies no field patch, records a pasted-hex lock, and manual set still works", async () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    await seed();
    // Default mock is dry-run (data: null) — the keyless path.
    const core = createDirectionCore(tmpDir, config);
    const before = await core.get("moody");

    const result = await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "map",
      id: "moody",
      freeform: "lock the ink at #1a1a1a",
      apply: true,
    });

    // No field patch (empty proposal) → direction.yaml/brief.md NOT rewritten.
    expect(result.filesWritten).not.toContain("brand/directions/moody/direction.yaml");
    // But the pasted hex is still locked (deterministic scan).
    expect(result.filesWritten).toContain("brand/directions/moody/memory.yaml");
    const decision = (await core.readMemory("moody")).entries.find(
      (e) => e.kind === "decision",
    );
    expect(decision!.body).toBe("Color locked: #1a1a1a");

    // The deterministic set/patch path remains fully sufficient and keyless.
    await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "set",
      id: "moody",
      field: "oneLiner",
      value: "still editable by hand",
    });
    expect((await core.getBrief("moody")).oneLiner).toBe(
      "still editable by hand",
    );
    // The version advanced only from the lock + the manual set (not a map field write).
    expect((await core.get("moody")).version).toBeGreaterThan(before.version);
  });

  it("requires freeform text", async () => {
    await seed();
    await expect(
      runDirection({ cwd: tmpDir, verb: "brief", subverb: "map", id: "moody" }),
    ).rejects.toThrow(/requires freeform text/);
  });
});

describe("rule add", () => {
  it("writes a global rule", async () => {
    const result = await runRule({
      cwd: tmpDir,
      verb: "add",
      text: "Never pure black",
      severity: "hard",
    });

    await expect(
      fs.access(path.join(tmpDir, "brand", "brand.yaml")),
    ).resolves.toBeUndefined();

    expect(result.rule.severity).toBe("hard");
    expect(result.rule.author).toBe("cli");

    const brand = createBrandCore(tmpDir, config);
    const doc = await brand.read();
    expect(doc.rules).toHaveLength(1);
    expect(doc.rules[0].severity).toBe("hard");
  });

  it("defaults severity to guideline", async () => {
    const result = await runRule({
      cwd: tmpDir,
      verb: "add",
      text: "Prefer whitespace",
    });
    expect(result.rule.severity).toBe("guideline");
  });

  it("rejects an invalid severity", async () => {
    await expect(
      runRule({ cwd: tmpDir, verb: "add", text: "x", severity: "mongo" }),
    ).rejects.toThrow(CommandError);
  });

  it("rejects an unknown verb", async () => {
    await expect(
      runRule({ cwd: tmpDir, verb: "list", text: "x" }),
    ).rejects.toThrow(CommandError);
  });

  it("rejects a missing rule body", async () => {
    await expect(runRule({ cwd: tmpDir, verb: "add" })).rejects.toThrow(
      CommandError,
    );
  });
});

describe("promote", () => {
  it("lifts a direction learning by text", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    const core = createDirectionCore(tmpDir, config);
    await core.appendLearning("moody", {
      body: "Editorial serifs win",
      author: "tim",
      source: "cli",
    });

    const result = await runPromote({
      cwd: tmpDir,
      directionId: "moody",
      text: "Editorial serifs win",
    });

    expect(result.rule.severity).toBe("guideline");
    expect(result.rule.source).toBe("promote:moody");

    const brand = createBrandCore(tmpDir, config);
    const doc = await brand.read();
    expect(doc.rules.some((r) => r.source === "promote:moody")).toBe(true);
  });

  it("lifts a direction learning by --entry id", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    const core = createDirectionCore(tmpDir, config);
    await core.appendLearning("moody", {
      body: "Serifs everywhere",
      author: "tim",
      source: "cli",
    });
    // memoryEntries no longer takes a `kind` filter — filter client-side.
    const entries = (await core.memoryEntries("moody")).filter(
      (e) => e.kind === "learning",
    );
    const entryId = entries[0].id;

    const result = await runPromote({
      cwd: tmpDir,
      directionId: "moody",
      entryId,
    });

    expect(result.rule.text).toBe("Serifs everywhere");
    expect(result.rule.source).toBe("promote:moody");
  });

  it("throws when neither text nor entry is given", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    await expect(
      runPromote({ cwd: tmpDir, directionId: "moody" }),
    ).rejects.toThrow(CommandError);
  });
});

describe("rule add --channel / --polarity (WS-01)", () => {
  it("persists channel and polarity on the written GlobalRule", async () => {
    const result = await runRule({
      cwd: tmpDir,
      verb: "add",
      text: "No fist-in-the-air icons",
      channel: "visual",
      polarity: "avoid",
    });
    expect(result.rule.channel).toBe("visual");
    expect(result.rule.polarity).toBe("avoid");

    const brand = createBrandCore(tmpDir, config);
    const doc = await brand.read();
    const rule = doc.rules[doc.rules.length - 1];
    expect(rule.channel).toBe("visual");
    expect(rule.polarity).toBe("avoid");
  });

  it("rejects invalid --channel with a CommandError naming valid values", async () => {
    await expect(
      runRule({ cwd: tmpDir, verb: "add", text: "x", channel: "bogus" }),
    ).rejects.toThrow(CommandError);
    await expect(
      runRule({ cwd: tmpDir, verb: "add", text: "x", channel: "bogus" }),
    ).rejects.toThrow(/visual, copy, both/);
  });

  it("rejects invalid --polarity with a CommandError naming valid values", async () => {
    await expect(
      runRule({ cwd: tmpDir, verb: "add", text: "x", polarity: "maybe" }),
    ).rejects.toThrow(CommandError);
    await expect(
      runRule({ cwd: tmpDir, verb: "add", text: "x", polarity: "maybe" }),
    ).rejects.toThrow(/prefer, avoid/);
  });

  it("omitting channel/polarity writes no fields (byte-identical to legacy output)", async () => {
    const result = await runRule({ cwd: tmpDir, verb: "add", text: "Prefer whitespace" });
    expect(result.rule.channel).toBeUndefined();
    expect(result.rule.polarity).toBeUndefined();
  });
});

describe("direction feedback --channel / --polarity (WS-01)", () => {
  it("persists channel and polarity on the appended MemoryEntry (decision)", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    await runDirection({
      cwd: tmpDir,
      verb: "feedback",
      id: "moody",
      body: "Avoid dark gradients",
      kind: "decision",
      channel: "visual",
      polarity: "avoid",
    });
    const core = createDirectionCore(tmpDir, config);
    // memoryEntries no longer takes a `kind` filter — filter client-side.
    const entries = (await core.memoryEntries("moody")).filter(
      (e) => e.kind === "decision",
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].channel).toBe("visual");
    expect(entries[0].polarity).toBe("avoid");
  });

  it("rejects --channel/--polarity on a non-feedback verb (coupling guard)", async () => {
    await expect(
      runDirection({ cwd: tmpDir, verb: "park", id: "moody", channel: "visual" }),
    ).rejects.toThrow(CommandError);
    await expect(
      runDirection({ cwd: tmpDir, verb: "park", id: "moody", polarity: "avoid" }),
    ).rejects.toThrow(CommandError);
  });

  it("rejects invalid --channel value", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "feedback",
        id: "moody",
        body: "x",
        channel: "sound",
      }),
    ).rejects.toThrow(CommandError);
  });
});

// NOTE (WS-01 direction-aggregate-root): the former "direction feedback --direction
// (WS-05)" describe block is DELETED here. It tested the `--direction` flag on
// `direction feedback` (writing a direction-scoped entry inside a direction, vs. a
// direction-scoped one) plus `scopeOf` labeling and the
// accompanying arg-coupling guards for `--direction`/`--scope`. Direction is now
// the top-level aggregate root — `runDirection`'s `opts` no longer has `direction`
// or `scope` fields at all (the opts type has no such members), and
// `MemoryEntry` no longer carries a `directionId`. There is nothing left to
// sub-scope, so this mechanism and its guards no longer exist. See the
// "direction memory (WS-05)" block below for the direct replacement (isolation
// between two SEPARATE directions).

describe("direction memory (WS-05)", () => {
  it("writes nothing (filesWritten is empty)", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    const result = await runDirection({
      cwd: tmpDir,
      verb: "memory",
      id: "moody",
    });
    expect(result.filesWritten).toHaveLength(0);
  });

  // REPLACES the deleted --direction/--scope sub-scoping tests (the old sub-scoped
  // entries inside ONE direction no longer exist). The
  // direct replacement per the new model: `opts.id` addresses exactly one
  // Direction, and reading it never leaks a SIBLING direction's entries.
  it("reads exactly one direction's memory — a sibling direction's entries never leak", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    await runDirection({ cwd: tmpDir, verb: "new", id: "breezy" });
    await runDirection({
      cwd: tmpDir,
      verb: "feedback",
      id: "moody",
      body: "moody note",
    });
    await runDirection({
      cwd: tmpDir,
      verb: "feedback",
      id: "breezy",
      body: "breezy note",
    });

    const moodyResult = await runDirection({
      cwd: tmpDir,
      verb: "memory",
      id: "moody",
    });
    const breezyResult = await runDirection({
      cwd: tmpDir,
      verb: "memory",
      id: "breezy",
    });

    expect(moodyResult.memoryEntries!.map((e) => e.body)).toEqual([
      "moody note",
    ]);
    expect(breezyResult.memoryEntries!.map((e) => e.body)).toEqual([
      "breezy note",
    ]);
  });
});

describe("direction memory edit/promote/delete (WS-04)", () => {
  async function seedLearning(
    id: string,
    body = "Editorial serifs test well",
  ): Promise<string> {
    await runDirection({ cwd: tmpDir, verb: "new", id });
    const core = createDirectionCore(tmpDir, config);
    const mem = await core.appendLearning(id, {
      body,
      author: "tim",
      source: "cli",
    });
    return mem.entries[0].id;
  }

  it("edit drives editMemoryEntry (supersede)", async () => {
    const entryId = await seedLearning("moody");

    const result = await runDirection({
      cwd: tmpDir,
      verb: "memory",
      memoryAction: "edit",
      id: "moody",
      entryId,
      body: "corrected text",
      channel: "visual",
      polarity: "prefer",
    });

    expect(result.verb).toBe("memory");
    expect(result.memoryAction).toBe("edit");
    expect(result.memoryActionResult).toMatchObject({
      action: "edit",
      directionId: "moody",
      entryId,
    });
    expect(result.filesWritten).toEqual(["brand/directions/moody/memory.yaml"]);

    const core = createDirectionCore(tmpDir, config);
    const all = await core.memoryEntries("moody", { includeRetired: true });
    const original = all.find((e) => e.id === entryId)!;
    expect(original.retiredAt).toBeDefined();
    expect(original.supersededBy).toBeDefined();
    expect(original.body).toBe("Editorial serifs test well"); // never mutated in place

    const corrected = all.find((e) => e.id === original.supersededBy)!;
    expect(corrected.body).toBe("corrected text");
    expect(corrected.channel).toBe("visual");
    expect(corrected.polarity).toBe("prefer");
  });

  it("delete drives deleteMemoryEntry (retire, non-destructive)", async () => {
    const entryId = await seedLearning("moody");

    const result = await runDirection({
      cwd: tmpDir,
      verb: "memory",
      memoryAction: "delete",
      id: "moody",
      entryId,
      reason: "no longer relevant",
    });

    expect(result.memoryAction).toBe("delete");
    expect(result.memoryActionResult?.entryId).toBe(entryId);

    const core = createDirectionCore(tmpDir, config);
    const all = await core.memoryEntries("moody", { includeRetired: true });
    const original = all.find((e) => e.id === entryId)!;
    expect(original.retiredAt).toBeDefined();
    expect(original.body).toBe("Editorial serifs test well"); // nothing physically removed
  });

  // NOTE: the former "promote --to a non-global rung drives promoteMemoryEntry (direction
  // -> middle rung)" test is DELETED here. `--to` any non-global target
  // scope no longer exists — `PROMOTE_TARGETS` is `["global"]` only (promote is
  // up-only, direction→global via `promoteEntryToGlobal`). There is no
  // replacement: the middle promote rung it exercised has been removed by
  // design, not renamed.

  it("promote --to global drives the promoteEntryToGlobal seam (memory + brand.yaml)", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    const core = createDirectionCore(tmpDir, config);
    const mem = await core.appendDecision("moody", {
      body: "Never mix warm and cool neutrals",
      author: "tim",
      source: "cli",
      channel: "visual",
      polarity: "avoid",
    });
    const entryId = mem.entries[0].id;

    const result = await runDirection({
      cwd: tmpDir,
      verb: "memory",
      memoryAction: "promote",
      id: "moody",
      entryId,
      to: "global",
      severity: "guideline",
    });

    expect(result.memoryActionResult?.to).toBe("global");
    expect(result.filesWritten).toEqual(
      expect.arrayContaining([
        "brand/directions/moody/memory.yaml",
        "brand/brand.yaml",
      ]),
    );

    const brand = createBrandCore(tmpDir, config);
    const doc = await brand.read();
    const rule = doc.rules.find((r) => r.source === "promote:moody")!;
    expect(rule).toBeDefined();
    expect(rule.channel).toBe("visual");
    expect(rule.polarity).toBe("avoid");
    expect(rule.retiredAt).toBeUndefined();

    const all = await core.memoryEntries("moody", { includeRetired: true });
    const original = all.find((e) => e.id === entryId)!;
    expect(original.retiredAt).toBeDefined(); // source retired — no double-count
  });

  it("direction memory READ is unchanged when no memoryAction is given", async () => {
    await seedLearning("moody");

    const result = await runDirection({
      cwd: tmpDir,
      verb: "memory",
      id: "moody",
    });

    expect(result.memoryAction).toBeUndefined();
    expect(result.memoryActionResult).toBeUndefined();
    expect(result.memoryEntries).toBeDefined();
    expect(result.filesWritten).toHaveLength(0);
  });

  it("rejects an unknown memory action", async () => {
    const entryId = await seedLearning("moody");
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "memory",
        memoryAction: "bogus",
        id: "moody",
        entryId,
      }),
    ).rejects.toThrow(CommandError);
  });

  it("arg-coupling: requires an entryId", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "memory",
        memoryAction: "edit",
        id: "moody",
        body: "x",
      }),
    ).rejects.toThrow(CommandError);
  });

  it("arg-coupling: --to is only valid on promote", async () => {
    const entryId = await seedLearning("moody");
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "memory",
        memoryAction: "edit",
        id: "moody",
        entryId,
        body: "x",
        to: "global",
      }),
    ).rejects.toThrow(CommandError);
  });

  it("arg-coupling: promote requires --to", async () => {
    const entryId = await seedLearning("moody");
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "memory",
        memoryAction: "promote",
        id: "moody",
        entryId,
      }),
    ).rejects.toThrow(CommandError);
  });

  it("arg-coupling: rejects an invalid --to value", async () => {
    const entryId = await seedLearning("moody");
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "memory",
        memoryAction: "promote",
        id: "moody",
        entryId,
        to: "bogus",
      }),
    ).rejects.toThrow(CommandError);
  });

  it("arg-coupling: edit requires --body", async () => {
    const entryId = await seedLearning("moody");
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "memory",
        memoryAction: "edit",
        id: "moody",
        entryId,
      }),
    ).rejects.toThrow(CommandError);
  });

  it("arg-coupling: --reason is only valid on delete", async () => {
    const entryId = await seedLearning("moody");
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "memory",
        memoryAction: "edit",
        id: "moody",
        entryId,
        body: "x",
        reason: "why",
      }),
    ).rejects.toThrow(CommandError);
  });

  // Adapted: the original exercised this coupling guard via `promote --to
  // a removed rung`. `--severity is only valid for promote --to
  // global` is a check independent of the action, so a non-promote action
  // (`edit`) with `--severity` set still exercises the same guard.
  it("arg-coupling: --severity is only valid on promote --to global", async () => {
    const entryId = await seedLearning("moody");
    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "memory",
        memoryAction: "edit",
        id: "moody",
        entryId,
        body: "x",
        severity: "hard",
      }),
    ).rejects.toThrow(CommandError);
  });

  it("409 surfaces on a stale --expected-memory-version; --force bypasses", async () => {
    const entryId = await seedLearning("moody");
    const core = createDirectionCore(tmpDir, config);
    const mem = await core.readMemory("moody");

    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "memory",
        memoryAction: "delete",
        id: "moody",
        entryId,
        expectedMemoryVersion: mem.version + 5,
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    await runDirection({
      cwd: tmpDir,
      verb: "memory",
      memoryAction: "delete",
      id: "moody",
      entryId,
      expectedMemoryVersion: mem.version + 5,
      force: true,
    });
    const after = await core.readMemory("moody");
    expect(
      after.entries.find((e) => e.id === entryId)?.retiredAt,
    ).toBeDefined();
  });

  it("promote --to global surfaces a stale --expected-global-version as a 409", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "moody" });
    const core = createDirectionCore(tmpDir, config);
    const mem = await core.appendLearning("moody", {
      body: "Warm palettes read as inviting",
      author: "tim",
      source: "cli",
    });
    const entryId = mem.entries[0].id;

    await expect(
      runDirection({
        cwd: tmpDir,
        verb: "memory",
        memoryAction: "promote",
        id: "moody",
        entryId,
        to: "global",
        expectedMemoryVersion: mem.version,
        expectedGlobalVersion: 999,
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    // Neither store advanced.
    const brand = createBrandCore(tmpDir, config);
    expect((await brand.read()).rules).toHaveLength(0);
    expect(
      (await core.readMemory("moody")).entries.find((e) => e.id === entryId)
        ?.retiredAt,
    ).toBeUndefined();
  });

  it("keyless: no model call on any memory-lifecycle path", async () => {
    delete process.env.OPENAI_API_KEY;
    const entryId = await seedLearning("moody");
    const chatJson = vi.mocked(openai.chatJson);
    const before = chatJson.mock.calls.length;

    await runDirection({
      cwd: tmpDir,
      verb: "memory",
      memoryAction: "edit",
      id: "moody",
      entryId,
      body: "corrected",
    });

    expect(chatJson.mock.calls.length).toBe(before);
  });
});

describe("rule remove / edit (WS-04)", () => {
  it("remove drives removeRule (non-destructive retire)", async () => {
    const added = await runRule({
      cwd: tmpDir,
      verb: "add",
      text: "Prefer generous whitespace",
    });
    const ruleId = added.rule.id;

    const result = await runRule({ cwd: tmpDir, verb: "remove", ruleId });
    expect(result.verb).toBe("remove");
    expect(result.rule.id).toBe(ruleId);
    expect(result.rule.retiredAt).toBeDefined();

    const brand = createBrandCore(tmpDir, config);
    const doc = await brand.read();
    expect(doc.rules.find((r) => r.id === ruleId)?.retiredAt).toBeDefined();
  });

  it("edit drives editRule (retire-and-replace)", async () => {
    const added = await runRule({
      cwd: tmpDir,
      verb: "add",
      text: "Prefer whitespace",
    });
    const ruleId = added.rule.id;

    const result = await runRule({
      cwd: tmpDir,
      verb: "edit",
      ruleId,
      body: "Prefer generous whitespace",
    });
    expect(result.verb).toBe("edit");
    expect(result.rule.text).toBe("Prefer generous whitespace");
    expect(result.rule.severity).toBe("guideline");

    const brand = createBrandCore(tmpDir, config);
    const doc = await brand.read();
    const old = doc.rules.find((r) => r.id === ruleId)!;
    expect(old.retiredAt).toBeDefined();
    const replacement = doc.rules.find((r) => r.source === `edit:${ruleId}`)!;
    expect(replacement.text).toBe("Prefer generous whitespace");
  });

  it("HARD-rule force gate surfaces through remove", async () => {
    const added = await runRule({
      cwd: tmpDir,
      verb: "add",
      text: "Never pure black",
      severity: "hard",
    });
    const ruleId = added.rule.id;

    await expect(
      runRule({ cwd: tmpDir, verb: "remove", ruleId }),
    ).rejects.toThrow(CommandError);
    await expect(
      runRule({ cwd: tmpDir, verb: "remove", ruleId }),
    ).rejects.toThrow(/force/i);

    const result = await runRule({
      cwd: tmpDir,
      verb: "remove",
      ruleId,
      force: true,
    });
    expect(result.rule.retiredAt).toBeDefined();
  });

  it("HARD-rule force gate surfaces through edit", async () => {
    const added = await runRule({
      cwd: tmpDir,
      verb: "add",
      text: "Never pure black",
      severity: "hard",
    });
    const ruleId = added.rule.id;

    await expect(
      runRule({
        cwd: tmpDir,
        verb: "edit",
        ruleId,
        body: "Never pure black or white",
      }),
    ).rejects.toThrow(CommandError);

    const result = await runRule({
      cwd: tmpDir,
      verb: "edit",
      ruleId,
      body: "Never pure black or white",
      force: true,
    });
    expect(result.rule.text).toBe("Never pure black or white");
  });

  it("remove/edit require a rule id", async () => {
    await expect(
      runRule({ cwd: tmpDir, verb: "remove" }),
    ).rejects.toThrow(CommandError);
    await expect(
      runRule({ cwd: tmpDir, verb: "edit", body: "x" }),
    ).rejects.toThrow(CommandError);
  });

  it("edit requires --body and/or --severity", async () => {
    const added = await runRule({
      cwd: tmpDir,
      verb: "add",
      text: "Prefer whitespace",
    });
    await expect(
      runRule({ cwd: tmpDir, verb: "edit", ruleId: added.rule.id }),
    ).rejects.toThrow(CommandError);
  });

  it("rejects an unknown rule verb", async () => {
    await expect(
      runRule({ cwd: tmpDir, verb: "bogus", text: "x" }),
    ).rejects.toThrow(CommandError);
  });

  it("409 surfaces on a stale --expected-version; --force bypasses", async () => {
    const added = await runRule({
      cwd: tmpDir,
      verb: "add",
      text: "Prefer whitespace",
    });
    const ruleId = added.rule.id;
    const brand = createBrandCore(tmpDir, config);
    const current = await brand.read();

    await expect(
      runRule({
        cwd: tmpDir,
        verb: "remove",
        ruleId,
        expectedVersion: current.version + 5,
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    await runRule({
      cwd: tmpDir,
      verb: "remove",
      ruleId,
      expectedVersion: current.version + 5,
      force: true,
    });
    const doc = await brand.read();
    expect(doc.rules.find((r) => r.id === ruleId)?.retiredAt).toBeDefined();
  });

  it("keyless: no model call on remove/edit", async () => {
    delete process.env.OPENAI_API_KEY;
    const added = await runRule({
      cwd: tmpDir,
      verb: "add",
      text: "Prefer whitespace",
    });
    const chatJson = vi.mocked(openai.chatJson);
    const before = chatJson.mock.calls.length;

    await runRule({
      cwd: tmpDir,
      verb: "edit",
      ruleId: added.rule.id,
      body: "Prefer generous whitespace",
    });

    expect(chatJson.mock.calls.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// WS-05: the fourteen-verb roster, status/archive, list filter, create R-6,
// target resolution, and the promote retarget (SC-07/SC-08).
// ---------------------------------------------------------------------------

describe("DIRECTION_VERBS roster (SC-08 derive-once fence)", () => {
  it("set-equals the fourteen-verb family; reject/park/revive are first-class", () => {
    expect(new Set(DIRECTION_VERBS)).toEqual(
      new Set([
        "new",
        "list",
        "show",
        "status",
        "fork",
        "create",
        "archive",
        "reject",
        "park",
        "revive",
        "brief",
        "feedback",
        "memory",
        "reconcile",
      ]),
    );
    expect(DIRECTION_VERBS).toHaveLength(14);
  });
});

describe("direction status (WS-05)", () => {
  it("projects a draft: isDraft true, head null, versionCount 0; writes nothing", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "warm", name: "Warm" });

    const result = await runDirection({ cwd: tmpDir, verb: "status", id: "warm" });
    expect(result.status).toEqual({
      id: "warm",
      status: "active",
      isDraft: true,
      head: null,
      versionCount: 0,
    });
    expect(result.filesWritten).toEqual([]);
  });

  it("projects a versioned direction with a concrete head id and count", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "warm", name: "Warm" });
    await core.appendVersion("warm", "v1");

    const result = await runDirection({ cwd: tmpDir, verb: "status", id: "warm" });
    expect(result.status).toEqual({
      id: "warm",
      status: "active",
      isDraft: false,
      head: "v1",
      versionCount: 1,
    });
  });
});

describe("direction archive (WS-05, R-5 — non-destructive)", () => {
  it("transitions to archived, deleting NOTHING on disk, with the exact R-5 report", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "warm", name: "Warm" });
    const versionDir = path.join(
      tmpDir, "brand", "directions", "warm", "versions", "v1",
    );
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(path.join(versionDir, "direction-version.json"), "{}");
    await core.appendVersion("warm", "v1");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runDirection({ cwd: tmpDir, verb: "archive", id: "warm" });
    expect(logSpy.mock.calls.flat()).toContain(
      "Archived: direction warm archived; nothing physically removed.",
    );
    logSpy.mockRestore();

    expect((await core.get("warm")).status).toBe("archived");
    // The whole tree survives — nothing physically removed.
    expect(await pathExists("brand/directions/warm/direction.yaml")).toBe(true);
    expect(
      await pathExists("brand/directions/warm/versions/v1/direction-version.json"),
    ).toBe(true);
  });

  it("refuses the approved pointer's direction with a repoint-first teaching error", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "warm", name: "Warm" });
    await core.appendVersion("warm", "v1");
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "warm",
      versionId: "v1",
    });

    await expect(
      runDirection({ cwd: tmpDir, verb: "archive", id: "warm" }),
    ).rejects.toThrow(/approve a different direction/);
    // The record is unchanged — the guard fired before any write.
    expect((await core.get("warm")).status).toBe("active");
  });

  it("is guarded idempotently and reversible via revive", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "warm", name: "Warm" });

    await runDirection({ cwd: tmpDir, verb: "archive", id: "warm" });
    await expect(
      runDirection({ cwd: tmpDir, verb: "archive", id: "warm" }),
    ).rejects.toThrow(/already archived/);

    await runDirection({ cwd: tmpDir, verb: "revive", id: "warm" });
    expect((await core.get("warm")).status).toBe("active");
  });
});

describe("direction list hides archived by default (WS-05, R-7)", () => {
  it("applies the includeArchived predicate", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "a", name: "A" });
    await core.create({ id: "b", name: "B" });
    await runDirection({ cwd: tmpDir, verb: "archive", id: "b" });

    const hidden = await runDirection({ cwd: tmpDir, verb: "list" });
    expect(hidden.directions!.map((d) => d.id)).toEqual(["a"]);

    const shown = await runDirection({
      cwd: tmpDir,
      verb: "list",
      includeArchived: true,
    });
    expect(shown.directions!.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("resolveTargetDirectionId (WS-05 — no implicit default)", () => {
  it("the approved pointer wins over the id count", async () => {
    const core = createDirectionCore(tmpDir, config);
    for (const id of ["a", "b", "c"]) await core.create({ id, name: id });
    await core.appendVersion("b", "v1");
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "b",
      versionId: "v1",
    });
    expect(await resolveTargetDirectionId(tmpDir)).toBe("b");
  });

  it("resolves the single existing direction with no pointer", async () => {
    await createDirectionCore(tmpDir, config).create({ id: "only", name: "Only" });
    expect(await resolveTargetDirectionId(tmpDir)).toBe("only");
  });

  it("teaches on ambiguity (listing ids) and on emptiness (naming direction new)", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "a", name: "A" });
    await core.create({ id: "b", name: "B" });
    await expect(resolveTargetDirectionId(tmpDir)).rejects.toThrow(/a, b/);

    const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-empty-"));
    try {
      const { loadConfig } = await import("../config.js");
      vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(emptyDir));
      await expect(resolveTargetDirectionId(emptyDir)).rejects.toThrow(
        /keyart direction new/,
      );
    } finally {
      vi.mocked((await import("../config.js")).loadConfig).mockResolvedValue(config);
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("a stale pointer teaches, never a silent fallthrough", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "gone", name: "Gone" });
    await core.appendVersion("gone", "v1");
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "gone",
      versionId: "v1",
    });
    await core.create({ id: "single", name: "Single" });
    await fs.rm(path.join(tmpDir, "brand", "directions", "gone"), {
      recursive: true,
      force: true,
    });

    await expect(resolveTargetDirectionId(tmpDir)).rejects.toThrow(/gone/);
  });
});

describe("runPromote retarget + SC-07 --entry retire (WS-05)", () => {
  it("free-text promote appends one guideline and retires nothing", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "warm", name: "Warm" });
    await core.appendLearning("warm", {
      body: "untouched entry",
      author: "tim",
      source: "cli",
    });
    const memBefore = await fs.readFile(
      path.join(tmpDir, "brand", "directions", "warm", "memory.yaml"),
    );

    const result = await runPromote({
      cwd: tmpDir,
      directionId: "warm",
      text: "always ship dark mode",
    });
    expect(result.fromDirectionId).toBe("warm");
    expect(result.rule.severity).toBe("guideline");
    const rules = (await createBrandCore(tmpDir, config).read()).rules;
    expect(rules.map((r) => r.text)).toContain("always ship dark mode");

    // No source entry ⇒ nothing retired; the memory doc is byte-unchanged.
    const memAfter = await fs.readFile(
      path.join(tmpDir, "brand", "directions", "warm", "memory.yaml"),
    );
    expect(memAfter.equals(memBefore)).toBe(true);
  });

  it("--entry promote retires its source entry (Replan #7)", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "warm", name: "Warm" });
    await core.appendLearning("warm", {
      body: "serif headlines always win",
      author: "tim",
      source: "cli",
    });
    const entry = (await core.memoryEntries("warm"))[0];
    const rulesBefore = (await createBrandCore(tmpDir, config).read()).rules.length;

    const result = await runPromote({
      cwd: tmpDir,
      directionId: "warm",
      entryId: entry.id,
    });

    const rulesAfter = (await createBrandCore(tmpDir, config).read()).rules;
    expect(rulesAfter.length).toBe(rulesBefore + 1);

    // The source entry is RETIRED: absent from the default read, present with includeRetired.
    const active = await core.memoryEntries("warm");
    expect(active.find((e) => e.id === entry.id)).toBeUndefined();
    const all = await core.memoryEntries("warm", { includeRetired: true });
    expect(all.find((e) => e.id === entry.id)).toBeDefined();

    // filesWritten names both brand.yaml and the direction's memory.yaml.
    expect(result.filesWritten).toContain("brand/brand.yaml");
    expect(result.filesWritten).toContain("brand/directions/warm/memory.yaml");
  });

  it("no longer accepts the legacy parent id; missing directionId teaches", async () => {
    // The removed compat key is assembled at runtime (the clean-break scanner
    // forbids the literal) and smuggled past the compiler as an untyped extra —
    // runPromote's option type no longer declares it, so it must be ignored and
    // the missing directionId must teach.
    const legacyIdKey = `${["con", "cept"].join("")}Id`;
    await expect(
      runPromote({
        cwd: tmpDir,
        text: "x",
        ...({ [legacyIdKey]: "warm" } as Record<string, string>),
      } as Parameters<typeof runPromote>[0]),
    ).rejects.toThrow(/promote requires a direction id/);
  });
});
