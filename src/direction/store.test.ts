import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CommandError } from "../errors.js";
import { ensureDir, writeJsonFile } from "../fs.js";
import type { DirectionVersion, KeyartConfig } from "../types.js";
import { createDirectionCore } from "./core.js";
import {
  mintDirectionId,
  mintVersionId,
  listDirectionIds,
  readVersion,
  readHead,
  readHeadOrNull,
  readDirection,
  resolveDirection,
} from "./store.js";

let tmpDir: string;
let dirsDir: string;

function makeConfig(): KeyartConfig {
  return {
    project: { name: "Test", type: "prototype", framework: "next" },
    brand: {
      root: "./brand",
      references: "./brand/input/references",
      approved: "./brand/approved",
      rejected: "./brand/rejected",
      directions: "./brand/directions",
      global: "./brand/brand.yaml",
    },
    models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
    outputs: {
      cursorRules: ".cursor/rules/keyart-brand.mdc",
      cssVars: "brand/generated/brand.css",
      implementationBrief: "brand/generated/implementation-brief.md",
    },
  };
}

async function pathExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

/** Minimal version content for round-trip tests. */
function makeVersion(id: string, overrides: Partial<DirectionVersion> = {}): DirectionVersion {
  return {
    id,
    createdAt: "2026-07-11T00:00:00.000Z",
    name: `Version ${id}`,
    summary: "s",
    positioning: "p",
    character: { mood: "v" },
    homepageMockupPrompt: "hp",
    styleTilePrompt: "st",
    copyExamples: { headline: "h", subheadline: "sh", cta: "c" },
    usage: { rules: ["a", "b", "c"], antiRules: ["x", "y"] },
    briefSnapshot: "brief",
    contextSnapshot: "ctx",
    ...overrides,
  };
}

/** Write a version file directly under the store layout (no image path). */
async function seedVersionFile(directionId: string, version: DirectionVersion): Promise<void> {
  const versionDir = path.join(dirsDir, directionId, "versions", version.id);
  await ensureDir(versionDir);
  await writeJsonFile(path.join(versionDir, "direction-version.json"), version);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-dirstore-"));
  dirsDir = path.join(tmpDir, "brand", "directions");
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("round-trip + head via DirectionCore.appendVersion", () => {
  it("writes v1, reads it as head, then appends v2 and advances the head", async () => {
    const core = createDirectionCore(tmpDir, makeConfig());
    await core.create({ id: "direction-a", name: "Direction A" });

    const v1 = makeVersion("v1", { name: "First" });
    await seedVersionFile("direction-a", v1);
    await core.appendVersion("direction-a", "v1");

    expect(await readVersion(dirsDir, "direction-a", "v1")).toEqual(v1);
    expect((await readHead(dirsDir, "direction-a")).id).toBe("v1");

    const v2 = makeVersion("v2", { name: "Second" });
    await seedVersionFile("direction-a", v2);
    await core.appendVersion("direction-a", "v2");

    const head = await readHead(dirsDir, "direction-a");
    expect(head.id).toBe("v2");
    expect(head.name).toBe("Second");

    const direction = await readDirection(dirsDir, "direction-a");
    expect(direction.versions.map((v) => v.id)).toEqual(["v1", "v2"]);
  });

  it("resolves a pinned older version independent of the head", async () => {
    const core = createDirectionCore(tmpDir, makeConfig());
    await core.create({ id: "direction-a", name: "Direction A" });
    await seedVersionFile("direction-a", makeVersion("v1", { name: "Old" }));
    await core.appendVersion("direction-a", "v1");
    await seedVersionFile("direction-a", makeVersion("v2", { name: "New" }));
    await core.appendVersion("direction-a", "v2");

    expect((await readVersion(dirsDir, "direction-a", "v1")).name).toBe("Old");
    expect((await readHead(dirsDir, "direction-a")).name).toBe("New");
  });
});

describe("Test 6: appendVersion advances head atomically and is version-checked", () => {
  it("appends v2 to a v1-only record, advancing versions/head/version; a stale expectedVersion 409s without changing disk", async () => {
    const config = makeConfig();
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "direction-a", name: "Direction A" }); // version 1
    await seedVersionFile("direction-a", makeVersion("v1"));
    const afterV1 = await core.appendVersion("direction-a", "v1"); // version 2
    expect(afterV1.versions).toEqual(["v1"]);
    expect(afterV1.version).toBe(2);

    await seedVersionFile("direction-a", makeVersion("v2"));
    const afterV2 = await core.appendVersion("direction-a", "v2"); // version 3
    expect(afterV2.versions).toEqual(["v1", "v2"]);
    expect(afterV2.head).toBe("v2");
    expect(afterV2.version).toBe(3);

    const before = await core.get("direction-a");
    await seedVersionFile("direction-a", makeVersion("v3"));
    await expect(
      core.appendVersion("direction-a", "v3", { expectedVersion: 1 }),
    ).rejects.toThrow(/Version conflict/);
    const after = await core.get("direction-a");
    expect(after).toEqual(before);
  });
});

describe("Test 5: readHead vs readHeadOrNull on a draft", () => {
  it("readHeadOrNull resolves null on a draft; readHead throws naming the direction", async () => {
    const core = createDirectionCore(tmpDir, makeConfig());
    await core.create({ id: "draft-a", name: "Draft A" });

    expect(await readHeadOrNull(dirsDir, "draft-a")).toBeNull();
    await expect(readHead(dirsDir, "draft-a")).rejects.toBeInstanceOf(CommandError);
    await expect(readHead(dirsDir, "draft-a")).rejects.toThrow(/draft-a/);
  });

  it("both return the SECOND version's DirectionVersion for a two-version record", async () => {
    const core = createDirectionCore(tmpDir, makeConfig());
    await core.create({ id: "direction-a", name: "Direction A" });
    await seedVersionFile("direction-a", makeVersion("v1"));
    await core.appendVersion("direction-a", "v1");
    await seedVersionFile("direction-a", makeVersion("v2", { name: "Second" }));
    await core.appendVersion("direction-a", "v2");

    const head = await readHead(dirsDir, "direction-a");
    const headOrNull = await readHeadOrNull(dirsDir, "direction-a");
    expect(head.id).toBe("v2");
    expect(headOrNull?.id).toBe("v2");
  });
});

describe("id minting", () => {
  it("disambiguates a directionId collision without overwriting a sibling", async () => {
    const first = await mintDirectionId(dirsDir, "Direction A");
    expect(first).toBe("direction-a");
    await ensureDir(path.join(dirsDir, first));

    const second = await mintDirectionId(dirsDir, "Direction A");
    expect(second).toBe("direction-a-2");
    expect(await pathExists(path.join(dirsDir, "direction-a"))).toBe(true);
  });

  it("disambiguates a same-millisecond versionId collision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
    const versionsDir = path.join(dirsDir, "direction-a", "versions");

    const first = await mintVersionId(versionsDir);
    expect(first).toBe("2026-07-11T12-00-00-000Z");
    await ensureDir(path.join(versionsDir, first));

    const second = await mintVersionId(versionsDir);
    expect(second).toBe("2026-07-11T12-00-00-000Z-2");
  });
});

describe("missing direction/version", () => {
  it("throws a CommandError naming an absent direction or version", async () => {
    await expect(readHead(dirsDir, "ghost")).rejects.toBeInstanceOf(CommandError);
    await expect(readVersion(dirsDir, "ghost", "v1")).rejects.toBeInstanceOf(CommandError);
  });

  it("listDirectionIds returns [] on an absent dir (never throws)", async () => {
    expect(await listDirectionIds(path.join(dirsDir, "nope"))).toEqual([]);
  });
});

describe("Test 4: resolveDirection never scaffolds", () => {
  it("throws a CommandError naming the missing id and `direction new`; the directory stays empty", async () => {
    await ensureDir(dirsDir);
    await expect(
      resolveDirection(tmpDir, makeConfig(), "missing"),
    ).rejects.toThrow(/missing/);
    await expect(
      resolveDirection(tmpDir, makeConfig(), "missing"),
    ).rejects.toThrow(/direction new/);
    expect(await fs.readdir(dirsDir)).toEqual([]);
  });

  it("with two directions on disk, the error message lists both ids", async () => {
    const core = createDirectionCore(tmpDir, makeConfig());
    await core.create({ id: "alpha", name: "Alpha" });
    await core.create({ id: "beta", name: "Beta" });

    let message = "";
    try {
      await resolveDirection(tmpDir, makeConfig(), "missing");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("alpha");
    expect(message).toContain("beta");
  });

  it("resolves an existing direction without migrating or scaffolding", async () => {
    const core = createDirectionCore(tmpDir, makeConfig());
    await core.create({ id: "moody", name: "Moody" });

    const resolved = await resolveDirection(tmpDir, makeConfig(), "moody");
    expect(resolved.id).toBe("moody");
    expect(resolved.record.name).toBe("Moody");
    expect(resolved.dir).toBe(path.join(tmpDir, "brand", "directions", "moody"));
    expect(resolved.briefPath).toBe(path.join(resolved.dir, "brief.md"));
    expect(resolved.versionsDir).toBe(path.join(resolved.dir, "versions"));
    expect(resolved.assetsDir).toBe(path.join(resolved.dir, "assets"));
    expect(resolved.extractedAssetsDir).toBe(path.join(resolved.dir, "extracted-assets"));
  });
});
