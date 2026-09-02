import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  KeyartConfig,
  DirectionContent,
  DirectionVersion,
} from "../types.js";

// Mock loadConfig (tmp project) AND openai. Every other export of both modules
// keeps its real implementation — the openai fns default to `actual` (i.e.
// genuine dry-run without a key) and are overridden ONLY inside the one
// extract-reference test that must exercise the live token-stamping path with a
// stubbed vision analysis. This keeps the whole suite network-free and key-free.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});
vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return {
    ...actual,
    hasApiKey: vi.fn(actual.hasApiKey),
    analyzeReferenceForTokens: vi.fn(actual.analyzeReferenceForTokens),
    chatJson: vi.fn(actual.chatJson),
    visionJson: vi.fn(actual.visionJson),
  };
});

import { runDirection } from "../commands/direction.js";
import { runExplore } from "../commands/explore.js";
import { runApprove } from "../commands/approve.js";
import { directionsRoot } from "../config.js";
import { readHead } from "../direction/store.js";
import {
  hasApiKey,
  analyzeReferenceForTokens,
  chatJson,
} from "../openai.js";
import {
  renderBrandCss,
  resolveBrandVars,
} from "../approve/render-guides.js";
import {
  renderStyleBoardSvg,
  renderStyleBoardMarkdown,
} from "../approve/render-style-board.js";
import {
  generatePalette,
  contrastRatio,
  type PaletteLock,
} from "../brand/palette.js";
import type { PaletteRole } from "../types.js";

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Token Pipeline ITest", type: "prototype", framework: "next" },
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-tokenpipe-"));
  // Genuinely dry-run / deterministic: no API key, no network. Save + restore so
  // a change never leaks into the ambient environment.
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
  // openai fns default to their real (dry-run) behavior; only the extract test
  // overrides them. Reset to defaults each test so overrides never bleed across.
  vi.mocked(hasApiKey).mockImplementation(
    (await vi.importActual<typeof import("../openai.js")>("../openai.js"))
      .hasApiKey,
  );
  vi.mocked(analyzeReferenceForTokens).mockImplementation(
    (await vi.importActual<typeof import("../openai.js")>("../openai.js"))
      .analyzeReferenceForTokens,
  );
  vi.mocked(chatJson).mockImplementation(
    (await vi.importActual<typeof import("../openai.js")>("../openai.js"))
      .chatJson,
  );
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

async function writeBrief(directionId: string, body: string): Promise<void> {
  const config = buildTestConfig(tmpDir);
  const briefPath = path.join(
    directionsRoot(tmpDir, config),
    directionId,
    "brief.md",
  );
  await fs.writeFile(briefPath, body, "utf-8");
}

/** Absolute `directions/` dir for a direction under the tmp project. */
function directionsDirOf(directionId: string): string {
  const config = buildTestConfig(tmpDir);
  return directionsRoot(tmpDir, config);
}

/**
 * The head DirectionVersion for an aggregate's first seeded sibling (the previous
 * `directions[0]`). Explore seeds ids `direction-a`, `direction-b`, … so the
 * first seeded direction is `directionId` (defaults to the first result id).
 */
async function readHeadVersion(
  directionId = "direction-a",
): Promise<DirectionVersion> {
  return readHead(directionsDirOf(directionId), directionId);
}

/** Read a head version-folder file (e.g. `style-tile-prompt.md`). */
async function readVersionFile(
  directionId: string,
  file: string,
): Promise<string> {
  const directionsDir = directionsDirOf(directionId);
  const head = await readHead(directionsDir, directionId);
  return fs.readFile(
    path.join(directionsDir, directionId, "versions", head.id, file),
    "utf-8",
  );
}

/** Every palette hex on a tokened direction, lower-cased for substring asserts. */
function paletteHexes(direction: DirectionVersion): string[] {
  return (direction.tokens?.palette ?? []).map((t) => t.hex.toLowerCase());
}

describe("token pipeline (end-to-end, no network / no key)", () => {
  it("token generation → exact brand.css → matching deterministic board (SC-04)", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "brandy" });
    await writeBrief("brandy", "A precise fintech analytics dashboard.");

    const run = await runExplore({ cwd: tmpDir, directionId: "brandy" });
    expect(run.dryRun).toBe(true); // proved key-free

    const direction = await readHeadVersion(run.directionIds[0]);
    // A dry-run explore still yields STRUCTURED tokens (the placeholder engine).
    expect(direction.tokens).toBeDefined();
    const hexes = paletteHexes(direction);
    expect(hexes.length).toBe(6); // all six roles present

    const vars = resolveBrandVars(direction);
    const css = renderBrandCss(direction).toLowerCase();
    const svg = renderStyleBoardSvg(direction).toLowerCase();
    const md = renderStyleBoardMarkdown(direction).toLowerCase();

    // Every token hex appears — identically — in brand.css AND both boards. The
    // board can never drift from the CSS because both read `resolveBrandVars`.
    for (const hex of hexes) {
      expect(css).toContain(hex);
      expect(svg).toContain(hex);
      expect(md).toContain(hex);
    }

    // Set equality: the hexes surfaced in the CSS are exactly the board's hexes.
    const hexSet = new Set(hexes);
    const cssHexes = new Set(css.match(/#[0-9a-f]{6}/g) ?? []);
    for (const hex of hexSet) expect(cssHexes.has(hex)).toBe(true);

    // Font families flow through identically too.
    const heading = direction.tokens!.typography.heading;
    const body = direction.tokens!.typography.body;
    for (const doc of [css, svg, md]) {
      expect(doc).toContain(heading.toLowerCase());
      expect(doc).toContain(body.toLowerCase());
    }

    // Cross-check the shared single source: the resolved vars ARE the token hexes.
    const byRole = new Map<PaletteRole, string>(
      direction.tokens!.palette.map((t) => [t.role, t.hex]),
    );
    expect(vars.primary).toBe(byRole.get("primary"));
    expect(vars.text).toBe(byRole.get("text"));
    expect(vars.textMuted).toBe(byRole.get("muted"));

    // Approve → the pipeline actually WRITES the token-derived brand.css + board
    // to disk; both carry the same exact hexes/fonts.
    await runApprove({
      cwd: tmpDir,
      directionId: run.directionIds[0],
      force: true,
    });
    const config = buildTestConfig(tmpDir);
    const writtenCss = (
      await fs.readFile(path.resolve(tmpDir, config.outputs.cssVars), "utf-8")
    ).toLowerCase();
    const writtenBoard = (
      await fs.readFile(
        path.join(config.brand.root, "guides", "style-board.md"),
        "utf-8",
      )
    ).toLowerCase();
    for (const hex of hexes) {
      expect(writtenCss).toContain(hex);
      expect(writtenBoard).toContain(hex);
    }
    expect(writtenCss).toContain(heading.toLowerCase());
    expect(writtenBoard).toContain(body.toLowerCase());

    // The SHIPPED artifact is readable: both ink vars clear AA against both
    // grounds. `--brand-text-muted` is named for text and the guides tell
    // consumers to use it for supporting copy — an unreadable value here is a
    // defect that reaches the consuming repo's CSS.
    for (const ink of [vars.text, vars.textMuted]) {
      expect(contrastRatio(ink, vars.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ink, vars.surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("dry-run identity — the deterministic derivations are byte-identical (SC-04)", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "det" });
    const run = await runExplore({ cwd: tmpDir, directionId: "det" });
    const direction = await readHeadVersion(run.directionIds[0]);

    // No model call → the css + both boards are pure token projections.
    expect(renderBrandCss(direction)).toBe(renderBrandCss(direction));
    expect(renderStyleBoardSvg(direction)).toBe(renderStyleBoardSvg(direction));
    expect(renderStyleBoardMarkdown(direction)).toBe(
      renderStyleBoardMarkdown(direction),
    );
  });

  it("a token-less direction fails loudly — tokens are the required source (SC-03)", () => {
    // A pre-program direction: prose `visualStyle`, NO structured tokens. The
    // prose→keyword heuristic is gone; every direction must carry extracted
    // tokens, so rendering fails loudly rather than inventing a palette.
    const legacy: DirectionContent = {
      name: "Legacy Warm",
      summary: "A legacy prose-only direction.",
      positioning: "Trustworthy and human.",
      character: { mood: "Warm, earthy palette with rounded, friendly typography." },
      homepageMockupPrompt: "A warm homepage.",
      styleTilePrompt: "A warm style tile.",
      copyExamples: { headline: "Hi", subheadline: "Hello", cta: "Go" },
      usage: {
        rules: ["Use warm tones", "Round the corners", "Breathe"],
        antiRules: ["No cold blues", "No sharp corners"],
      },
    };
    expect(legacy.tokens).toBeUndefined();
    expect(() => renderBrandCss(legacy)).toThrow(/no structured tokens/);
    expect(() => renderStyleBoardSvg(legacy)).toThrow(/no structured tokens/);
  });

  it("extract-reference seeds/locks a palette token, recorded end-to-end (SC-06/SC-13)", async () => {
    const LOCK = "#3366cc";

    // Stub the LIVE token-stamping path: a key is present, the extract vision
    // read returns a dominant color, and the text model returns a valid (intent-
    // less) direction that stampTokens will expand around the extract lock. No
    // real network/key — every model call is a mock; the file read is stubbed.
    vi.mocked(hasApiKey).mockReturnValue(true);
    vi.mocked(analyzeReferenceForTokens).mockResolvedValue({
      analysis: { dominantColors: [LOCK] },
      dryRun: false,
    });
    vi.mocked(chatJson).mockResolvedValue({
      data: {
        directions: [
          {
            id: "direction-a",
            name: "Extract Seeded",
            summary: "Seeded from an extract reference.",
            positioning: "Grounded in the reference's dominant color.",
            character: { mood: "Cool, considered, built around the reference blue." },
            homepageMockupPrompt: "A cool homepage.",
            styleTilePrompt: "A cool style tile.",
            copyExamples: { headline: "H", subheadline: "S", cta: "C" },
            usage: {
              rules: ["Anchor on the seeded blue", "Keep contrast high", "Stay calm"],
              antiRules: ["No clashing warm hues", "No low-contrast text"],
            },
          },
        ],
      },
      dryRun: false,
    });

    await runDirection({ cwd: tmpDir, verb: "new", id: "extracty" });
    await writeBrief("extracty", "A calm, trustworthy analytics product.");

    // A run-level extract reference — the file exists for realism; the analysis
    // itself is stubbed (no bytes are read from it).
    const refAbs = path.join(tmpDir, "competitor.png");
    await fs.writeFile(refAbs, "not-a-real-png", "utf-8");
    const refRel = rel(refAbs);

    const run = await runExplore({
      cwd: tmpDir,
      directionId: "extracty",
      references: [{ path: refRel, intent: "extract" }],
    });

    const direction = await readHeadVersion(run.directionIds[0]);
    expect(direction.tokens).toBeDefined();

    // The extract's dominant color is honored verbatim as a locked token…
    expect(paletteHexes(direction)).toContain(LOCK);
    // …and the provenance records it as an anchor the rest harmonized around.
    expect(direction.tokens!.provenance?.extracted).toContain(LOCK);

    // The reference + its intent land in the head version's context snapshot (SC-06).
    const context = await readVersionFile(
      run.directionIds[0],
      "context-snapshot.md",
    );
    expect(context).toContain(refRel);
    expect(context).toContain("[intent: extract]");
  });

  it("engine: a locked hex is preserved while the rest harmonize (SC-13)", () => {
    const LOCK = "#3366cc";
    const locks: PaletteLock[] = [{ hex: LOCK }];
    const { palette, provenance } = generatePalette({
      baseHue: 210,
      scheme: "complementary",
      seed: 7,
      locks,
    });

    // The pinned hex survives verbatim; provenance records it.
    const hexes = palette.map((t) => t.hex.toLowerCase());
    expect(hexes).toContain(LOCK);
    expect(provenance.extracted).toContain(LOCK);

    // The remaining five roles are engine-derived (not all equal to the lock).
    const nonLock = hexes.filter((h) => h !== LOCK);
    expect(nonLock.length).toBe(5);
    expect(new Set(nonLock).size).toBeGreaterThan(1);
  });

  it("engine: two unconstrained runs with different seeds differ (SC-13)", () => {
    const a = generatePalette({ baseHue: 200, scheme: "triadic", seed: 1 });
    const b = generatePalette({ baseHue: 200, scheme: "triadic", seed: 999 });
    const hexesA = a.palette.map((t) => t.hex).join(",");
    const hexesB = b.palette.map((t) => t.hex).join(",");
    expect(hexesA).not.toBe(hexesB);
  });

  it("engine: every ink/ground pair — text AND muted — meets WCAG contrast (SC-13)", () => {
    // Sweep several schemes/seeds so contrast enforcement is proven broadly.
    // `muted` is in the sweep because it projects to `--brand-text-muted` and
    // the guides reserve it for supporting copy: it is body text too.
    const cases: { baseHue: number; scheme: Parameters<typeof generatePalette>[0]["scheme"]; seed: number }[] = [
      { baseHue: 20, scheme: "analogous", seed: 3 },
      { baseHue: 140, scheme: "complementary", seed: 11 },
      { baseHue: 270, scheme: "triadic", seed: 42 },
      { baseHue: 330, scheme: "split-complementary", seed: 88 },
    ];
    for (const input of cases) {
      const { palette } = generatePalette(input);
      const byRole = new Map(palette.map((t) => [t.role, t.hex]));
      const background = byRole.get("background")!;
      const surface = byRole.get("surface")!;
      for (const ink of ["text", "muted"] as const) {
        const hex = byRole.get(ink)!;
        expect(contrastRatio(hex, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(hex, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("inverted spine: the composed image prompt is SOFT — no hard color/type lock, no fonts (SC-03)", async () => {
    await runDirection({ cwd: tmpDir, verb: "new", id: "softy" });
    const run = await runExplore({ cwd: tmpDir, directionId: "softy" });
    expect(run.dryRun).toBe(true); // key-free
    const directionId = run.directionIds[0];
    const direction = await readHeadVersion(directionId);
    // Dry-run still yields a complete seven-role token set (the retained
    // intent→engine fallback), so brand.css/board never regress (SC-11).
    expect(paletteHexes(direction)).toHaveLength(6);
    const heading = direction.tokens!.typography.heading;
    const body = direction.tokens!.typography.body;

    for (const file of ["style-tile-prompt.md", "homepage-mockup-prompt.md"]) {
      const prompt = (
        await readVersionFile(directionId, file)
      ).toLowerCase();
      // The retired hard lock is GONE — no "use ONLY … do not introduce".
      expect(prompt).not.toContain("color & type lock");
      expect(prompt).not.toContain("use only");
      expect(prompt).not.toContain("do not introduce");
      // No font family is forced onto the image (type is extracted, not dictated).
      expect(prompt).not.toContain(heading.toLowerCase());
      expect(prompt).not.toContain(body.toLowerCase());
      // …but the authoritative content projection is still present.
      expect(prompt).toContain("content lock");
      // Lockless dry-run ⇒ no soft color guidance either.
      expect(prompt).not.toContain("color guidance (soft)");
    }
  });

  it("keyed: tokens are EXTRACTED from the rendered tile, and a locked color rides as soft guidance (SC-03/SC-04/SC-06)", async () => {
    const LOCK = "#3366cc";

    // Live path: a key is present; the extract reference yields the LOCK; the
    // text model returns a valid direction. generateImage + BOTH extractors are
    // stubbed, so nothing hits the network and no PNG is decoded.
    vi.mocked(hasApiKey).mockReturnValue(true);
    vi.mocked(analyzeReferenceForTokens).mockResolvedValue({
      analysis: { dominantColors: [LOCK] },
      dryRun: false,
    });
    vi.mocked(chatJson).mockResolvedValue({
      data: {
        directions: [
          {
            id: "direction-a",
            name: "Freely Rendered",
            summary: "Rendered freely, tokens read back from pixels.",
            positioning: "Image-led.",
            character: { mood: "Open and unconstrained." },
            homepageMockupPrompt: "A homepage.",
            styleTilePrompt: "A style tile.",
            copyExamples: { headline: "H", subheadline: "S", cta: "C" },
            usage: {
              rules: ["Render freely", "Read tokens back", "Honor the lock"],
              antiRules: ["No forced fonts", "No hard color lock"],
            },
          },
        ],
      },
      dryRun: false,
    });

    // Stub the image write, the single vision read, and the two pure mappers, so
    // nothing hits the network and no tile is decoded.
    const openai = await import("../openai.js");
    vi.spyOn(openai, "generateImage").mockResolvedValue({
      written: true,
    } as never);
    vi.spyOn(openai, "describeImageBrand").mockResolvedValue({
      read: { colors: [], type: {} },
      dryRun: false,
    } as never);
    const { buildTokens } = await import("../explore/token-intent.js");
    const extractedTokens = buildTokens({
      raw: { baseHue: 210, scheme: "complementary" },
      seed: 7,
      locks: [{ hex: LOCK }],
    });
    const extractMod = await import("../brand/extract-tokens.js");
    vi.spyOn(extractMod, "tokensFromRoledColors").mockReturnValue({
      tokens: extractedTokens,
      palette: [],
    });
    const typeMod = await import("../brand/extract-type.js");
    vi.spyOn(typeMod, "mapTypeRead").mockReturnValue({
      typography: { heading: "Space Grotesk", body: "Inter" },
      approximate: true,
    });

    await runDirection({ cwd: tmpDir, verb: "new", id: "keyed" });
    await writeBrief("keyed", "An image-led brand.");
    const refAbs = path.join(tmpDir, "ref.png");
    await fs.writeFile(refAbs, "not-a-real-png", "utf-8");

    const run = await runExplore({
      cwd: tmpDir,
      directionId: "keyed",
      references: [{ path: rel(refAbs), intent: "extract" }],
    });

    const direction = await readHeadVersion(run.directionIds[0]);
    // The persisted palette IS the extracted palette (which honors the lock).
    expect(paletteHexes(direction)).toEqual(
      extractedTokens.palette.map((t) => t.hex.toLowerCase()),
    );
    expect(paletteHexes(direction)).toContain(LOCK);
    expect(direction.tokens!.typography).toEqual({
      heading: "Space Grotesk",
      body: "Inter",
    });

    // The composed image prompt carried the LOCK as SOFT guidance, not a hard lock.
    const prompt = (
      await readVersionFile(run.directionIds[0], "style-tile-prompt.md")
    ).toLowerCase();
    expect(prompt).toContain("color guidance (soft)");
    expect(prompt).toContain(LOCK);
    expect(prompt).not.toContain("color & type lock");
  });
});
