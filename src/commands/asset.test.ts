import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";
import { CommandError } from "../errors.js";
import { runAsset } from "./asset.js";
import { runCreateDirection } from "./direction.js";
import { createDirectionCore } from "../direction/core.js";
import type { AuthoredDirectionContent } from "../types.js";
import { program } from "../cli.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Asset Test", type: "prototype", framework: "next" },
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-asset-cmd-"));
  delete process.env.OPENAI_API_KEY;
  config = buildTestConfig(tmpDir);
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(config);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Directions are the top-level aggregate root now (WS-01) — there is no more
// "concept" data layer to seed. `runCreateDirection` mints a NEW direction
// seeded from an EXISTING direction's brief, so tests first create that seed
// direction directly via DirectionCore, then derive the real target
// direction(s) under test from it (mirroring src/direction/core.test.ts's
// fixture conventions).
async function seedRootDirection(id: string): Promise<void> {
  const core = createDirectionCore(tmpDir, config);
  await core.create({ id, name: id, brief: { oneLiner: "test direction" } });
}

async function seedDirection(seedDirectionId: string): Promise<string> {
  const result = await runCreateDirection({
    cwd: tmpDir,
    verb: "create",
    seedDirectionId,
    json: JSON.stringify(validContent),
  });
  return result.directionId;
}

async function pathExists(relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(tmpDir, relPath));
    return true;
  } catch {
    return false;
  }
}

// 1. Extract dry-run round-trip via dispatch.
describe("runAsset extract", () => {
  it("extracts a new asset in dry-run with cwd-relative forward-slash paths and no PNG", async () => {
    await seedRootDirection("moody");
    const directionId = await seedDirection("moody");

    const result = await runAsset(tmpDir, ["extract"], {
      direction: directionId,
      describe: "the yak mascot",
    });

    expect(result.verb).toBe("extract");
    if (result.verb !== "extract") throw new Error("expected extract result");
    expect(result.dryRun).toBe(true);
    expect(result.assetId).toBeTruthy();
    expect(result.filesWritten.length).toBeGreaterThan(0);
    for (const f of result.filesWritten) {
      expect(f).not.toContain("\\");
      expect(path.isAbsolute(f)).toBe(false);
    }

    const assetDir = `brand/directions/${directionId}/extracted-assets/${result.assetId}`;
    expect(await pathExists(`${assetDir}/asset.json`)).toBe(true);
    expect(
      await pathExists(`${assetDir}/versions/${result.versionId}/asset-prompt.md`),
    ).toBe(true);
    expect(
      await pathExists(`${assetDir}/versions/${result.versionId}/asset.png`),
    ).toBe(false);
  });
});

// 2. Required-flag enforcement (SC-07's dispatch-layer rule).
describe("runAsset required-flag + wrong-verb-coupling enforcement", () => {
  it("throws CommandError for every invalid invocation in the matrix", async () => {
    await seedRootDirection("moody");
    const directionId = await seedDirection("moody");

    // extract without --direction
    await expect(
      runAsset(tmpDir, ["extract"], { describe: "x" }),
    ).rejects.toThrow(CommandError);
    // extract without --describe
    await expect(
      runAsset(tmpDir, ["extract"], { direction: directionId }),
    ).rejects.toThrow(CommandError);
    // regenerate without --tweak
    await expect(
      runAsset(tmpDir, ["regenerate", "some-id"], { direction: directionId }),
    ).rejects.toThrow(CommandError);
    // regenerate without assetId
    await expect(
      runAsset(tmpDir, ["regenerate"], { direction: directionId, tweak: "face left" }),
    ).rejects.toThrow(CommandError);
    // remove without assetId
    await expect(
      runAsset(tmpDir, ["remove"], { direction: directionId }),
    ).rejects.toThrow(CommandError);
    // unknown verb
    await expect(runAsset(tmpDir, ["bogus"], {})).rejects.toThrow(CommandError);
    // --image bogus
    await expect(
      runAsset(tmpDir, ["extract"], {
        direction: directionId,
        describe: "x",
        image: "bogus",
      }),
    ).rejects.toThrow(CommandError);
    // wrong-verb coupling: --tweak on extract
    await expect(
      runAsset(tmpDir, ["extract"], {
        direction: directionId,
        describe: "x",
        tweak: "warmer",
      }),
    ).rejects.toThrow(CommandError);
    // wrong-verb coupling: --describe on regenerate
    await expect(
      runAsset(tmpDir, ["regenerate", "some-id"], {
        direction: directionId,
        tweak: "warmer",
        describe: "y",
      }),
    ).rejects.toThrow(CommandError);
  });
});

// 3. Regenerate appends.
describe("runAsset regenerate", () => {
  it("appends a new version, leaves v1 untouched, and --remember writes exactly one direction-scoped feedback entry, isolated from a sibling direction", async () => {
    await seedRootDirection("moody");
    const directionA = await seedDirection("moody");
    const directionB = await seedDirection("moody");

    const extracted = await runAsset(tmpDir, ["extract"], {
      direction: directionA,
      describe: "the yak mascot",
    });
    if (extracted.verb !== "extract") throw new Error("expected extract result");
    const v1Files = extracted.filesWritten;

    const regenerated = await runAsset(tmpDir, ["regenerate", extracted.assetId], {
      direction: directionA,
      tweak: "face left",
    });
    if (regenerated.verb !== "regenerate") throw new Error("expected regenerate result");
    expect(regenerated.versionId).not.toBe(extracted.versionId);
    expect(regenerated.assetId).toBe(extracted.assetId);

    for (const f of v1Files) {
      expect(await pathExists(f)).toBe(true);
    }

    // `remember` now logs a DIRECTION-scoped feedback entry (there is no more
    // concept-scoped-vs-direction-scoped distinction) — read via DirectionCore.
    const core = createDirectionCore(tmpDir, config);
    const beforeRemember = await core.memoryEntries(directionA);
    expect(beforeRemember.length).toBe(0);

    await runAsset(tmpDir, ["regenerate", extracted.assetId], {
      direction: directionA,
      tweak: "smile more",
      remember: true,
      author: "tim",
    });

    const afterRemember = await core.memoryEntries(directionA);
    expect(afterRemember.length).toBe(1);
    expect(afterRemember[0].author).toBe("tim");
    expect(afterRemember[0].body).toContain(extracted.assetId);

    // Isolation: a sibling direction's memory is structurally untouched.
    const siblingMemory = await core.memoryEntries(directionB);
    expect(siblingMemory.length).toBe(0);
  });
});

// 4. List filters by direction + retire exclusion. (Listing "every asset
// under a concept" no longer exists — list is always single-direction-scoped,
// via --direction or the approved-pointer fallback; this test now asserts
// per-direction isolation in place of that removed cross-direction aggregation.)
describe("runAsset list", () => {
  it("returns active assets for one direction, isolated from a sibling, and excludes retired assets", async () => {
    await seedRootDirection("moody");
    const directionA = await seedDirection("moody");
    const directionB = await seedDirection("moody");

    const a1 = await runAsset(tmpDir, ["extract"], {
      direction: directionA,
      describe: "yak",
    });
    const a2 = await runAsset(tmpDir, ["extract"], {
      direction: directionA,
      describe: "cow",
    });
    const b1 = await runAsset(tmpDir, ["extract"], {
      direction: directionB,
      describe: "goat",
    });
    if (a1.verb !== "extract" || a2.verb !== "extract" || b1.verb !== "extract") {
      throw new Error("expected extract results");
    }

    const onlyA = await runAsset(tmpDir, ["list"], { direction: directionA });
    if (onlyA.verb !== "list") throw new Error("expected list result");
    expect(onlyA.assets.map((r) => r.id).sort()).toEqual([a1.assetId, a2.assetId].sort());
    const row = onlyA.assets.find((r) => r.id === a1.assetId)!;
    expect(row.head).toBe(a1.versionId);
    expect(row.versionCount).toBe(1);
    // Dry-run heads have no PNG — the row honestly omits headPng.
    expect(row.headPng).toBeUndefined();

    const onlyB = await runAsset(tmpDir, ["list"], { direction: directionB });
    if (onlyB.verb !== "list") throw new Error("expected list result");
    expect(onlyB.assets.map((r) => r.id)).toEqual([b1.assetId]);

    // Once a head PNG exists, the row carries its cwd-relative path so a
    // caller can retrieve the file without knowing the store layout.
    const a2PngRel = `brand/directions/${directionA}/extracted-assets/${a2.assetId}/versions/${a2.versionId}/asset.png`;
    await fs.writeFile(path.join(tmpDir, a2PngRel), "stub-png", "utf-8");
    const withPng = await runAsset(tmpDir, ["list"], { direction: directionA });
    if (withPng.verb !== "list") throw new Error("expected list result");
    expect(withPng.assets.find((r) => r.id === a2.assetId)!.headPng).toBe(a2PngRel);
    expect(withPng.assets.find((r) => r.id === a1.assetId)!.headPng).toBeUndefined();

    await runAsset(tmpDir, ["remove", a1.assetId], { direction: directionA });

    const afterRemove = await runAsset(tmpDir, ["list"], { direction: directionA });
    if (afterRemove.verb !== "list") throw new Error("expected list result");
    expect(afterRemove.assets.length).toBe(1);
    expect(afterRemove.assets.map((r) => r.id)).toEqual([a2.assetId]);

    // Isolation: retiring in A never touches B.
    const stillB = await runAsset(tmpDir, ["list"], { direction: directionB });
    if (stillB.verb !== "list") throw new Error("expected list result");
    expect(stillB.assets.map((r) => r.id)).toEqual([b1.assetId]);
  });
});

// 5. Remove is idempotent + non-destructive.
describe("runAsset remove", () => {
  it("is a non-destructive, idempotent retire; a genuinely absent id throws", async () => {
    await seedRootDirection("moody");
    const directionId = await seedDirection("moody");
    const extracted = await runAsset(tmpDir, ["extract"], {
      direction: directionId,
      describe: "yak",
    });
    if (extracted.verb !== "extract") throw new Error("expected extract result");

    const first = await runAsset(tmpDir, ["remove", extracted.assetId], {
      direction: directionId,
    });
    if (first.verb !== "remove") throw new Error("expected remove result");
    expect(first.alreadyRetired).toBe(false);
    expect(first.retiredAt).toBeTruthy();
    expect(first.filesWritten.length).toBeGreaterThan(0);
    expect(
      await pathExists(
        `brand/directions/${directionId}/extracted-assets/${extracted.assetId}/versions/${extracted.versionId}/asset-prompt.md`,
      ),
    ).toBe(true);

    const second = await runAsset(tmpDir, ["remove", extracted.assetId], {
      direction: directionId,
    });
    if (second.verb !== "remove") throw new Error("expected remove result");
    expect(second.alreadyRetired).toBe(true);
    expect(second.filesWritten).toEqual([]);
    expect(second.retiredAt).toBe(first.retiredAt);

    await expect(
      runAsset(tmpDir, ["remove", "does-not-exist"], { direction: directionId }),
    ).rejects.toThrow(CommandError);
  });
});

// 6. Pack dispatch.
describe("runAsset pack", () => {
  it("dispatches to runAssetPack and reports written pack files", async () => {
    await seedRootDirection("moody");
    const directionId = await seedDirection("moody");
    await runAsset(tmpDir, ["extract"], {
      direction: directionId,
      describe: "yak",
    });

    const result = await runAsset(tmpDir, ["pack"], { direction: directionId });
    if (result.verb !== "pack") throw new Error("expected pack result");
    expect(result.directionId).toBe(directionId);
    expect(result.filesWritten.length).toBeGreaterThan(0);
  });
});

// 7. CLI wiring.
describe("asset CLI wiring", () => {
  it("registers --version as a value-taking option on the asset subcommand (distinct from root -V)", () => {
    const assetCmd = program.commands.find((c) => c.name() === "asset")!;
    expect(assetCmd).toBeDefined();
    const versionOption = assetCmd.options.find((o) => o.long === "--version");
    expect(versionOption).toBeDefined();
    expect(versionOption!.flags).toContain("<versionId>");
  });

  it("drives `keyart asset extract` end-to-end through the commander program", async () => {
    await seedRootDirection("moody");
    const directionId = await seedDirection("moody");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await program.parseAsync(
      [
        "--cwd",
        tmpDir,
        "asset",
        "extract",
        "--direction",
        directionId,
        "--describe",
        "the yak mascot",
      ],
      { from: "user" },
    );

    logSpy.mockRestore();
    const dirEntries = await fs.readdir(
      path.join(tmpDir, "brand", "directions", directionId, "extracted-assets"),
    );
    expect(dirEntries.length).toBe(1);
  });

  it("rejects a missing required flag with a non-zero exit and no asset created", async () => {
    await seedRootDirection("moody");
    const directionId = await seedDirection("moody");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      program.parseAsync(
        [
          "--cwd",
          tmpDir,
          "asset",
          "extract",
          "--direction",
          directionId,
        ],
        { from: "user" },
      ),
    ).rejects.toThrow("exit");

    expect(errSpy.mock.calls.join(" ")).toContain("--describe");
    expect(await pathExists(`brand/directions/${directionId}/extracted-assets`)).toBe(false);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

// WS-15 (SC-03): draft refusals for the two asset consumers with a caller target.
describe("runAsset — draft refusals (WS-15)", () => {
  it("extract on a draft teaches `keyart explore <id>`", async () => {
    await seedRootDirection("draft-a");
    await expect(
      runAsset(tmpDir, ["extract"], {
        direction: "draft-a",
        describe: "the mark",
      }),
    ).rejects.toThrow(/keyart explore draft-a/);
  });

  it("pack --direction <draft> teaches and writes no pack folder", async () => {
    await seedRootDirection("draft-b");
    await expect(
      runAsset(tmpDir, ["pack"], { direction: "draft-b" }),
    ).rejects.toThrow(/keyart explore draft-b/);
    expect(await pathExists("brand/generated/asset-pack/draft-b")).toBe(false);
    // The id-omitted pointer branch is NOT asserted here — its approve-first
    // error is SC-11 / WS-10's contract.
  });
});
