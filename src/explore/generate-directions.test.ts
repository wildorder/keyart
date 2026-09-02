import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";
import {
  buildPlaceholderDirections,
  type SeedDirection,
} from "./placeholders.js";
import { generateDirections } from "./generate-directions.js";
import { contrastRatio } from "../brand/palette.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

const SAMPLE_BRIEF = "We are building a productivity app for remote teams. The audience is tech-savvy professionals aged 25-40.";

describe("buildPlaceholderDirections", () => {
  it("returns exactly 3 valid directions", () => {
    const dirs = buildPlaceholderDirections(SAMPLE_BRIEF);
    expect(dirs).toHaveLength(3);
  });

  it("each direction has all required schema fields", () => {
    const dirs = buildPlaceholderDirections(SAMPLE_BRIEF);
    for (const d of dirs) {
      expect(typeof d.id).toBe("string");
      expect(typeof d.name).toBe("string");
      expect(typeof d.summary).toBe("string");
      expect(typeof d.positioning).toBe("string");
      expect(typeof d.character).toBe("object");
      expect(typeof d.homepageMockupPrompt).toBe("string");
      expect(typeof d.styleTilePrompt).toBe("string");
      expect(typeof d.copyExamples.headline).toBe("string");
      expect(typeof d.copyExamples.subheadline).toBe("string");
      expect(typeof d.copyExamples.cta).toBe("string");
      expect(Array.isArray(d.usage.rules)).toBe(true);
      expect(Array.isArray(d.usage.antiRules)).toBe(true);
    }
  });

  it("uses kebab-case ids: direction-a, direction-b, direction-c", () => {
    const dirs = buildPlaceholderDirections(SAMPLE_BRIEF);
    expect(dirs.map((d) => d.id)).toEqual([
      "direction-a",
      "direction-b",
      "direction-c",
    ]);
  });

  it("is deterministic — same brief produces same output", () => {
    const a = buildPlaceholderDirections(SAMPLE_BRIEF);
    const b = buildPlaceholderDirections(SAMPLE_BRIEF);
    expect(a).toEqual(b);
  });
});

describe("generateDirections", () => {
  const originalKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.OPENAI_API_KEY = originalKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    vi.restoreAllMocks();
  });

  it("returns placeholders when no API key is set (dry-run)", async () => {
    delete process.env.OPENAI_API_KEY;
    const dirs = await generateDirections(SAMPLE_BRIEF, { text: "gpt-5.5" });
    const placeholders = buildPlaceholderDirections(SAMPLE_BRIEF);
    expect(dirs).toEqual(placeholders);
  });

  it("falls back to placeholders when chatJson returns invalid data", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    vi.spyOn(openaiModule, "chatJson").mockResolvedValue({
      data: { directions: [{ bad: "data" }] } as any,
      dryRun: false,
    });

    const dirs = await generateDirections(SAMPLE_BRIEF, { text: "gpt-5.5" });
    const placeholders = buildPlaceholderDirections(SAMPLE_BRIEF);
    expect(dirs).toEqual(placeholders);
  });

  it("falls back to placeholders when chatJson throws", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    vi.spyOn(openaiModule, "chatJson").mockRejectedValue(
      new Error("Network error"),
    );

    const dirs = await generateDirections(SAMPLE_BRIEF, { text: "gpt-5.5" });
    const placeholders = buildPlaceholderDirections(SAMPLE_BRIEF);
    expect(dirs).toEqual(placeholders);
  });

  it("passes models.text from config to chatJson, not a hardcoded value", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    const chatJsonSpy = vi.spyOn(openaiModule, "chatJson").mockResolvedValue({
      data: null as any,
      dryRun: true,
    });

    const customModel = "gpt-4o-custom";
    await generateDirections(SAMPLE_BRIEF, { text: customModel });

    expect(chatJsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({ model: customModel }),
    );
  });

  const VALID_DIRECTIONS = buildPlaceholderDirections(SAMPLE_BRIEF);

  it("routes through visionJson (sending the images) when references + a vision model are present", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    const chatJsonSpy = vi.spyOn(openaiModule, "chatJson");
    const visionSpy = vi
      .spyOn(openaiModule, "visionJson")
      .mockResolvedValue({
        data: { directions: VALID_DIRECTIONS } as never,
        dryRun: false,
      });

    const dirs = await generateDirections(
      SAMPLE_BRIEF,
      { text: "gpt-5.5", vision: "gpt-5.5" },
      { referenceImagePaths: ["/abs/a.png"] },
    );

    expect(visionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.5",
        imagePaths: ["/abs/a.png"],
      }),
    );
    expect(chatJsonSpy).not.toHaveBeenCalled();
    // Same directions come back, now with engine-stamped tokens (SC-02).
    expect(dirs.map((d) => d.id)).toEqual(VALID_DIRECTIONS.map((d) => d.id));
    for (const d of dirs) expect(d.tokens?.palette).toHaveLength(6);
  });

  it("uses the text route (chatJson, not visionJson) when there are no references", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    const visionSpy = vi.spyOn(openaiModule, "visionJson");
    const chatJsonSpy = vi.spyOn(openaiModule, "chatJson").mockResolvedValue({
      data: { directions: VALID_DIRECTIONS } as never,
      dryRun: false,
    });

    await generateDirections(SAMPLE_BRIEF, { text: "gpt-5.5", vision: "gpt-5.5" });

    expect(chatJsonSpy).toHaveBeenCalled();
    expect(visionSpy).not.toHaveBeenCalled();
  });

  it("falls back to the text route when references exist but no vision model is configured", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    const visionSpy = vi.spyOn(openaiModule, "visionJson");
    const chatJsonSpy = vi.spyOn(openaiModule, "chatJson").mockResolvedValue({
      data: { directions: VALID_DIRECTIONS } as never,
      dryRun: false,
    });

    await generateDirections(
      SAMPLE_BRIEF,
      { text: "gpt-5.5" }, // no vision model
      { referenceImagePaths: ["/abs/a.png"] },
    );

    expect(chatJsonSpy).toHaveBeenCalled();
    expect(visionSpy).not.toHaveBeenCalled();
  });

  it("does not call the vision model on a dry-run, even with references", async () => {
    delete process.env.OPENAI_API_KEY;

    const openaiModule = await import("../openai.js");
    const visionSpy = vi.spyOn(openaiModule, "visionJson");
    const chatJsonSpy = vi.spyOn(openaiModule, "chatJson");

    const dirs = await generateDirections(
      SAMPLE_BRIEF,
      { text: "gpt-5.5", vision: "gpt-5.5" },
      { referenceImagePaths: ["/abs/a.png"] },
    );

    expect(visionSpy).not.toHaveBeenCalled();
    expect(chatJsonSpy).not.toHaveBeenCalled();
    expect(dirs).toEqual(buildPlaceholderDirections(SAMPLE_BRIEF));
  });

  it("falls back to placeholders when the vision route returns invalid directions", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    vi.spyOn(openaiModule, "visionJson").mockResolvedValue({
      data: { directions: [{ bad: "data" }] } as never,
      dryRun: false,
    });

    const dirs = await generateDirections(
      SAMPLE_BRIEF,
      { text: "gpt-5.5", vision: "gpt-5.5" },
      { referenceImagePaths: ["/abs/a.png"] },
    );
    expect(dirs).toEqual(buildPlaceholderDirections(SAMPLE_BRIEF));
  });

  it("injects the context block into the live user prompt", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    const chatJsonSpy = vi.spyOn(openaiModule, "chatJson").mockResolvedValue({
      data: null as any,
      dryRun: true,
    });

    const contextBlock =
      "## Non-Negotiable Global Rules (HARD)\n- Never use pure black";
    await generateDirections(SAMPLE_BRIEF, { text: "gpt-5.5" }, { contextBlock });

    expect(chatJsonSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.stringContaining(contextBlock),
      }),
    );
  });

  it("dry-run placeholders are unaffected by a context block", async () => {
    delete process.env.OPENAI_API_KEY;
    const placeholders = buildPlaceholderDirections(SAMPLE_BRIEF);

    const withoutContext = await generateDirections(SAMPLE_BRIEF, {
      text: "gpt-5.5",
    });
    const withContext = await generateDirections(
      SAMPLE_BRIEF,
      { text: "gpt-5.5" },
      { contextBlock: "## Non-Negotiable Global Rules (HARD)\n- Never use pure black" },
    );

    expect(withoutContext).toEqual(placeholders);
    expect(withContext).toEqual(placeholders);
  });

  const ALL_ROLES = [
    "primary",
    "secondary",
    "background",
    "surface",
    "text",
    "muted",
  ];

  /** Placeholder directions carrying a model-style `tokenIntent`, no `tokens`. */
  function directionsWithIntent(): (SeedDirection & { tokenIntent: unknown })[] {
    return buildPlaceholderDirections(SAMPLE_BRIEF).map((d, i) => {
      const clone: SeedDirection & { tokenIntent: unknown } = {
        ...d,
        tokenIntent: {
          baseHue: 200 + i * 20,
          scheme: "complementary",
          fontPairingId: "dm-sans-inter",
        },
      };
      delete clone.tokens; // model returns intent, not final tokens
      return clone;
    });
  }

  it("stamps engine tokens on every live direction and strips tokenIntent (SC-02)", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    vi.spyOn(openaiModule, "chatJson").mockResolvedValue({
      data: { directions: directionsWithIntent() } as never,
      dryRun: false,
    });

    const dirs = await generateDirections(SAMPLE_BRIEF, { text: "gpt-5.5" }, { seed: 42 });

    expect(dirs.length).toBeGreaterThan(0);
    for (const d of dirs) {
      expect(d.tokens?.palette.map((t) => t.role)).toEqual(ALL_ROLES);
      expect(d.tokens?.typography.heading).toBe("DM Sans");
      expect(d.tokens?.provenance?.seed).toBeGreaterThanOrEqual(42);
      expect((d as unknown as Record<string, unknown>).tokenIntent).toBeUndefined();
    }
  });

  it("falls back to engine tokens for malformed/absent intent (contrast holds)", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const base = buildPlaceholderDirections(SAMPLE_BRIEF);
    const garbage: SeedDirection & { tokenIntent: unknown } = {
      ...base[0],
      tokenIntent: "not-an-object",
    };
    delete garbage.tokens;
    const absent: SeedDirection = { ...base[1] };
    delete absent.tokens; // no tokenIntent at all

    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    vi.spyOn(openaiModule, "chatJson").mockResolvedValue({
      data: { directions: [garbage, absent] } as never,
      dryRun: false,
    });

    const dirs = await generateDirections(SAMPLE_BRIEF, { text: "gpt-5.5" }, { seed: 3 });

    expect(dirs).toHaveLength(2);
    for (const d of dirs) {
      expect(d.tokens?.palette).toHaveLength(6);
      const text = d.tokens!.palette.find((t) => t.role === "text")!;
      const bg = d.tokens!.palette.find((t) => t.role === "background")!;
      expect(contrastRatio(text.hex, bg.hex)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("plumbs prior-run palettes as anti-examples (changes the result)", async () => {
    process.env.OPENAI_API_KEY = "test-key";

    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    vi.spyOn(openaiModule, "chatJson").mockResolvedValue({
      data: { directions: directionsWithIntent() } as never,
      dryRun: false,
    });

    const without = await generateDirections(
      SAMPLE_BRIEF,
      { text: "gpt-5.5" },
      { seed: 9 },
    );
    const priorPalettes = [without[0].tokens!.palette.map((t) => t.hex)];
    const with_ = await generateDirections(
      SAMPLE_BRIEF,
      { text: "gpt-5.5" },
      { seed: 9, priorPalettes },
    );

    expect(JSON.stringify(with_[0].tokens?.palette)).not.toBe(
      JSON.stringify(without[0].tokens?.palette),
    );
  });

  it("dry-run returns token-emitting placeholders unchanged (no double-stamp)", async () => {
    delete process.env.OPENAI_API_KEY;
    const dirs = await generateDirections(SAMPLE_BRIEF, { text: "gpt-5.5" }, { seed: 5 });
    expect(dirs).toEqual(buildPlaceholderDirections(SAMPLE_BRIEF));
    for (const d of dirs) {
      expect(d.tokens?.palette).toHaveLength(6);
    }
  });

  // ── WS-01 guard: character/usage accepted, legacy freeform rejected ──────────

  /** A minimal valid model direction in the NEW structured shape. */
  function structuredDirection(): Record<string, unknown> {
    return {
      id: "direction-x",
      name: "Structured",
      summary: "A structured direction.",
      positioning: "Positioned clearly.",
      character: { mood: "calm", layout: "spacious" },
      homepageMockupPrompt: "homepage prompt",
      styleTilePrompt: "style tile prompt",
      copyExamples: { headline: "H", subheadline: "S", cta: "C" },
      usage: { rules: ["do this"], antiRules: ["never that"] },
    };
  }

  it("guard accepts a character/usage direction (SC-02)", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    vi.spyOn(openaiModule, "chatJson").mockResolvedValue({
      data: { directions: [structuredDirection()] } as never,
      dryRun: false,
    });

    const dirs = await generateDirections(SAMPLE_BRIEF, { text: "gpt-5.5" });
    // A valid structured direction is returned (not the placeholder fallback).
    expect(dirs).toHaveLength(1);
    expect(dirs[0].id).toBe("direction-x");
    expect(dirs[0].character.mood).toBe("calm");
    expect(dirs[0].usage.rules).toEqual(["do this"]);
  });

  it("guard rejects a legacy visualStyle/designRules/antiRules-only direction", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const legacy = {
      id: "direction-legacy",
      name: "Legacy",
      summary: "A legacy freeform direction.",
      positioning: "Positioned.",
      visualStyle: "Bold and modern with strong contrast.",
      homepageMockupPrompt: "homepage prompt",
      styleTilePrompt: "style tile prompt",
      copyExamples: { headline: "H", subheadline: "S", cta: "C" },
      designRules: ["a", "b", "c"],
      antiRules: ["x", "y"],
    };
    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    vi.spyOn(openaiModule, "chatJson").mockResolvedValue({
      data: { directions: [legacy] } as never,
      dryRun: false,
    });

    const dirs = await generateDirections(SAMPLE_BRIEF, { text: "gpt-5.5" });
    // The freeform shape is now invalid → falls back to placeholders.
    expect(dirs).toEqual(buildPlaceholderDirections(SAMPLE_BRIEF));
  });

  it("guard accepts empty structured usage — no minimum counts (SC-09)", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const empty = {
      ...structuredDirection(),
      character: {},
      usage: { rules: [], antiRules: [] },
    };
    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    vi.spyOn(openaiModule, "chatJson").mockResolvedValue({
      data: { directions: [empty] } as never,
      dryRun: false,
    });

    const dirs = await generateDirections(SAMPLE_BRIEF, { text: "gpt-5.5" });
    // Empty-but-present structured fields validate (not a fallback).
    expect(dirs).toHaveLength(1);
    expect(dirs[0].id).toBe("direction-x");
    expect(dirs[0].usage.rules).toEqual([]);
  });
});

describe("runExplore integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-explore-"));
    // Set up minimal brand structure with brief
    const brandDir = path.join(tmpDir, "brand", "input");
    await fs.mkdir(brandDir, { recursive: true });
    await fs.writeFile(
      path.join(brandDir, "brief.md"),
      SAMPLE_BRIEF,
      "utf-8",
    );
  });

  afterEach(async () => {
    delete process.env.OPENAI_API_KEY;
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("seeds 3 sibling directions, each with a v1 version + prompt files", async () => {
    delete process.env.OPENAI_API_KEY;

    // Mock loadConfig to return a config pointing at tmpDir paths
    const { loadConfig } = await import("../config.js");
    const config: KeyartConfig = {
      project: { name: "Test", type: "prototype", framework: "next" },
      brand: {
        root: path.join(tmpDir, "brand"),
        references: path.join(tmpDir, "brand", "input", "references"),
        approved: path.join(tmpDir, "brand", "approved"),
        rejected: path.join(tmpDir, "brand", "rejected"),
      },
      models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
      outputs: {
        cursorRules: ".cursor/rules/keyart-brand.mdc",
        cssVars: "brand/generated/brand.css",
        implementationBrief: "brand/generated/implementation-brief.md",
      },
    };
    vi.mocked(loadConfig).mockResolvedValue(config);

    const { runExplore } = await import("../commands/explore.js");
    const { listDirectionIds, readHead } = await import("../direction/store.js");
    const { createDirectionCore } = await import("../direction/core.js");

    // Directions no longer have an auto-scaffolded default — explore reads its
    // seed brief off an EXISTING direction, so create one first.
    const seedCore = createDirectionCore(tmpDir, config);
    await seedCore.create({
      id: "seed",
      name: "Seed",
      brief: { positioning: SAMPLE_BRIEF },
    });

    const result = await runExplore({ cwd: tmpDir, from: "seed" });

    // Three brand-new directions minted flat under directions/ —
    // no run folder, no directions.json batch file.
    expect(result.directionIds).toHaveLength(3);
    const directionsDir = path.join(tmpDir, "brand", "directions");
    const ids = await listDirectionIds(directionsDir);
    expect(ids.sort()).toEqual([...result.directionIds, "seed"].sort());
    expect(await fs.access(path.join(directionsDir, "..", "runs")).then(
      () => true,
      () => false,
    )).toBe(false);

    // Each direction has a v1 head and a versions/<versionId>/ folder carrying
    // the version record + both prompt files.
    for (const directionId of result.directionIds) {
      const record = await seedCore.get(directionId);
      expect(record.versions).toHaveLength(1);
      expect(record.head).toBe(record.versions[0]);
      const head = await readHead(directionsDir, directionId);
      expect(head.id).toBe(record.head);

      const versionDir = path.join(
        directionsDir,
        directionId,
        "versions",
        record.head!,
      );
      const versionJson = JSON.parse(
        await fs.readFile(
          path.join(versionDir, "direction-version.json"),
          "utf-8",
        ),
      );
      expect(versionJson.id).toBe(record.head);

      const styleTile = await fs.readFile(
        path.join(versionDir, "style-tile-prompt.md"),
        "utf-8",
      );
      expect(styleTile.trim().length).toBeGreaterThan(0);

      const homepage = await fs.readFile(
        path.join(versionDir, "homepage-mockup-prompt.md"),
        "utf-8",
      );
      expect(homepage.trim().length).toBeGreaterThan(0);
    }
  });
});
