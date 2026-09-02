import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig, DirectionVersion } from "../types.js";
import type { BrandBrief } from "../direction/schema.js";
import { CommandError } from "../errors.js";
import {
  hasApiKey,
  chatJson,
  generateImage,
  visionJson,
  analyzeReferenceForTokens,
} from "../openai.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { listDirectionIds, readHead } from "../direction/store.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return {
    ...actual,
    hasApiKey: vi.fn(actual.hasApiKey),
    chatJson: vi.fn(actual.chatJson),
    visionJson: vi.fn(actual.visionJson),
    generateImage: vi.fn(actual.generateImage),
    analyzeReferenceForTokens: vi.fn(actual.analyzeReferenceForTokens),
  };
});

let tmpDir: string;

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Explore Test", type: "prototype", framework: "next" },
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

/**
 * Seeds a SEED direction whose STRUCTURED brief is the source of truth (WS-04):
 * explore reads `core.getRenderedBrief()` — the projection of the direction's
 * `brief` — never the on-disk `brief.md` as an authored file. A plain string is
 * stored as the brief's `oneLiner` (so it renders into the projection and stays
 * searchable in snapshots/prompts); a partial brief is stored verbatim.
 */
async function seedDirection(
  cwd: string,
  config: KeyartConfig,
  id: string,
  brief: string | Partial<BrandBrief>,
): Promise<void> {
  const core = createDirectionCore(cwd, config);
  const briefObj: Partial<BrandBrief> =
    typeof brief === "string" ? { oneLiner: brief } : brief;
  await core.create({ id, name: id, brief: briefObj });
}

async function mockConfig(): Promise<void> {
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
}

async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

/** Absolute `brand/directions` dir — directions live FLAT here (WS-01). */
function directionsDirOf(): string {
  return path.join(tmpDir, "brand", "directions");
}

/** Absolute path to a direction's HEAD version folder (v1 after a fresh explore). */
async function headVersionDir(directionId: string): Promise<string> {
  const directionsDir = directionsDirOf();
  const head = await readHead(directionsDir, directionId);
  return path.join(directionsDir, directionId, "versions", head.id);
}

/** The given directions' HEAD versions (each direction is at v1 after explore). */
async function headVersions(directionIds: string[]): Promise<DirectionVersion[]> {
  const directionsDir = directionsDirOf();
  return Promise.all(directionIds.map((id) => readHead(directionsDir, id)));
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-explore-cmd-"));
  delete process.env.OPENAI_API_KEY;
  await mockConfig();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runExplore — direction placement and snapshots", () => {
  it("--from mints 3 new directions, each with its own brief and a v1 snapshot pair", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "seed", "A default brand for explore tests.");
    const { runExplore } = await import("./explore.js");

    const result = await runExplore({ cwd: tmpDir, from: "seed" });

    expect(result.direction).toBe("seed");
    // Three NEW directions minted flat under brand/directions — no run folder,
    // no directions.json batch file (WS-01 layout); the source is untouched.
    expect(result.directionIds).toHaveLength(3);
    expect(result.directionIds).not.toContain("seed");
    const directionsDir = directionsDirOf();
    expect((await listDirectionIds(directionsDir)).sort()).toEqual(
      ["seed", ...result.directionIds].sort(),
    );
    expect(await exists(path.join(directionsDir, "runs"))).toBe(false);

    // Each minted direction has a v1 whose frozen brief-snapshot.md is the
    // rendered projection of ITS OWN (distinct) brief — no shared parent brief.
    const core = createDirectionCore(tmpDir, config);
    for (const directionId of result.directionIds) {
      const record = await core.get(directionId);
      expect(record.versions).toHaveLength(1);
      const versionDir = path.join(directionsDir, directionId, "versions", record.head!);
      expect(
        await exists(path.join(versionDir, "direction-version.json")),
      ).toBe(true);
      const snapshot = await fs.readFile(
        path.join(versionDir, "brief-snapshot.md"),
        "utf-8",
      );
      expect(snapshot).toBe(await core.getRenderedBrief(directionId));
      expect(await exists(path.join(versionDir, "context-snapshot.md"))).toBe(
        true,
      );
    }

    // The reported files for a version include its record, then both snapshots.
    const firstDirVersionDir = await headVersionDir(result.directionIds[0]);
    const relVersionDir = path
      .relative(tmpDir, firstDirVersionDir)
      .split(path.sep)
      .join("/");
    expect(result.filesWritten).toContain(
      `${relVersionDir}/direction-version.json`,
    );
    expect(result.filesWritten).toContain(`${relVersionDir}/brief-snapshot.md`);
    expect(result.filesWritten).toContain(
      `${relVersionDir}/context-snapshot.md`,
    );
  });
});

describe("runExplore — assembled context (memory + global hard rules)", () => {
  it("feeds the hard rule before feedback before the brief, and snapshots it", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "moody", "A moody jazz-bar brand.");

    const core = createDirectionCore(tmpDir, config);
    await core.appendFeedback("moody", {
      body: "loves serif headlines",
      author: "tim",
      source: "cli",
    });
    const brand = createBrandCore(tmpDir, config);
    await brand.addRule({
      severity: "hard",
      text: "Never use pure black",
      author: "tim",
      source: "cli",
    });

    vi.mocked(hasApiKey).mockReturnValue(true);
    // Capture the user prompt, then fall back to placeholders.
    vi.mocked(chatJson).mockResolvedValue({ data: null as never, dryRun: true });

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });

    expect(vi.mocked(chatJson)).toHaveBeenCalled();
    const userPrompt = vi.mocked(chatJson).mock.calls[0][0].user;
    const ruleIdx = userPrompt.indexOf("Never use pure black");
    const feedbackIdx = userPrompt.indexOf("loves serif headlines");
    const briefIdx = userPrompt.indexOf("A moody jazz-bar brand.");
    expect(ruleIdx).toBeGreaterThanOrEqual(0);
    expect(ruleIdx).toBeLessThan(feedbackIdx);
    expect(feedbackIdx).toBeLessThan(briefIdx);

    // The head version's context-snapshot.md carries both the hard rule and the
    // feedback (same context across the seed's siblings).
    const versionDir = await headVersionDir(result.directionIds[0]);
    const snapshot = await fs.readFile(
      path.join(versionDir, "context-snapshot.md"),
      "utf-8",
    );
    expect(snapshot).toContain("Never use pure black");
    expect(snapshot).toContain("loves serif headlines");
  });

  it("feedback recorded on a draft feeds ITS v1 generation; an earlier snapshot stays frozen", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "moody-a", "A moody jazz-bar brand.");
    await seedDirection(tmpDir, config, "moody-b", "A moody jazz-bar brand.");
    const core = createDirectionCore(tmpDir, config);

    const { runExplore } = await import("./explore.js");
    const first = await runExplore({ cwd: tmpDir, directionId: "moody-a" });
    const firstVersionDir = await headVersionDir(first.directionIds[0]);
    const firstSnapshotPath = path.join(firstVersionDir, "context-snapshot.md");
    const firstBefore = await fs.readFile(firstSnapshotPath, "utf-8");
    expect(firstBefore).not.toContain("velvet-lounge accent");

    await core.appendFeedback("moody-b", {
      body: "add a velvet-lounge accent",
      author: "tim",
      source: "cli",
    });

    const second = await runExplore({ cwd: tmpDir, directionId: "moody-b" });
    // The draft's own memory feeds its v1 generation's frozen context.
    const secondVersionDir = await headVersionDir(second.directionIds[0]);
    const secondSnapshot = await fs.readFile(
      path.join(secondVersionDir, "context-snapshot.md"),
      "utf-8",
    );
    expect(secondSnapshot).toContain("velvet-lounge accent");

    // The earlier direction's snapshot is frozen — unchanged after the feedback.
    expect(await fs.readFile(firstSnapshotPath, "utf-8")).toBe(firstBefore);
  });
});

describe("runExplore — direction errors", () => {
  it("rejects an unknown seed directionId with a helpful CommandError", async () => {
    const { runExplore } = await import("./explore.js");
    await expect(
      runExplore({ cwd: tmpDir, directionId: "ghost" }),
    ).rejects.toThrow(CommandError);
    await expect(
      runExplore({ cwd: tmpDir, directionId: "ghost" }),
    ).rejects.toThrow(/Direction not found: ghost/);
    await expect(
      runExplore({ cwd: tmpDir, directionId: "ghost" }),
    ).rejects.toThrow(/direction new/);
    expect(await exists(path.join(directionsDirOf(), "ghost"))).toBe(false);
  });
});

describe("runExplore — image generation behavior", () => {
  it("dry-run makes no image attempts and emits no warnings", async () => {
    await seedDirection(tmpDir, buildTestConfig(tmpDir), "moody", "A short moody brief.");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });

    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(result.filesWritten.some((p) => p.endsWith(".png"))).toBe(false);

    const versionDir = await headVersionDir(result.directionIds[0]);
    const entries = await fs.readdir(versionDir);
    expect(entries.some((e) => e.endsWith(".png"))).toBe(false);
  });

  it("live-mode image skips warn per file and the run still completes", async () => {
    await seedDirection(tmpDir, buildTestConfig(tmpDir), "moody", "A short moody brief.");

    vi.mocked(hasApiKey).mockReturnValue(true);
    // Live mode for images, but keep direction generation as silent placeholders
    // (a dry-run response) so the only warnings are the 6 image skips.
    vi.mocked(chatJson).mockResolvedValue({ data: null as never, dryRun: true });
    // WS-02's generateImage never throws — it returns a typed skip reason.
    vi.mocked(generateImage).mockResolvedValue({
      written: false,
      dryRun: false,
      skippedReason: "rate limited",
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });

    expect(warnSpy).toHaveBeenCalledTimes(2); // 1 direction × (style tile + homepage)
    for (const call of warnSpy.mock.calls) {
      // Scoped to <directionId>/<versionId>/<image>.png (WS-01 layout).
      expect(call[0]).toMatch(
        /^Warning: image generation skipped for [a-z0-9-]+\/.+\/(style-tile|homepage-mockup)\.png: rate limited$/,
      );
    }

    // Every skip reason is collected onto the result (never thrown).
    expect(result.imageSkips).toHaveLength(2);
    expect(result.imageSkips.every((r) => r === "rate limited")).toBe(true);

    // No images recorded, but each direction's head version carries prompt files
    // + both snapshots on disk.
    expect(result.filesWritten.some((p) => p.endsWith(".png"))).toBe(false);
    for (const id of result.directionIds) {
      const versionDir = await headVersionDir(id);
      expect(await exists(path.join(versionDir, "brief-snapshot.md"))).toBe(true);
      expect(await exists(path.join(versionDir, "context-snapshot.md"))).toBe(
        true,
      );
      expect(await exists(path.join(versionDir, "style-tile-prompt.md"))).toBe(
        true,
      );
      expect(
        await exists(path.join(versionDir, "homepage-mockup-prompt.md")),
      ).toBe(true);
    }
  });
});

describe("runExplore — reference grounding, dry-run flag, and env load", () => {
  it("elevates a direction's image asset into context-snapshot.md (SC-04)", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "moody", "A moody jazz-bar brand.");
    const core = createDirectionCore(tmpDir, config);
    await core.addAsset("moody", {
      kind: "image",
      path: "brand/directions/moody/refs/moodboard.png",
      note: "velvet + brass",
    });

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });

    const versionDir = await headVersionDir(result.directionIds[0]);
    const snapshot = await fs.readFile(
      path.join(versionDir, "context-snapshot.md"),
      "utf-8",
    );
    expect(snapshot).toContain("## Reference Images");
    expect(snapshot).toContain("brand/directions/moody/refs/moodboard.png");
  });

  it("passes the direction's image assets (absolute) as referenceImagePaths to every generateImage call (SC-03)", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "moody", "A moody jazz-bar brand.");
    const core = createDirectionCore(tmpDir, config);
    const assetRel = "brand/directions/moody/refs/moodboard.png";
    await core.addAsset("moody", { kind: "image", path: assetRel });

    vi.mocked(hasApiKey).mockReturnValue(true);
    // References + a vision model → direction generation routes through vision;
    // keep it a silent placeholder run so the assertion targets generateImage.
    vi.mocked(visionJson).mockResolvedValue({ data: null as never, dryRun: true });
    vi.mocked(generateImage).mockResolvedValue({ written: true, dryRun: false });

    const { runExplore } = await import("./explore.js");
    await runExplore({ cwd: tmpDir, directionId: "moody" });

    const absAsset = path.resolve(tmpDir, assetRel);
    const calls = vi.mocked(generateImage).mock.calls;
    expect(calls.length).toBe(2); // 1 direction × (style tile + homepage)
    for (const [arg] of calls) {
      expect(arg.referenceImagePaths).toEqual([absAsset]);
    }
    // Both prompt kinds were conditioned on the references.
    const prompts = calls.map(([arg]) => arg.prompt);
    expect(prompts.some((p) => p.length > 0)).toBe(true);
  });

  it("reports dryRun=true with no key and makes no image attempts", async () => {
    await seedDirection(tmpDir, buildTestConfig(tmpDir), "moody", "A short moody brief.");
    const { runExplore } = await import("./explore.js");

    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });

    expect(result.dryRun).toBe(true);
    expect(result.imageSkips).toEqual([]);
    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();
    expect(result.filesWritten.some((p) => p.endsWith(".png"))).toBe(false);

    // The placeholder v1 was still written INTO the draft — no new direction minted.
    expect(result.directionIds).toEqual(["moody"]);
    expect(await listDirectionIds(directionsDirOf())).toEqual(["moody"]);
  });

  it("loads .env.local so a serve-triggered run with a key no longer dry-runs", async () => {
    await seedDirection(tmpDir, buildTestConfig(tmpDir), "moody", "A short moody brief.");
    await fs.writeFile(
      path.join(tmpDir, ".env.local"),
      "OPENAI_API_KEY=env-file-key\n",
      "utf-8",
    );
    delete process.env.OPENAI_API_KEY;

    // Avoid any real network: the key from .env.local makes this a live run, so
    // stub both model surfaces to deterministic no-ops.
    vi.mocked(chatJson).mockResolvedValue({ data: null as never, dryRun: true });
    vi.mocked(generateImage).mockResolvedValue({ written: false, dryRun: false });

    const { runExplore } = await import("./explore.js");
    try {
      const result = await runExplore({ cwd: tmpDir, directionId: "moody" });
      expect(result.dryRun).toBe(false);
      expect(process.env.OPENAI_API_KEY).toBe("env-file-key");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe("runExplore — generate another option (--from … --count 1)", () => {
  it("--from … --count 1 mints one MORE direction, keeping the existing ones intact", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "moody", "A moody brief.");
    const { runExplore } = await import("./explore.js");

    const first = await runExplore({ cwd: tmpDir, from: "moody" });
    expect(first.directionIds).toHaveLength(3);
    const before = await listDirectionIds(directionsDirOf());
    expect(before).toHaveLength(4); // source "moody" + 3 minted

    // "Generate another option" is `explore --from <id> --count 1`: one
    // additional direction at v1.
    const appended = await runExplore({
      cwd: tmpDir,
      from: "moody",
      count: 1,
    });
    expect(appended.directionIds).toHaveLength(1);

    // The original directions are untouched; one new sibling joined them.
    const after = await listDirectionIds(directionsDirOf());
    expect(after).toHaveLength(5);
    for (const id of before) expect(after).toContain(id);
    const newId = appended.directionIds[0];
    expect(before).not.toContain(newId);

    // The new direction is a fully-formed v1 on disk.
    const core = createDirectionCore(tmpDir, config);
    const record = await core.get(newId);
    expect(record.versions).toHaveLength(1);
    expect(
      await exists(path.join(directionsDirOf(), newId, "direction.yaml")),
    ).toBe(true);
  });

  it("count controls how many directions are minted", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "moody", "A moody brief.");
    const { runExplore } = await import("./explore.js");

    const result = await runExplore({ cwd: tmpDir, from: "moody", count: 1 });
    expect(result.directionIds).toHaveLength(1);
    expect(await listDirectionIds(directionsDirOf())).toHaveLength(2); // source + 1
  });
});

describe("runExplore — run-level references + intent (WS-05)", () => {
  /** A minimal model-valid direction (passes isValidDirection) sans tokens. */
  function validDirection(id: string): Record<string, unknown> {
    return {
      id,
      name: `Dir ${id}`,
      summary: "s",
      positioning: "p",
      character: { mood: "v" },
      homepageMockupPrompt: "hp",
      styleTilePrompt: "st",
      copyExamples: { headline: "h", subheadline: "sh", cta: "c" },
      usage: { rules: ["r1", "r2", "r3"], antiRules: ["a1", "a2"] },
    };
  }

  it("records a run-level reference with its intent in context-snapshot.md (SC-06)", async () => {
    await seedDirection(tmpDir, buildTestConfig(tmpDir), "moody", "A moody brief.");
    const { runExplore } = await import("./explore.js");

    const result = await runExplore({
      cwd: tmpDir,
      directionId: "moody",
      references: [{ path: "refs/board.png", intent: "extract" }],
    });

    const versionDir = await headVersionDir(result.directionIds[0]);
    const snapshot = await fs.readFile(
      path.join(versionDir, "context-snapshot.md"),
      "utf-8",
    );
    expect(snapshot).toContain("## Reference Images");
    expect(snapshot).toContain("refs/board.png [intent: extract]");
  });

  it("seeds palette tokens from an extract reference's dominant color (SC-13)", async () => {
    await seedDirection(tmpDir, buildTestConfig(tmpDir), "moody", "A moody brief.");

    vi.mocked(hasApiKey).mockReturnValue(true);
    // Extract ref → analysis returns a dominant color that must survive as a lock.
    vi.mocked(analyzeReferenceForTokens).mockResolvedValue({
      analysis: { dominantColors: ["#123456"] },
      dryRun: false,
    });
    // Extract-only ⇒ no inspire refs ⇒ text route; return one live direction so
    // token stamping runs the palette engine WITH the extract-derived lock.
    vi.mocked(chatJson).mockResolvedValue({
      data: { directions: [validDirection("direction-a")] } as never,
      dryRun: false,
    });
    vi.mocked(generateImage).mockResolvedValue({ written: false, dryRun: false });

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({
      cwd: tmpDir,
      directionId: "moody",
      references: [{ path: "refs/board.png", intent: "extract" }],
    });

    expect(vi.mocked(analyzeReferenceForTokens)).toHaveBeenCalledTimes(1);
    const [head] = await headVersions(result.directionIds);
    const hexes = head.tokens?.palette.map((p) => p.hex) ?? [];
    expect(hexes).toContain("#123456");
  });

  it("passes inspire refs to generateImage but never the extract ref (SC-06)", async () => {
    await seedDirection(tmpDir, buildTestConfig(tmpDir), "moody", "A moody brief.");

    vi.mocked(hasApiKey).mockReturnValue(true);
    vi.mocked(analyzeReferenceForTokens).mockResolvedValue({
      analysis: { dominantColors: [] },
      dryRun: false,
    });
    // Inspire refs present + a vision model ⇒ direction gen routes via vision;
    // keep it a placeholder run so the assertion targets generateImage args.
    vi.mocked(visionJson).mockResolvedValue({ data: null as never, dryRun: true });
    vi.mocked(generateImage).mockResolvedValue({ written: true, dryRun: false });

    const { runExplore } = await import("./explore.js");
    await runExplore({
      cwd: tmpDir,
      directionId: "moody",
      references: [
        { path: "refs/inspire.png", intent: "inspire" },
        { path: "refs/extract.png", intent: "extract" },
      ],
    });

    const inspireAbs = path.resolve(tmpDir, "refs/inspire.png");
    const extractAbs = path.resolve(tmpDir, "refs/extract.png");
    const calls = vi.mocked(generateImage).mock.calls;
    expect(calls.length).toBe(2); // 1 direction × (style tile + homepage)
    for (const [arg] of calls) {
      expect(arg.referenceImagePaths).toEqual([inspireAbs]);
      expect(arg.referenceImagePaths).not.toContain(extractAbs);
    }
  });

  it("no references: no extract analysis, reference section omitted (byte-identical)", async () => {
    await seedDirection(tmpDir, buildTestConfig(tmpDir), "moody", "A moody brief.");
    const { runExplore } = await import("./explore.js");

    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });

    expect(vi.mocked(analyzeReferenceForTokens)).not.toHaveBeenCalled();
    const versionDir = await headVersionDir(result.directionIds[0]);
    const snapshot = await fs.readFile(
      path.join(versionDir, "context-snapshot.md"),
      "utf-8",
    );
    expect(snapshot).not.toContain("## Reference Images");
  });
});

describe("runExplore — brief projection + soft-intent seed (WS-04)", () => {
  /** A minimal model-valid direction WITHOUT tokenIntent — so the brief's soft
   * seed becomes the raw engine intent for this direction. */
  function validDirection(id: string): Record<string, unknown> {
    return {
      id,
      name: `Dir ${id}`,
      summary: "s",
      positioning: "p",
      character: { mood: "v" },
      homepageMockupPrompt: "hp",
      styleTilePrompt: "st",
      copyExamples: { headline: "h", subheadline: "sh", cta: "c" },
      usage: { rules: ["r1", "r2", "r3"], antiRules: ["a1", "a2"] },
    };
  }

  it("brief-snapshot.md equals the rendered projection, not stale authored brief.md text (SC-07)", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "moody", {
      oneLiner: "A moody jazz bar.",
      colorIntent: "warm earthy",
    });

    // Corrupt the on-disk brief.md so we prove the reader ignores it as a source.
    const briefMd = path.join(directionsDirOf(), "moody", "brief.md");
    await fs.writeFile(briefMd, "STALE HAND-AUTHORED TEXT", "utf-8");

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });

    const core = createDirectionCore(tmpDir, config);
    const projection = await core.getRenderedBrief("moody");
    const versionDir = await headVersionDir(result.directionIds[0]);
    const snapshot = await fs.readFile(
      path.join(versionDir, "brief-snapshot.md"),
      "utf-8",
    );
    expect(snapshot).toBe(projection);
    expect(snapshot).not.toContain("STALE HAND-AUTHORED TEXT");
    expect(snapshot).toContain("A moody jazz bar.");
    expect(snapshot).toContain("warm earthy");
  });

  it("seeds a warm base hue from colorIntent while a typed hex becomes a memory lock (SC-12)", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "moody", {
      oneLiner: "A moody jazz bar.",
      colorIntent: "warm earthy",
    });
    const core = createDirectionCore(tmpDir, config);
    // The typed hex routes to a memory color-lock (WS-03), NOT into the brief.
    await core.recordColorLock("moody", {
      hex: "#1a1a1a",
      author: "tim",
      source: "studio",
    });

    vi.mocked(hasApiKey).mockReturnValue(true);
    // A live direction WITHOUT tokenIntent → the brief's soft seed IS the raw
    // engine intent; the memory hex-lock flows in via the context block.
    vi.mocked(chatJson).mockResolvedValue({
      data: { directions: [validDirection("direction-a")] } as never,
      dryRun: false,
    });
    vi.mocked(generateImage).mockResolvedValue({ written: false, dryRun: false });

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });

    const [d] = await headVersions(result.directionIds);

    // Intent phrase → SEED: the base hue landed warm (not the cool ~220 default).
    expect(d.tokens?.provenance?.baseHue).toBeGreaterThanOrEqual(20);
    expect(d.tokens?.provenance?.baseHue).toBeLessThanOrEqual(60);

    // Typed hex → memory lock → verbatim extraction lock in the palette (not
    // brief prose). Proves the hex became a lock decision, not a brief color.
    const hexes = d.tokens?.palette.map((p) => p.hex) ?? [];
    expect(hexes).toContain("#1a1a1a");
  });

  it("keyless explore over a structured brief writes a full board and is byte-stable (SC-09)", async () => {
    const brief = {
      oneLiner: "A calm brand.",
      colorIntent: "cool calm",
      typeIntent: "editorial serif",
    };
    await seedDirection(tmpDir, buildTestConfig(tmpDir), "moody-a", brief);
    await seedDirection(tmpDir, buildTestConfig(tmpDir), "moody-b", brief);
    const { runExplore } = await import("./explore.js");

    const first = await runExplore({ cwd: tmpDir, directionId: "moody-a" });
    expect(first.dryRun).toBe(true);
    const firstDirs = await headVersions(first.directionIds);
    expect(firstDirs).toHaveLength(1);
    for (const d of firstDirs) expect(d.tokens?.palette).toHaveLength(6);

    // Same brief ⇒ byte-stable placeholder tokens + prose across runs (keyless
    // parity). The per-version identity fields (id/createdAt) legitimately differ,
    // so compare the deterministic CONTENT (tokens + prose), not the whole record.
    const second = await runExplore({ cwd: tmpDir, directionId: "moody-b" });
    const secondDirs = await headVersions(second.directionIds);
    const content = (v: DirectionVersion): unknown => {
      const { id, createdAt, producedBy, briefSnapshot, contextSnapshot, ...rest } =
        v;
      void id;
      void createdAt;
      void producedBy;
      void briefSnapshot;
      void contextSnapshot;
      return rest;
    };
    expect(secondDirs.map(content)).toEqual(firstDirs.map(content));
  });
});

describe("runExplore — filesWritten formatting", () => {
  it("returns cwd-relative forward-slash paths under brand/directions/", async () => {
    await seedDirection(tmpDir, buildTestConfig(tmpDir), "moody", "A short moody brief.");
    const { runExplore } = await import("./explore.js");

    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });
    for (const p of result.filesWritten) {
      expect(p).not.toContain("\\");
      expect(p.startsWith("brand/directions/")).toBe(true);
    }
  });
});

describe("runExplore — WS-03 art-direction compiler wired into both explore prompts", () => {
  /** Add a visual hard rule to the global brand. */
  async function addHardRule(text: string): Promise<void> {
    const brand = createBrandCore(tmpDir, buildTestConfig(tmpDir));
    await brand.addRule({
      severity: "hard",
      text,
      author: "tim",
      source: "cli",
      channel: "visual",
    });
  }

  /** Add a visual-avoid decision to a direction's own memory. */
  async function addVisualAvoidDecision(directionId: string, body: string): Promise<void> {
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    await core.appendDecision(directionId, {
      body,
      author: "tim",
      source: "cli",
      channel: "visual",
      polarity: "avoid",
    });
  }

  it("global hard rule + visual-avoid decision land in MUST and AVOID on BOTH explore prompt files (SC-03)", async () => {
    const config = buildTestConfig(tmpDir);
    await addHardRule("Never use a fist-in-the-air icon");
    await seedDirection(tmpDir, config, "moody", "A moody editorial brand.");
    await addVisualAvoidDecision("moody", "avoid aggressive diagonal layouts");

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });

    expect(result.directionIds.length).toBeGreaterThan(0);

    // Every direction's BOTH prompt files carry the MUST block + hard prohibition.
    for (const directionId of result.directionIds) {
      const versionDir = await headVersionDir(directionId);
      const styleMd = await fs.readFile(path.join(versionDir, "style-tile-prompt.md"), "utf-8");
      const homeMd = await fs.readFile(path.join(versionDir, "homepage-mockup-prompt.md"), "utf-8");
      for (const md of [styleMd, homeMd]) {
        expect(md).toContain("MUST (non-negotiable — always obey):");
        expect(md).toContain("Never use a fist-in-the-air icon");
        expect(md).toContain("avoid aggressive diagonal layouts");
      }
    }
  });

  it("copy-only entry is absent from explore image prompts (SC-04)", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "moody", "A moody brand.");
    const core = createDirectionCore(tmpDir, config);
    await core.appendLearning("moody", {
      body: "use conversational tone in all copy",
      author: "tim",
      source: "cli",
      channel: "copy",
    });

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });

    for (const directionId of result.directionIds) {
      const versionDir = await headVersionDir(directionId);
      const styleMd = await fs.readFile(path.join(versionDir, "style-tile-prompt.md"), "utf-8");
      expect(styleMd).not.toContain("use conversational tone in all copy");
    }
  });

  it("per-direction isolation — a directive recorded on one seed direction never appears in a different seed direction's explore prompts (SC-08)", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "seed-a", "Brand A.");
    await seedDirection(tmpDir, config, "seed-b", "Brand B.");
    const core = createDirectionCore(tmpDir, config);
    await core.appendDecision("seed-a", {
      body: "avoid red backgrounds",
      author: "tim",
      source: "cli",
      channel: "visual",
      polarity: "avoid",
    });

    const { runExplore } = await import("./explore.js");
    const resultB = await runExplore({ cwd: tmpDir, directionId: "seed-b" });

    for (const directionId of resultB.directionIds) {
      const versionDir = await headVersionDir(directionId);
      const styleMd = await fs.readFile(path.join(versionDir, "style-tile-prompt.md"), "utf-8");
      expect(styleMd).not.toContain("avoid red backgrounds");
    }
  });

  it("no directives (SC-11) — prompt files carry only the content lock, no MUST/PREFER/AVOID", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "moody", "A moody brand.");

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });

    for (const directionId of result.directionIds) {
      const versionDir = await headVersionDir(directionId);
      const styleMd = await fs.readFile(path.join(versionDir, "style-tile-prompt.md"), "utf-8");
      expect(styleMd).not.toContain("MUST (non-negotiable — always obey):");
      expect(styleMd).not.toContain("PREFER (do):");
      expect(styleMd).toContain("CONTENT LOCK");
    }
  });

  it("art-direction precedence section is appended to context-snapshot.md (SC-06)", async () => {
    const config = buildTestConfig(tmpDir);
    await addHardRule("Never use a fist-in-the-air icon");
    await seedDirection(tmpDir, config, "moody", "A moody brand.");

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });

    const versionDir = await headVersionDir(result.directionIds[0]);
    const snapshot = await fs.readFile(path.join(versionDir, "context-snapshot.md"), "utf-8");
    expect(snapshot).toContain("## Art-direction precedence");
    expect(snapshot).toContain("Never use a fist-in-the-air icon");
  });
});

describe("runExplore — WS-04 contradiction detection", () => {
  async function addHardRule(text: string): Promise<void> {
    const brand = createBrandCore(tmpDir, buildTestConfig(tmpDir));
    await brand.addRule({ severity: "hard", text, author: "tim", source: "cli" });
  }

  it("SC-08 test 15: instructions steer contradicting a hard rule warns", async () => {
    const config = buildTestConfig(tmpDir);
    await addHardRule("Never use pure black");
    await seedDirection(tmpDir, config, "moody", "A moody brand.");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({
      cwd: tmpDir,
      directionId: "moody",
      instructions: "use pure black everywhere",
    });

    // Floor detected the clash between instructions and the hard prohibition.
    expect(result.contradictionReport.warnings).toHaveLength(1);
    expect(result.contradictionReport.warnings[0].code).toBe("hard-rule-conflict");
    expect(result.contradictionReport.warnings[0].message.length).toBeGreaterThan(0);

    // Warning rendered to stdout via console.warn (SC-08).
    const warnMessages = warnSpy.mock.calls.map((c) => c[0] as string);
    const hasConflictWarning = warnMessages.some(
      (m) => typeof m === "string" && m.includes("hard-rule-conflict"),
    );
    expect(hasConflictWarning).toBe(true);
  });

  it("SC-11 test 16: keyless explore never throws and has empty warnings on no contradiction", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "moody", "A moody brand.");

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({
      cwd: tmpDir,
      directionId: "moody",
      instructions: "warm editorial photography",
    });

    expect(result.dryRun).toBe(true);
    expect(result.contradictionReport.detector).toBe("deterministic");
    expect(result.contradictionReport.warnings).toHaveLength(0);
    // No hard-rule clash when instructions are benign.
    const hardClashes = result.contradictionReport.items.filter(
      (c) => c.kind === "live-vs-hardrule",
    );
    expect(hardClashes).toHaveLength(0);
  });
});

describe("runExplore — direction memory isolation (SC-04/SC-06/SC-11)", () => {
  it("positional explore reads only the TARGET direction's own memory — a sibling's memory is never inherited (SC-04/SC-06)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);

    // A DECOY sibling with distinctive memory: kept-crop asset, a discard note,
    // a color lock. None of it may reach another direction's explore.
    await seedDirection(tmpDir, config, "decoy", "A decoy brand.");
    const keepCropRel = "brand/directions/decoy/assets/keep.png";
    const keepCropAbs = path.join(tmpDir, keepCropRel);
    await fs.mkdir(path.dirname(keepCropAbs), { recursive: true });
    await fs.writeFile(keepCropAbs, "png-bytes");
    await core.addAsset("decoy", {
      kind: "image",
      path: keepCropRel,
      intent: "inspire",
    });
    await core.appendFeedback("decoy", {
      body: "garish neon",
      author: "tim",
      source: "element-feedback",
      asset: "brand/directions/discards/thumb-a.png",
    });
    await core.recordColorLock("decoy", {
      hex: "#ff0000",
      author: "tim",
      source: "studio",
    });

    // The TARGET draft carries its own directive — this one DOES assemble.
    await seedDirection(tmpDir, config, "moody", "A brand.");
    await core.appendDecision("moody", {
      body: "prefer airy whitespace",
      author: "tim",
      source: "cli",
      channel: "visual",
      polarity: "prefer",
    });

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });
    expect(result.directionIds).toEqual(["moody"]);

    const newVersionDir = await headVersionDir("moody");
    const styleMd = await fs.readFile(
      path.join(newVersionDir, "style-tile-prompt.md"),
      "utf-8",
    );
    const homeMd = await fs.readFile(
      path.join(newVersionDir, "homepage-mockup-prompt.md"),
      "utf-8",
    );
    const snapshot = await fs.readFile(
      path.join(newVersionDir, "context-snapshot.md"),
      "utf-8",
    );

    // The decoy's own memory is absent from the target's prompts and snapshot.
    expect(styleMd).not.toContain("garish neon");
    expect(homeMd).not.toContain("garish neon");
    expect(styleMd).not.toContain("#ff0000");
    expect(homeMd).not.toContain("#ff0000");
    expect(snapshot).not.toContain("garish neon");
    expect(snapshot).not.toContain(keepCropRel);

    // The target direction's own decision IS present.
    expect(styleMd).toContain("prefer airy whitespace");
    expect(snapshot).toContain("prefer airy whitespace");
  });

  it("dry-run parity (SC-11) — no key, positional explore writes placeholder prompts into the draft, never throws", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "moody", "A brand.");

    const { runExplore } = await import("./explore.js");
    const result = await runExplore({ cwd: tmpDir, directionId: "moody" });

    expect(result.dryRun).toBe(true);
    expect(result.directionIds).toEqual(["moody"]);

    const newVersionDir = await headVersionDir("moody");
    const styleMd = await fs.readFile(
      path.join(newVersionDir, "style-tile-prompt.md"),
      "utf-8",
    );
    expect(styleMd.length).toBeGreaterThan(0);
    expect(result.filesWritten.some((p) => p.endsWith(".png"))).toBe(false);
  });
});

// WS-16: the three-form explore contract (SC-04 positional, SC-05 divergent).
describe("runExplore — positional v1 into an existing draft (SC-04)", () => {
  it("writes exactly one v1 into the draft, minting nothing (case 12)", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "warm", "A warm editorial brand.");
    const { runExplore } = await import("./explore.js");

    const result = await runExplore({ cwd: tmpDir, directionId: "warm" });
    expect(result.direction).toBe("warm");
    expect(result.directionIds).toEqual(["warm"]);
    expect(result.floorCount).toBe(0);

    const core = createDirectionCore(tmpDir, config);
    const record = await core.get("warm");
    expect(record.head).not.toBeNull();
    expect(record.versions).toHaveLength(1);
    expect(await listDirectionIds(directionsDirOf())).toEqual(["warm"]);
  });

  it("teaches `regenerate` on a direction that already has versions (case 13)", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "warm", "A warm editorial brand.");
    const { runExplore } = await import("./explore.js");

    await runExplore({ cwd: tmpDir, directionId: "warm" });
    await expect(
      runExplore({ cwd: tmpDir, directionId: "warm" }),
    ).rejects.toThrow(/keyart regenerate warm/);

    const core = createDirectionCore(tmpDir, config);
    expect((await core.get("warm")).versions).toHaveLength(1); // no second version
  });

  it("--count with a positional target teaches the forms (case 14)", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "warm", "A warm editorial brand.");
    const { runExplore } = await import("./explore.js");

    await expect(
      runExplore({ cwd: tmpDir, directionId: "warm", count: 2 }),
    ).rejects.toThrow(/--describe|--from/);

    const core = createDirectionCore(tmpDir, config);
    expect((await core.get("warm")).versions).toHaveLength(0); // nothing written
  });

  it("no target at all teaches all three forms (case 18)", async () => {
    const { runExplore } = await import("./explore.js");
    let thrown: unknown;
    try {
      await runExplore({ cwd: tmpDir });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CommandError);
    const message = (thrown as CommandError).message;
    expect(message).toContain("explore <directionId>");
    expect(message).toContain("--describe");
    expect(message).toContain("--from");
  });
});

describe("runExplore — divergent modes (SC-05)", () => {
  it("--describe keyless mints N drafts+v1 with distinct briefs (case 15)", async () => {
    const config = buildTestConfig(tmpDir);
    const { runExplore } = await import("./explore.js");
    const { normalizeIntentValue } = await import(
      "../explore/propose-briefs.js"
    );

    const result = await runExplore({
      cwd: tmpDir,
      describe: "a delivery app for people who cook",
      count: 2,
    });

    expect(result.directionIds).toHaveLength(2);
    expect(result.floorCount).toBe(2);
    expect(result.dryRun).toBe(true);
    expect(result.direction).toBe("");

    const core = createDirectionCore(tmpDir, config);
    const briefs = [];
    for (const id of result.directionIds) {
      const record = await core.get(id);
      expect(record.head).not.toBeNull();
      expect(record.versions).toHaveLength(1);
      briefs.push(record.brief);
    }
    expect(
      new Set(briefs.map((b) => normalizeIntentValue(b.positioning ?? ""))).size,
    ).toBe(2);
    expect(
      new Set(briefs.map((b) => normalizeIntentValue(b.colorIntent ?? ""))).size,
    ).toBe(2);
  });

  it("a seed hex becomes a color-lock decision, never a brief field (case 16)", async () => {
    const config = buildTestConfig(tmpDir);
    const { runExplore } = await import("./explore.js");

    const result = await runExplore({
      cwd: tmpDir,
      describe: "warm editorial with #ff5722 accents",
      count: 1,
    });
    expect(result.directionIds).toHaveLength(1);

    const core = createDirectionCore(tmpDir, config);
    const id = result.directionIds[0];
    const entries = await core.memoryEntries(id);
    const lock = entries.find(
      (e) => e.kind === "decision" && e.body === "Color locked: #ff5722",
    );
    expect(lock).toBeDefined();
    const record = await core.get(id);
    expect(JSON.stringify(record.brief)).not.toContain("#ff5722");
  });

  it("--from seeds divergent mode with the greppable provenance token (case 17)", async () => {
    const config = buildTestConfig(tmpDir);
    await seedDirection(tmpDir, config, "warm", {
      oneLiner: "A warm brand.",
      positioning: "cozy editorial",
    });
    const { runExplore } = await import("./explore.js");

    const result = await runExplore({ cwd: tmpDir, from: "warm", count: 2 });
    expect(result.direction).toBe("warm");
    expect(result.directionIds).toHaveLength(2);
    expect(result.directionIds).not.toContain("warm");

    const core = createDirectionCore(tmpDir, config);
    for (const id of result.directionIds) {
      const record = await core.get(id);
      expect(record.versions).toHaveLength(1);
      // Keyless floor: every floor brief embeds the source id (Replan #6).
      expect(record.brief.otherNotes).toContain("Derived from warm");
    }
  });
});
