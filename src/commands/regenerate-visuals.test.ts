import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  KeyartConfig,
  PaletteRole,
  PaletteToken,
  DirectionVersion,
} from "../types.js";
import type { PaletteLock } from "../brand/palette.js";
import type { Contradiction } from "../brand/conflict-guard.js";

// Mock loadConfig only — every other config.js export (directionsRoot,
// globalBrandPath, storeDriver) keeps its real implementation so the cores
// resolve real on-disk paths under the tmp project. Deterministic, network-free.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

import { runExplore } from "./explore.js";
import { runRegenerateVisuals } from "./regenerate-visuals.js";
import { runEditDirection } from "./edit-direction.js";
import { directionsRoot } from "../config.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { readHead } from "../direction/store.js";
import * as openai from "../openai.js";
import * as extractTokens from "../brand/extract-tokens.js";
import * as extractType from "../brand/extract-type.js";

/**
 * WS-01 (`direction-aggregate-root`) made Direction the TOP-LEVEL aggregate
 * root, and WS-16 made positional `explore <directionId>` write v1 INTO an
 * existing draft (it no longer mints siblings). `scaffold()` below creates
 * draft directions with the exact ids the tests reference ("direction-a",
 * then "direction-b" for `count` 2) and runs one positional explore per
 * draft; the keyless run writes the deterministic placeholder v1
 * (`src/explore/placeholders.ts`) — no network.
 */
const DIRECTION_ID = "direction-a";

const ROLES: PaletteRole[] = [
  "primary",
  "secondary",
  "background",
  "surface",
  "text",
  "muted",
];

/** The prose/copy subset SC-07 mandates a regenerate leaves byte-untouched. */
function prose(d: DirectionVersion): Record<string, unknown> {
  return {
    name: d.name,
    summary: d.summary,
    positioning: d.positioning,
    character: d.character,
    homepageMockupPrompt: d.homepageMockupPrompt,
    styleTilePrompt: d.styleTilePrompt,
    copyExamples: d.copyExamples,
    usage: d.usage,
  };
}

/**
 * Stub the inverted-spine read: {@link openai.describeImageBrand} returns an
 * empty (network-free) read, and {@link extractTokens.tokensFromRoledColors}
 * echoes the primary lock verbatim (SC-06) and rotates every unlocked role to a
 * distinct sentinel hex, capturing the `locks` it was handed so a test can
 * assert the built lock set.
 */
function stubExtraction(captured: PaletteLock[][]): void {
  const sentinels: Record<PaletteRole, string> = {
    primary: "#101010",
    secondary: "#202020",
    background: "#f0f0f0",
    surface: "#e0e0e0",
    text: "#050505",
    muted: "#909090",
  };
  vi.spyOn(openai, "describeImageBrand").mockResolvedValue({
    read: { colors: [], type: {} },
    dryRun: false,
  } as never);
  vi.spyOn(extractTokens, "tokensFromRoledColors").mockImplementation(
    (_colors, opts) => {
      const locks = opts?.locks ?? [];
      captured.push(locks);
      const lockedPrimary = locks.find((l) => l.role === "primary")?.hex;
      const palette: PaletteToken[] = ROLES.map((role) => ({
        role,
        name: role,
        hex: role === "primary" && lockedPrimary ? lockedPrimary : sentinels[role],
      }));
      return {
        tokens: {
          palette,
          typography: { heading: "Poppins", body: "Inter" },
          shape: { radius: "8px", spacingUnit: "8px" },
        },
        palette: [],
      };
    },
  );
  vi.spyOn(extractType, "mapTypeRead").mockReturnValue({
    typography: { heading: "Poppins", body: "Inter" },
    approximate: true,
  });
}

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Regenerate ITest", type: "prototype", framework: "next" },
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

let tmpDir: string;
let savedKey: string | undefined;

async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path to the flat directions collection root (`brand/directions`). */
function directionsDir(): string {
  return directionsRoot(tmpDir, buildTestConfig(tmpDir));
}

/** Reads a direction's current record (versions[]/head) off disk. */
async function directionRecord(id: string) {
  const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
  return core.get(id);
}

/** Absolute path to a direction's head-version folder. */
async function versionFolder(directionId = DIRECTION_ID): Promise<string> {
  const record = await directionRecord(directionId);
  return path.join(directionsDir(), directionId, "versions", record.head!);
}

/** The path to the head version's persisted record. */
async function versionJson(directionId = DIRECTION_ID): Promise<string> {
  return path.join(await versionFolder(directionId), "direction-version.json");
}

/**
 * Create `count` draft directions ("direction-a", then "direction-b", …) and
 * give each a v1 via one positional explore (dry-run: no key ⇒ deterministic
 * placeholder template, no network). Returns the head version of
 * DIRECTION_ID ("direction-a"). `resolveDirection` never auto-scaffolds
 * (WS-01), so every test that exercises `runRegenerateVisuals`/
 * `runEditDirection` must create its target direction first — this is that
 * fixture.
 */
async function scaffold(count = 1): Promise<{ direction: DirectionVersion }> {
  const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
  const ids = ["direction-a", "direction-b", "direction-c"].slice(0, count);
  for (const id of ids) {
    await core.create({ id, name: id });
    await runExplore({ cwd: tmpDir, directionId: id });
  }
  const direction = JSON.parse(
    await fs.readFile(await versionJson(), "utf-8"),
  ) as DirectionVersion;
  expect(direction.tokens).toBeDefined(); // the run supplies a tokened direction
  return { direction };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-regen-"));
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY; // default dry-run; individual tests opt into a key
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

describe("runRegenerateVisuals — token-aware regenerate (WS-04)", () => {
  it("re-renders the deterministic board (SVG + markdown) with no key, model-free", async () => {
    const { direction } = await scaffold();

    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    expect(result.dryRun).toBe(true); // proved key-free
    expect(result.boardWritten).toBe(true);

    const folder = await versionFolder();
    const mdPath = path.join(folder, "style-board.md");
    const svgPath = path.join(folder, "style-board.svg");
    expect(await exists(mdPath)).toBe(true);
    expect(await exists(svgPath)).toBe(true);

    const rel = (abs: string): string =>
      path.relative(tmpDir, abs).split(path.sep).join("/");
    expect(result.filesWritten).toContain(rel(mdPath));
    expect(result.filesWritten).toContain(rel(svgPath));

    // Board hexes match the direction's tokens.
    const md = await fs.readFile(mdPath, "utf-8");
    for (const t of direction.tokens!.palette) expect(md).toContain(t.hex);

    // No PNGs in a keyless run.
    for (const p of result.filesWritten) expect(p.endsWith(".png")).toBe(false);
  });

  it("regenerates the style-tile, homepage, AND evocative-board image prompts freely — no hard color/type lock (SC-03)", async () => {
    await scaffold();
    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    // Three image generations: style-tile, homepage, evocative board. Per the
    // inverted spine each prompt carries the CONTENT LOCK but NO hard color/type
    // lock — the image renders freely and tokens are read back afterward.
    expect(genSpy).toHaveBeenCalledTimes(3);
    for (const call of genSpy.mock.calls) {
      const prompt = (call[0] as { prompt: string }).prompt;
      expect(prompt).toContain("CONTENT LOCK");
      expect(prompt).not.toContain("COLOR & TYPE LOCK");
      expect(prompt.toLowerCase()).not.toContain("use only");
    }
  });

  it("generates the evocative style-board.png in the version folder", async () => {
    await scaffold();
    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });

    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    const rel = (abs: string): string =>
      path.relative(tmpDir, abs).split(path.sep).join("/");
    const boardPng = rel(path.join(await versionFolder(), "style-board.png"));
    expect(result.filesWritten).toContain(boardPng);

    // One generateImage call targeted style-board.png, reference-capable.
    const boardCall = genSpy.mock.calls.find((c) =>
      (c[0] as { outPath: string }).outPath.endsWith("style-board.png"),
    );
    expect(boardCall).toBeDefined();
    expect((boardCall![0] as { referenceImagePaths?: string[] }).referenceImagePaths)
      .toBeDefined();
  });

  it("re-extracts tokens into the NEW version, leaving the prior version + prose/copy + memory untouched (SC-06/SC-07)", async () => {
    const { direction: before } = await scaffold();
    const v1Json = await versionJson(); // v1 head path, captured BEFORE the append
    const memoryYaml = path.join(directionsDir(), DIRECTION_ID, "memory.yaml");
    const memoryBefore = await fs.readFile(memoryYaml, "utf-8");

    process.env.OPENAI_API_KEY = "test-key";
    vi.spyOn(openai, "generateImage").mockResolvedValue({
      written: true,
      dryRun: false,
    });
    const captured: PaletteLock[][] = [];
    stubExtraction(captured); // no locks → the whole palette rotates to sentinels

    // A PLAIN regenerate (no keep/tweak) stays memory-neutral.
    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    // The prior version (v1) is byte-unchanged — append-only history.
    const v1After = JSON.parse(
      await fs.readFile(v1Json, "utf-8"),
    ) as DirectionVersion;
    expect(v1After).toEqual(before);

    // The new head carries the re-extracted tokens; prose/copy is cloned verbatim.
    const head = JSON.parse(
      await fs.readFile(await versionJson(), "utf-8"),
    ) as DirectionVersion;
    expect(head.id).toBe(result.versionId);
    expect(prose(head)).toEqual(prose(before));
    expect(head.tokens!.palette.find((t) => t.role === "secondary")!.hex).toBe(
      "#202020",
    );
    expect(head.tokens).not.toEqual(before.tokens);

    // A plain regenerate writes no direction memory.
    const memoryAfter = await fs.readFile(memoryYaml, "utf-8");
    expect(memoryAfter).toBe(memoryBefore);
  });

  it("collects a graceful image skip without throwing, still writing the board", async () => {
    await scaffold();
    process.env.OPENAI_API_KEY = "test-key";
    vi.spyOn(openai, "generateImage").mockResolvedValue({
      written: false,
      dryRun: false,
      skippedReason: "capability boom",
    });

    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    // Skip reason collected once per gated image (3), never thrown.
    expect(result.imageSkips.filter((s) => s === "capability boom")).toHaveLength(3);
    // The deterministic board is still produced.
    expect(result.boardWritten).toBe(true);
    expect(
      await exists(path.join(await versionFolder(), "style-board.md")),
    ).toBe(true);
  });

  it("applies a one-shot tweak to the image prompts only, never persisting it", async () => {
    const { direction: before } = await scaffold();
    const directionVersionJson = await versionJson();

    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });
    stubExtraction([]);

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
      tweak: "more neon",
    });

    // Tweak reached every image prompt this pass.
    for (const call of genSpy.mock.calls) {
      expect((call[0] as { prompt: string }).prompt).toContain("more neon");
    }
    // …but was NOT persisted: the stored prose/copy is byte-identical and no
    // field carries the tweak text (only the tokens were re-extracted).
    const after = JSON.parse(
      await fs.readFile(directionVersionJson, "utf-8"),
    ) as DirectionVersion;
    expect(prose(after)).toEqual(prose(before));
    expect(JSON.stringify(after)).not.toContain("more neon");
  });

  it("holds a locked role verbatim while unlocked roles rotate on re-extraction (SC-06)", async () => {
    const { direction: before } = await scaffold();
    const origPrimary = before.tokens!.palette.find((t) => t.role === "primary")!.hex;
    const origSecondary = before.tokens!.palette.find(
      (t) => t.role === "secondary",
    )!.hex;

    process.env.OPENAI_API_KEY = "test-key";
    vi.spyOn(openai, "generateImage").mockResolvedValue({
      written: true,
      dryRun: false,
    });
    const captured: PaletteLock[][] = [];
    stubExtraction(captured);

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
      lockedRoles: ["primary"],
    });

    // The lock set fed to extraction pinned primary at its CURRENT value.
    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0]).toContainEqual({ role: "primary", hex: origPrimary });

    const after = JSON.parse(
      await fs.readFile(await versionJson(), "utf-8"),
    ) as DirectionVersion;
    const paletteAfter = after.tokens!.palette;
    // Locked primary preserved verbatim; an unlocked role rotated.
    expect(paletteAfter.find((t) => t.role === "primary")!.hex).toBe(origPrimary);
    expect(paletteAfter.find((t) => t.role === "secondary")!.hex).toBe("#202020");
    expect(paletteAfter.find((t) => t.role === "secondary")!.hex).not.toBe(
      origSecondary,
    );
  });

  it("pushes explicit lockedColors into the soft guidance + honors them as extraction locks (SC-13)", async () => {
    await scaffold();

    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });
    const captured: PaletteLock[][] = [];
    stubExtraction(captured);

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
      lockedColors: [{ role: "secondary", hex: "#abcdef" }],
    });

    // The style-tile + homepage prompts (which route through the soft guidance)
    // carry the pushed hex; still NO hard "use ONLY … fonts" lock anywhere.
    const guided = genSpy.mock.calls.filter((c) => {
      const out = (c[0] as { outPath: string }).outPath;
      return out.endsWith("style-tile.png") || out.endsWith("homepage-mockup.png");
    });
    expect(guided).toHaveLength(2);
    for (const call of guided) {
      const prompt = (call[0] as { prompt: string }).prompt;
      expect(prompt).toContain("COLOR GUIDANCE (soft)");
      expect(prompt).toContain("#abcdef");
    }
    for (const call of genSpy.mock.calls) {
      expect((call[0] as { prompt: string }).prompt.toLowerCase()).not.toContain(
        "use only",
      );
    }
    // The same hex reaches extraction as a verbatim role lock.
    expect(captured[0]).toContainEqual({ role: "secondary", hex: "#abcdef" });
  });

  it("steers this pass with a generic feedback note without persisting it (SC-08)", async () => {
    const { direction: before } = await scaffold();
    const directionVersionJson = await versionJson();

    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });
    stubExtraction([]);

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
      feedbackNote: "warmer, more editorial",
    });

    // The note reached every image prompt this pass…
    expect(genSpy).toHaveBeenCalledTimes(3);
    for (const call of genSpy.mock.calls) {
      expect((call[0] as { prompt: string }).prompt).toContain(
        "warmer, more editorial",
      );
    }
    // …but was never persisted (prose/copy unchanged; no field carries it).
    const after = JSON.parse(
      await fs.readFile(directionVersionJson, "utf-8"),
    ) as DirectionVersion;
    expect(prose(after)).toEqual(prose(before));
    expect(JSON.stringify(after)).not.toContain("warmer, more editorial");
  });
});

describe("runRegenerateVisuals — feedback appends a version (WS-03)", () => {
  it("appends a v2 (head advances; prior version byte-unchanged) with a key (SC-06)", async () => {
    const { direction: before } = await scaffold();
    const v1Json = await versionJson(); // v1 path captured BEFORE the append

    const recordBefore = await directionRecord(DIRECTION_ID);
    expect(recordBefore.versions).toHaveLength(1);

    process.env.OPENAI_API_KEY = "test-key";
    vi.spyOn(openai, "generateImage").mockResolvedValue({
      written: true,
      dryRun: false,
    });
    stubExtraction([]);

    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    // A NEW version was appended and is the head.
    const recordAfter = await directionRecord(DIRECTION_ID);
    expect(recordAfter.versions).toHaveLength(2);
    expect(recordAfter.head).toBe(result.versionId);
    expect(result.versionId).not.toBe(before.id);

    // The prior version's record is byte-identical (append-only — never overwritten).
    const v1After = JSON.parse(
      await fs.readFile(v1Json, "utf-8"),
    ) as DirectionVersion;
    expect(v1After).toEqual(before);
  });

  it("holds a locked role verbatim while unlocked roles re-extract on the NEW version (SC-06)", async () => {
    const { direction: before } = await scaffold();
    const origPrimary = before.tokens!.palette.find((t) => t.role === "primary")!.hex;

    process.env.OPENAI_API_KEY = "test-key";
    vi.spyOn(openai, "generateImage").mockResolvedValue({
      written: true,
      dryRun: false,
    });
    const captured: PaletteLock[][] = [];
    stubExtraction(captured);

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
      lockedRoles: ["primary"],
    });

    // The role-aware lock reached extraction verbatim.
    expect(captured[0]).toContainEqual({ role: "primary", hex: origPrimary });

    const head = await readHead(directionsDir(), DIRECTION_ID);
    const palette = head.tokens!.palette;
    expect(palette.find((t) => t.role === "primary")!.hex).toBe(origPrimary); // held
    expect(palette.find((t) => t.role === "secondary")!.hex).toBe("#202020"); // rotated
  });

  it("keep+tweak folds into a regenerate that appends a version and logs attributed feedback (SC-07)", async () => {
    const { direction: before } = await scaffold();
    const v1Json = await versionJson();

    process.env.OPENAI_API_KEY = "test-key";
    vi.spyOn(openai, "generateImage").mockResolvedValue({
      written: true,
      dryRun: false,
    });
    stubExtraction([]);

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
      keep: ["layout"],
      tweak: "warmer",
    });

    // Head advanced to a v2; the prior version is untouched.
    const record = await directionRecord(DIRECTION_ID);
    expect(record.versions).toHaveLength(2);
    const v1After = JSON.parse(
      await fs.readFile(v1Json, "utf-8"),
    ) as DirectionVersion;
    expect(v1After).toEqual(before);

    // The new head's prose/copy is the head's (regenerate never rewrites copy).
    const head = await readHead(directionsDir(), DIRECTION_ID);
    expect(prose(head)).toEqual(prose(before));

    // An attributed `source: "regenerate"` feedback entry carries keep + tweak.
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    const entries = (await core.memoryEntries(DIRECTION_ID)).filter(
      (e) => e.kind === "feedback",
    );
    const entry = entries.find((e) => e.source === "regenerate");
    expect(entry).toBeDefined();
    expect(entry!.body).toContain("layout");
    expect(entry!.body).toContain("warmer");
  });

  it("dry-run (no key) still appends a cloned-token version, no images, never throws (SC-11)", async () => {
    const { direction: before } = await scaffold();

    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    expect(result.dryRun).toBe(true);
    const record = await directionRecord(DIRECTION_ID);
    expect(record.versions).toHaveLength(2); // appended even keyless
    expect(record.head).toBe(result.versionId);

    // Cloned tokens (no tile ⇒ no re-extraction) + a re-rendered deterministic board.
    const head = await readHead(directionsDir(), DIRECTION_ID);
    expect(head.tokens).toEqual(before.tokens);
    expect(result.boardWritten).toBe(true);
    for (const p of result.filesWritten) expect(p.endsWith(".png")).toBe(false);
  });
});

describe("runRegenerateVisuals — negatives & kept-crop biased regeneration (WS-02)", () => {
  /** Write a placeholder image file under the direction and register it as an AssetRef. */
  async function addImageAsset(
    relPath: string,
    intent: "inspire" | "extract",
  ): Promise<string> {
    const abs = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "png-bytes");
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    await core.addAsset(DIRECTION_ID, {
      kind: "image",
      path: relPath,
      intent,
    });
    return path.resolve(tmpDir, relPath);
  }

  it("conditions regenerate on a kept `inspire` crop while excluding an `extract` crop (SC-07/intent routing)", async () => {
    await scaffold();
    const inspireAbs = await addImageAsset(
      `brand/directions/${DIRECTION_ID}/assets/keep-inspire.png`,
      "inspire",
    );
    const extractAbs = await addImageAsset(
      `brand/directions/${DIRECTION_ID}/assets/keep-extract.png`,
      "extract",
    );

    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    const styleCall = genSpy.mock.calls.find((c) =>
      (c[0] as { outPath: string }).outPath.endsWith("style-tile.png"),
    );
    expect(styleCall).toBeDefined();
    const refs = (styleCall![0] as { referenceImagePaths?: string[] })
      .referenceImagePaths;
    expect(refs).toContain(inspireAbs); // kept inspire crop conditions the render
    expect(refs).not.toContain(extractAbs); // extract crop is NOT an image source
  });

  it("injects the direction's discard notes as an AVOID block into all three prompts (SC-06)", async () => {
    await scaffold();
    // A discard feedback entry (feedback + `asset` thumbnail) is a negative.
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    await core.appendFeedback(DIRECTION_ID, {
      body: "garish neon",
      author: "tim",
      source: "element-feedback",
      asset: `brand/directions/${DIRECTION_ID}/discards/thumb.png`,
    });

    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    // All three image prompts carry the AVOID block + the discard body.
    expect(genSpy).toHaveBeenCalledTimes(3);
    for (const call of genSpy.mock.calls) {
      const prompt = (call[0] as { prompt: string }).prompt;
      expect(prompt).toContain("AVOID (do not use):");
      expect(prompt).toContain("garish neon");
    }
  });

  it("a discard thumbnail is NEVER passed to generateImage as a reference (SC-05)", async () => {
    await scaffold();
    const discardThumb = `brand/directions/${DIRECTION_ID}/discards/thumb.png`;
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    await core.appendFeedback(DIRECTION_ID, {
      body: "garish neon",
      author: "tim",
      source: "element-feedback",
      asset: discardThumb,
    });

    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    const discardAbs = path.resolve(tmpDir, discardThumb);
    for (const call of genSpy.mock.calls) {
      const refs =
        (call[0] as { referenceImagePaths?: string[] }).referenceImagePaths ?? [];
      expect(refs).not.toContain(discardAbs);
      expect(refs).not.toContain(discardThumb);
    }
  });

  it("no keeps and no negatives ⇒ prompts carry the content lock only (no hard lock) and no references", async () => {
    await scaffold();

    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    expect(genSpy).toHaveBeenCalledTimes(3);
    for (const call of genSpy.mock.calls) {
      const arg = call[0] as { prompt: string; referenceImagePaths?: string[] };
      expect(arg.prompt).not.toContain("COLOR & TYPE LOCK"); // no hard lock (SC-03)
      expect(arg.prompt).toContain("CONTENT LOCK"); // content projection present
      expect(arg.prompt).not.toContain("AVOID (do not use):"); // no negatives
      expect(arg.referenceImagePaths ?? []).toEqual([]); // no kept crops
    }
  });

  it("regenerates with the EDITED headline, not the stale one baked into the prompt", async () => {
    await scaffold();

    // Edit the headline (the reported regression: prior code kept the old copy).
    const newHeadline = "Provably the freshest in town";
    await runEditDirection({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
      edits: { copyExamples: { headline: newHeadline } },
    });

    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    // Every generated image prompt must carry the CURRENT headline.
    expect(genSpy).toHaveBeenCalledTimes(3);
    for (const call of genSpy.mock.calls) {
      const arg = call[0] as { prompt: string };
      expect(arg.prompt).toContain("CONTENT LOCK");
      expect(arg.prompt).toContain(`Headline: "${newHeadline}"`);
    }
  });

  it("dry-run safe with no key — returns the deterministic board without throwing", async () => {
    await scaffold();
    // No key set (beforeEach clears it). A discard is present but must not break dry-run.
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    await core.appendFeedback(DIRECTION_ID, {
      body: "garish neon",
      author: "tim",
      source: "element-feedback",
      asset: `brand/directions/${DIRECTION_ID}/discards/thumb.png`,
    });
    // generateImage self-handles the no-key case (returns a dry-run result); mock it
    // so the test never touches the network. It is not required to be called.
    vi.spyOn(openai, "generateImage").mockResolvedValue({
      written: false,
      dryRun: true,
    });

    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    expect(result.dryRun).toBe(true);
    expect(result.boardWritten).toBe(true); // deterministic board still renders
  });
});

describe("runRegenerateVisuals — WS-03 art-direction compiler wired into all three prompts", () => {
  /** Add a visual hard rule to the global brand before scaffolding. */
  async function addHardRule(text: string): Promise<void> {
    const brand = createBrandCore(tmpDir, buildTestConfig(tmpDir));
    await brand.addRule({ severity: "hard", text, author: "tim", source: "cli", channel: "visual" });
  }

  /** Add a visual-avoid decision to the direction's own memory. */
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

  /** Add a positive visual decision (prefer) to the direction's own memory. */
  async function addVisualPreferDecision(directionId: string, body: string): Promise<void> {
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    await core.appendDecision(directionId, {
      body,
      author: "tim",
      source: "cli",
      channel: "visual",
      polarity: "prefer",
    });
  }

  /** Add a copy-only learning to the direction's own memory. */
  async function addCopyLearning(directionId: string, body: string): Promise<void> {
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    await core.appendLearning(directionId, {
      body,
      author: "tim",
      source: "cli",
      channel: "copy",
    });
  }

  it("global hard rule + visual-avoid decision land in MUST and AVOID on all three prompts (SC-03)", async () => {
    await addHardRule("Never use a fist-in-the-air icon");
    await scaffold();
    await addVisualAvoidDecision(DIRECTION_ID, "avoid aggressive diagonal layouts");

    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });
    stubExtraction([]);

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    // All three image prompts carry the MUST block with the hard prohibition.
    expect(genSpy).toHaveBeenCalledTimes(3);
    for (const call of genSpy.mock.calls) {
      const prompt = (call[0] as { prompt: string }).prompt;
      expect(prompt).toContain("MUST (non-negotiable — always obey):");
      expect(prompt).toContain("Never use a fist-in-the-air icon");
      // Visual-avoid decision in AVOID.
      expect(prompt).toContain("avoid aggressive diagonal layouts");
    }

    // The written prompt .md files (style-tile + homepage) also carry the MUST block.
    const folder = await versionFolder();
    const styleMd = await fs.readFile(path.join(folder, "style-tile-prompt.md"), "utf-8");
    const homeMd = await fs.readFile(path.join(folder, "homepage-mockup-prompt.md"), "utf-8");
    for (const md of [styleMd, homeMd]) {
      expect(md).toContain("MUST (non-negotiable — always obey):");
      expect(md).toContain("Never use a fist-in-the-air icon");
      expect(md).toContain("avoid aggressive diagonal layouts");
    }
  });

  it("positive visual directive lands in the PREFER/DO block on all three prompts (SC-04)", async () => {
    await scaffold();
    await addVisualPreferDecision(DIRECTION_ID, "prefer warm editorial photography");

    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });
    stubExtraction([]);

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    expect(genSpy).toHaveBeenCalledTimes(3);
    for (const call of genSpy.mock.calls) {
      const prompt = (call[0] as { prompt: string }).prompt;
      expect(prompt).toContain("PREFER (do):");
      expect(prompt).toContain("prefer warm editorial photography");
    }
  });

  it("copy-only entry is absent from all three image prompts (SC-04)", async () => {
    await scaffold();
    await addCopyLearning(DIRECTION_ID, "use conversational tone in all copy");

    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });
    stubExtraction([]);

    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    for (const call of genSpy.mock.calls) {
      const prompt = (call[0] as { prompt: string }).prompt;
      expect(prompt).not.toContain("use conversational tone in all copy");
    }
  });

  it("no-directive path (SC-11) — no directives + no locks ⇒ prompts carry only the content lock; keyless never throws", async () => {
    await scaffold();

    // Keyless, no directives, no locks.
    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    expect(result.dryRun).toBe(true);

    const folder = await versionFolder();
    const styleMd = await fs.readFile(path.join(folder, "style-tile-prompt.md"), "utf-8");
    // MUST/PREFER/AVOID blocks are absent when no directives exist.
    expect(styleMd).not.toContain("MUST (non-negotiable — always obey):");
    expect(styleMd).not.toContain("PREFER (do):");
    // Content lock is still present.
    expect(styleMd).toContain("CONTENT LOCK");
  });

  it("art-direction precedence section is appended to context-snapshot.md (SC-06)", async () => {
    await addHardRule("Never use a fist-in-the-air icon");
    await scaffold();

    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    expect(result.dryRun).toBe(true);

    const folder = await versionFolder();
    const snapshot = await fs.readFile(path.join(folder, "context-snapshot.md"), "utf-8");
    expect(snapshot).toContain("## Art-direction precedence");
    expect(snapshot).toContain("Never use a fist-in-the-air icon");
  });
});

describe("runRegenerateVisuals — WS-04 contradiction detection", () => {
  async function addHardRule(text: string): Promise<void> {
    const brand = createBrandCore(tmpDir, buildTestConfig(tmpDir));
    await brand.addRule({ severity: "hard", text, author: "tim", source: "cli" });
  }

  it("SC-08 test 11: a tweak contradicting a hard rule warns and feedback is still logged", async () => {
    await addHardRule("Never use pure black");
    await scaffold();

    const warnSpy = vi.spyOn(console, "warn");

    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
      tweak: "make it pure black",
    });

    // The contradictionReport carries the hard-rule-guard warning.
    expect(result.contradictionReport.warnings).toHaveLength(1);
    expect(result.contradictionReport.warnings[0].code).toBe("hard-rule-conflict");
    expect(result.contradictionReport.warnings[0].message.length).toBeGreaterThan(0);

    // The warning was rendered to stdout (as console.warn).
    const warnMessages = warnSpy.mock.calls.map((c) => c[0] as string);
    const hasConflictWarning = warnMessages.some((m) =>
      typeof m === "string" && m.includes("hard-rule-conflict"),
    );
    expect(hasConflictWarning).toBe(true);

    // Feedback is still logged even when a contradiction is detected (SC-08).
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    const entries = (await core.memoryEntries(DIRECTION_ID)).filter(
      (e) => e.kind === "feedback",
    );
    const regenerateEntry = entries.find((e) => e.source === "regenerate");
    expect(regenerateEntry).toBeDefined();
    expect(regenerateEntry!.body).toContain("pure black");
  });

  it("SC-11 test 12: detection is prompt-neutral — prompts unchanged with vs without contradiction", async () => {
    await addHardRule("Never use pure black");
    await scaffold();

    // Run with a contradicting tweak — detection fires but prompts are unaffected.
    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
      tweak: "make it pure black",
    });

    // Detection found the clash.
    expect(result.contradictionReport.warnings.length).toBeGreaterThan(0);

    // The prompt files contain the tweak (it was NOT removed — advisory only).
    const folder = await versionFolder();
    const styleMd = await fs.readFile(path.join(folder, "style-tile-prompt.md"), "utf-8");
    const homeMd = await fs.readFile(path.join(folder, "homepage-mockup-prompt.md"), "utf-8");
    expect(styleMd).toContain("make it pure black");
    expect(homeMd).toContain("make it pure black");

    // The prompt files do NOT contain detection-system content (advisory stays off the prompt).
    expect(styleMd).not.toContain("contradictionReport");
    expect(styleMd).not.toContain("hard-rule-conflict");
    expect(homeMd).not.toContain("hard-rule-conflict");

    // Tokens are present (re-extracted as normal).
    expect(result.boardWritten).toBe(true);
  });

  it("SC-11 test 13: no-key floor path warns and never throws", async () => {
    await addHardRule("Never use pure black");
    await scaffold();

    // Keyless run — floor should still detect the contradiction.
    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
      tweak: "make it pure black",
    });

    expect(result.dryRun).toBe(true);
    expect(result.contradictionReport.detector).toBe("deterministic");
    expect(result.contradictionReport.warnings).toHaveLength(1);
    expect(result.contradictionReport.warnings[0].code).toBe("hard-rule-conflict");
  });

  it("SC-07 test 14: mocked semantic adapter surfaces a richer case; compiled block unchanged", async () => {
    await scaffold();
    process.env.OPENAI_API_KEY = "test-key";

    const liveVsMemoryCase: Contradiction = {
      id: "live-vs-memory::live-regen::m1",
      kind: "live-vs-memory",
      subject: { source: "live", id: "live-regen", text: "make it cool" },
      conflictsWith: { source: "memory", id: "m1", body: "warm editorial" } as never,
      severity: "info",
      explanation: "Live instruction opposes a memory preference.",
      suggestions: ["retire"],
    };

    // Mock openai.ts detectContradictionsLLM to return a live-vs-memory case.
    vi.spyOn(openai, "detectContradictionsLLM" as never).mockResolvedValue({
      contradictions: [liveVsMemoryCase],
      dryRun: false,
    } as never);
    vi.spyOn(openai, "generateImage").mockResolvedValue({ written: false, dryRun: false });
    stubExtraction([]);

    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
      tweak: "make it cool",
    });

    // The semantic case surfaces in the report.
    expect(result.contradictionReport.detector).toBe("deterministic+semantic");
    const kinds = result.contradictionReport.items.map((c) => c.kind);
    expect(kinds).toContain("live-vs-memory");

    // The compiled block (prompt files, version) is unaffected.
    const folder = await versionFolder();
    const styleMd = await fs.readFile(path.join(folder, "style-tile-prompt.md"), "utf-8");
    expect(styleMd).toContain("make it cool");
    expect(styleMd).not.toContain("live-vs-memory");
  });
});

describe("runRegenerateVisuals — direction isolation (WS-03 SC-05/SC-11)", () => {
  const DIRECTION_B = "direction-b";

  /** Write a placeholder png and register it as a direction-scoped inspire crop. */
  async function addScopedInspireCrop(directionId: string): Promise<string> {
    const rel = `brand/directions/${directionId}/assets/keep-${directionId}.png`;
    const abs = path.join(tmpDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "png-bytes");
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    await core.addAsset(directionId, {
      kind: "image",
      path: rel,
      intent: "inspire",
    });
    return path.resolve(tmpDir, rel);
  }

  it("direction A's discard, color-lock, and keep-crop are ABSENT from direction B's prompts + image refs (SC-05)", async () => {
    await scaffold(2); // creates + explores direction-a (DIRECTION_ID) and direction-b (DIRECTION_B)
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));

    // Record direction-A-scoped gestures — on A's OWN memory.yaml (isolation is
    // structural now: each direction owns its own memory.yaml, no shared scope
    // field to filter on).
    await core.appendFeedback(DIRECTION_ID, {
      body: "garish neon",
      author: "tim",
      source: "element-feedback",
      asset: `brand/directions/${DIRECTION_ID}/discards/thumb-a.png`,
    });
    const keepCropAbs = await addScopedInspireCrop(DIRECTION_ID);
    await core.recordColorLock(DIRECTION_ID, {
      hex: "#ff0000",
      author: "tim",
      source: "studio",
    });

    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });
    stubExtraction([]);

    // Regenerate direction B — A's gestures must not reach B's prompts or refs
    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_B,
    });

    const bFolder = await versionFolder(DIRECTION_B);
    const bStyleMd = await fs.readFile(
      path.join(bFolder, "style-tile-prompt.md"),
      "utf-8",
    );
    const bHomeMd = await fs.readFile(
      path.join(bFolder, "homepage-mockup-prompt.md"),
      "utf-8",
    );

    // A's discard body is absent from B's prompt files
    expect(bStyleMd).not.toContain("garish neon");
    expect(bHomeMd).not.toContain("garish neon");

    // A's color-lock is absent from B's prompt files
    expect(bStyleMd).not.toContain("#ff0000");
    expect(bHomeMd).not.toContain("#ff0000");

    // A's kept-crop is absent from B's generateImage referenceImagePaths
    for (const call of genSpy.mock.calls) {
      const refs =
        (call[0] as { referenceImagePaths?: string[] }).referenceImagePaths ?? [];
      expect(refs).not.toContain(keepCropAbs);
    }
  });

  it("direction A's gestures ARE present in A's own regenerate — isolation is per-direction, not a blanket drop (SC-05)", async () => {
    await scaffold(2);
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));

    await core.appendFeedback(DIRECTION_ID, {
      body: "garish neon",
      author: "tim",
      source: "element-feedback",
      asset: `brand/directions/${DIRECTION_ID}/discards/thumb-a.png`,
    });
    const keepCropAbs = await addScopedInspireCrop(DIRECTION_ID);
    await core.recordColorLock(DIRECTION_ID, {
      hex: "#ff0000",
      author: "tim",
      source: "studio",
    });

    process.env.OPENAI_API_KEY = "test-key";
    const genSpy = vi
      .spyOn(openai, "generateImage")
      .mockResolvedValue({ written: true, dryRun: false });
    stubExtraction([]);

    // Regenerate direction A — A's own gestures must appear
    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    const aFolder = await versionFolder(DIRECTION_ID);
    const aStyleMd = await fs.readFile(
      path.join(aFolder, "style-tile-prompt.md"),
      "utf-8",
    );
    const aHomeMd = await fs.readFile(
      path.join(aFolder, "homepage-mockup-prompt.md"),
      "utf-8",
    );

    // A's discard body IS in A's prompt files (AVOID tier)
    expect(aStyleMd).toContain("garish neon");
    expect(aHomeMd).toContain("garish neon");

    // A's color-lock IS in A's prompt files
    expect(aStyleMd).toContain("#ff0000");

    // A's kept-crop IS in A's referenceImagePaths
    const styleTileCall = genSpy.mock.calls.find((c) =>
      (c[0] as { outPath: string }).outPath.endsWith("style-tile.png"),
    );
    expect(styleTileCall).toBeDefined();
    const refs =
      (styleTileCall![0] as { referenceImagePaths?: string[] })
        .referenceImagePaths ?? [];
    expect(refs).toContain(keepCropAbs);
  });

  it("the source:'regenerate' feedback lands on the direction's own memory, absent from a sibling's (SC-05)", async () => {
    await scaffold(2);
    process.env.OPENAI_API_KEY = "test-key";
    vi.spyOn(openai, "generateImage").mockResolvedValue({ written: true, dryRun: false });
    stubExtraction([]);

    // A gesture (tweak) triggers the auto-logged feedback
    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
      tweak: "warmer",
    });

    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    const aEntries = await core.memoryEntries(DIRECTION_ID);
    const regenEntry = aEntries.find((e) => e.source === "regenerate");
    expect(regenEntry).toBeDefined();

    // Isolation is structural (separate memory.yaml per direction) — a sibling
    // direction's memory never sees it. This is the direct replacement for the
    // old `directionId`-on-entry scope check (that field no longer exists).
    const bEntries = await core.memoryEntries(DIRECTION_B);
    expect(bEntries.some((e) => e.source === "regenerate")).toBe(false);
  });

  it("dry-run parity (SC-11) — no key, direction assembly writes both prompt files and never throws", async () => {
    await scaffold();

    // No key (beforeEach deletes it)
    const result = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: DIRECTION_ID,
    });

    expect(result.dryRun).toBe(true);
    const folder = await versionFolder();
    const styleMd = await fs.readFile(
      path.join(folder, "style-tile-prompt.md"),
      "utf-8",
    );
    const homeMd = await fs.readFile(
      path.join(folder, "homepage-mockup-prompt.md"),
      "utf-8",
    );
    expect(styleMd.length).toBeGreaterThan(0);
    expect(homeMd.length).toBeGreaterThan(0);
    expect(result.boardWritten).toBe(true);
    for (const p of result.filesWritten) expect(p.endsWith(".png")).toBe(false);
  });
});

// WS-15 (SC-03): a draft refuses with the teaching error, fabricating nothing.
describe("runRegenerateVisuals — draft refusal (WS-15)", () => {
  it("teaches `keyart explore <id>` on a draft and creates no versions/ folder", async () => {
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    await core.create({ id: "draft-a", name: "Draft A" });

    await expect(
      runRegenerateVisuals({ cwd: tmpDir, directionId: "draft-a" }),
    ).rejects.toThrow(/keyart explore draft-a/);

    await expect(
      fs.access(path.join(directionsDir(), "draft-a", "versions")),
    ).rejects.toThrow(); // no fabricated version
  });
});
