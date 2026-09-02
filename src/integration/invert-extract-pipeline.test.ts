import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  KeyartConfig,
  PaletteRole,
  DirectionContent,
  DirectionVersion,
} from "../types.js";

// Mock loadConfig (tmp project) AND openai — the SAME pattern as
// token-pipeline / visual-feedback tests. Every other export keeps its real
// implementation; the openai fns default to `actual` (genuine dry-run without a
// key) and are overridden ONLY inside the keyed tests that must exercise the
// live generate→extract path with a stubbed image write + vision read. Nothing
// hits the network and no key is ever required — the whole suite is
// deterministic, network-free, and key-free.
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
    generateImage: vi.fn(actual.generateImage),
    describeImageBrand: vi.fn(actual.describeImageBrand),
    analyzeReferenceForTokens: vi.fn(actual.analyzeReferenceForTokens),
  };
});

import { runDirection } from "../commands/direction.js";
import { runExplore } from "../commands/explore.js";
import { runApprove } from "../commands/approve.js";
import { runRegenerateVisuals } from "../commands/regenerate-visuals.js";
import { directionsRoot } from "../config.js";
import { createDirectionCore } from "../direction/core.js";
import { readHead, resolveDirection } from "../direction/store.js";
import {
  hasApiKey,
  chatJson,
  generateImage,
  describeImageBrand,
  type BrandColorRead,
  type BrandColorRole,
} from "../openai.js";
import {
  renderBrandCss,
  resolveBrandVars,
  APPROXIMATE_FONT_NOTE,
} from "../approve/render-guides.js";
import {
  renderStyleBoardMarkdown,
  renderStyleBoardSvg,
} from "../approve/render-style-board.js";
import {
  contrastRatio,
  generatePalette,
  rerollPalette,
} from "../brand/palette.js";
import { FONT_PAIRINGS } from "../brand/fonts.js";

// --- fixtures ---------------------------------------------------------------

/**
 * A swatch-forward style tile's brand colors. The vision read now returns each
 * color TAGGED with the role it plays (see {@link VISION_ROLES}) — background /
 * text / primary as universal roles and the rest as the open `brand` set — so
 * roles come from the model, not a post-hoc lightness sort. Two distinct
 * fixtures so a regenerate can ROTATE the unlocked roles.
 */
interface Swatch {
  rgb: [number, number, number];
  hex: string;
}

const FIXTURE_A: Swatch[] = [
  { rgb: [255, 255, 255], hex: "#ffffff" }, // lightest → background
  { rgb: [17, 17, 17], hex: "#111111" }, // darkest → text
  { rgb: [255, 87, 34], hex: "#ff5722" }, // vivid → primary
  { rgb: [0, 128, 128], hex: "#008080" }, // vivid → secondary
  { rgb: [255, 193, 7], hex: "#ffc107" }, // vivid → extra brand primitive (no semantic slot)
];

const FIXTURE_B: Swatch[] = [
  { rgb: [250, 250, 250], hex: "#fafafa" }, // lightest → background
  { rgb: [13, 27, 42], hex: "#0d1b2a" }, // darkest → text
  { rgb: [67, 97, 238], hex: "#4361ee" }, // vivid → primary
  { rgb: [114, 9, 183], hex: "#7209b7" }, // vivid → secondary
  { rgb: [6, 214, 160], hex: "#06d6a0" }, // vivid → extra brand primitive (no semantic slot)
];

/**
 * The verbatim vision read behind `docs/examples/starter-brand` — a real keyed
 * run in which the model tagged the pale `#b7d6b2` as `muted` over a `#f7f1e6`
 * canvas (1.41:1). Kept as its own fixture because it is the only one carrying a
 * directly-tagged `muted`, and because it is a REGRESSION, not a shape.
 */
const STARTER_BRAND_READ: BrandColorRead[] = [
  { hex: "#f7f1e6", role: "background" },
  { hex: "#1f352d", role: "text" },
  { hex: "#3f8a63", role: "primary" },
  { hex: "#edf1e8", role: "surface" },
  { hex: "#b7d6b2", role: "muted" },
  { hex: "#6c8fa3", role: "secondary" },
  { hex: "#d28b55", role: "brand" },
];

const ROLE_SWATCHES: PaletteRole[] = [
  "background",
  "text",
  "primary",
  "secondary",
];

/**
 * The role the vision model TAGS each fixture swatch with, aligned to FIXTURE_A/B
 * order: the first three are universal roles, the rest are the open `brand` set.
 * Through the Phase-1 bridge the first `brand` color fills the `secondary` token
 * slot; any further `brand` colors survive only as hue-named primitives.
 */
const VISION_ROLES: BrandColorRole[] = [
  "background",
  "text",
  "primary",
  "brand",
  "brand",
];

/** The role-tagged colors a vision read returns for a tile (the model's own
 * assignment — NOT a lightness sort). */
const roledColors = (swatches: Swatch[]): BrandColorRead[] =>
  swatches.map((s, i) => ({ hex: s.hex, role: VISION_ROLES[i] }));

/** The flat hexes derived from the tagged colors (back-compat provenance). */
const palette = (swatches: Swatch[]): string[] => swatches.map((s) => s.hex);

const hexSet = (swatches: Swatch[]): Set<string> =>
  new Set(swatches.map((s) => s.hex));

const byRole = (direction: DirectionContent, role: PaletteRole): string =>
  direction.tokens!.palette.find((t) => t.role === role)!.hex.toLowerCase();

/** Every real, loadable catalog family — extracted type must always be one. */
const CATALOG_HEADINGS = new Set(FONT_PAIRINGS.map((p) => p.heading));
const CATALOG_BODIES = new Set(FONT_PAIRINGS.map((p) => p.body));

// --- config / harness (mirrors the sibling integration tests) ---------------

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Invert Extract ITest", type: "prototype", framework: "next" },
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
/** The swatches the mocked `describeImageBrand` reads back (swap to rotate). */
let currentSwatches: Swatch[];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-invertpipe-"));
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  currentSwatches = FIXTURE_A;

  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

  // Default every openai fn back to its real (dry-run) behavior each test so the
  // keyed overrides never bleed across tests.
  const actual = await vi.importActual<typeof import("../openai.js")>("../openai.js");
  vi.mocked(hasApiKey).mockImplementation(actual.hasApiKey);
  vi.mocked(chatJson).mockImplementation(actual.chatJson);
  vi.mocked(generateImage).mockImplementation(actual.generateImage);
  vi.mocked(describeImageBrand).mockImplementation(actual.describeImageBrand);

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Set a SEED direction's structured brief oneLiner (the projection
 *  chokepoint rewrites brief.md from this — never hand-authored). */
async function setOneLiner(directionId: string, oneLiner: string): Promise<void> {
  const config = buildTestConfig(tmpDir);
  const core = createDirectionCore(tmpDir, config);
  await core.setBriefFields(directionId, { oneLiner });
}

/** The head DirectionVersion for a seeded direction. */
async function readHeadVersion(directionId: string): Promise<DirectionVersion> {
  const config = buildTestConfig(tmpDir);
  return readHead(directionsRoot(tmpDir, config), directionId);
}

/** Read a head version-folder file (e.g. `style-tile-prompt.md`). */
async function readVersionFile(directionId: string, file: string): Promise<string> {
  const config = buildTestConfig(tmpDir);
  const resolved = await resolveDirection(tmpDir, config, directionId);
  const head = resolved.record.head!;
  return fs.readFile(path.join(resolved.versionsDir, head, file), "utf-8");
}

/**
 * Flip the openai mocks to a "keyed" world: a present key, a text model that
 * returns one valid direction, an image model that WRITES a placeholder tile to
 * `outPath` (so `styleRes.written` is true), and ONE consolidated brand read that
 * transcribes the current fixture's palette + a type read mapping to a real
 * catalog family. No bytes cross the network.
 */
function goLive(): void {
  vi.mocked(hasApiKey).mockReturnValue(true);
  vi.mocked(chatJson).mockResolvedValue({
    data: {
      directions: [
        {
          id: "direction-a",
          name: "Image Led",
          summary: "Rendered freely; tokens read back from the tile.",
          positioning: "The imagery leads and the tokens follow.",
          character: { mood: "Open, unconstrained, swatch-forward." },
          homepageMockupPrompt: "A homepage mockup.",
          styleTilePrompt: "A swatch-forward style tile.",
          copyExamples: { headline: "Ship it", subheadline: "Fast", cta: "Start" },
          usage: {
            rules: ["Render freely", "Read tokens back", "Honor locks"],
            antiRules: ["No forced fonts", "No hard color lock"],
          },
        },
      ],
    },
    dryRun: false,
  });
  vi.mocked(generateImage).mockImplementation(async (args) => {
    await fs.writeFile(args.outPath, Buffer.from("tile"));
    return { written: true, dryRun: false };
  });
  vi.mocked(describeImageBrand).mockImplementation(async () => ({
    read: {
      // The model returns its OWN role assignment; the callers extract tokens
      // from these tagged colors (never a lightness sort).
      colors: roledColors(currentSwatches),
      palette: palette(currentSwatches),
      type: {
        attributes: {
          classification: "sans",
          mood: "geometric bold high-contrast display",
        },
        suggestedFamily: "Space Grotesk",
      },
    },
    dryRun: false,
  }));
}

/** The prompts actually sent to the image model on the most recent generation. */
function sentPrompts(): string[] {
  return vi.mocked(generateImage).mock.calls.map(([args]) => args.prompt.toLowerCase());
}

describe("invert-extract pipeline (end-to-end, no network / no key)", () => {
  it("1. generate → extract: tokens are the tile's pixels; type is a loadable family; the prompt has no hard lock (SC-03/SC-04/SC-05)", async () => {
    goLive();
    await runDirection({ cwd: tmpDir, verb: "new", id: "led" });
    await setOneLiner("led", "An image-led analytics brand.");

    const run = await runExplore({ cwd: tmpDir, directionId: "led" });
    expect(run.dryRun).toBe(false); // keyed path exercised

    const ledDirectionId = run.directionIds[0];
    const direction = await readHeadVersion(ledDirectionId);
    expect(direction.tokens).toBeDefined();
    expect(direction.tokens!.palette).toHaveLength(6);

    // COLOR: the extractable roles ARE colors present in the rendered tile —
    // the tokens literally are the image (no drift).
    const fixtureHexes = hexSet(FIXTURE_A);
    for (const role of ROLE_SWATCHES) {
      expect(fixtureHexes.has(byRole(direction, role))).toBe(true);
    }

    // TYPE: a vision read mapped to a REAL, loadable catalog family (approximate).
    expect(CATALOG_HEADINGS.has(direction.tokens!.typography.heading)).toBe(true);
    expect(CATALOG_BODIES.has(direction.tokens!.typography.body)).toBe(true);

    // The composed image prompt carries NO hard color/type lock and NO forced
    // font — the retired `composePaletteLock` is gone (SC-03). Lockless ⇒ no soft
    // guidance either.
    const heading = direction.tokens!.typography.heading.toLowerCase();
    const body = direction.tokens!.typography.body.toLowerCase();
    for (const file of ["style-tile-prompt.md", "homepage-mockup-prompt.md"]) {
      const prompt = (await readVersionFile(ledDirectionId, file)).toLowerCase();
      expect(prompt).not.toContain("color & type lock");
      expect(prompt).not.toContain("use only");
      expect(prompt).not.toContain("do not introduce");
      expect(prompt).not.toContain("color guidance (soft)");
      expect(prompt).not.toContain(heading);
      expect(prompt).not.toContain(body);
      // …but the authoritative content projection is still present.
      expect(prompt).toContain("content lock");
    }
  });

  it("2. lock → regenerate → re-extract: a locked role is held verbatim while ≥1 unlocked role rotates; prose/copy untouched (SC-06/SC-07)", async () => {
    goLive();
    await runDirection({ cwd: tmpDir, verb: "new", id: "rotate" });
    await setOneLiner("rotate", "A brand that rotates its palette.");

    const run = await runExplore({ cwd: tmpDir, directionId: "rotate" });
    const rotateDirectionId = run.directionIds[0];
    const before = await readHeadVersion(rotateDirectionId);
    const lockedPrimary = byRole(before, "primary");
    const beforeText = byRole(before, "text");
    expect(hexSet(FIXTURE_A).has(lockedPrimary)).toBe(true);
    expect(hexSet(FIXTURE_A).has(beforeText)).toBe(true);

    // Regenerate against a DIFFERENT tile, locking only `primary`.
    currentSwatches = FIXTURE_B;
    const regen = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: rotateDirectionId,
      lockedRoles: ["primary"],
    });
    expect(regen.dryRun).toBe(false);

    const after = await readHeadVersion(rotateDirectionId);
    // The locked role is preserved verbatim (lock-and-rotate)…
    expect(byRole(after, "primary")).toBe(lockedPrimary);
    // …while an unlocked role rotated to the NEW fixture's colors (≥1 rotated).
    expect(byRole(after, "text")).toBe("#0d1b2a");
    expect(byRole(after, "text")).not.toBe(beforeText);
    expect(hexSet(FIXTURE_B).has(byRole(after, "background"))).toBe(true);

    // The direction's PROSE/COPY is byte-identical — only tokens change (SC-07).
    expect(after.name).toBe(before.name);
    expect(after.summary).toBe(before.summary);
    expect(after.positioning).toBe(before.positioning);
    expect(after.character).toEqual(before.character);
    expect(after.copyExamples).toEqual(before.copyExamples);
    expect(after.usage).toEqual(before.usage);
  });

  it("3. gestures converge on regenerate: a generic feedback note + a discard AVOID block reach the prompt (SC-08)", async () => {
    goLive();
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await runDirection({ cwd: tmpDir, verb: "new", id: "gestures" });
    await setOneLiner("gestures", "A brand steered by gestures.");

    const run = await runExplore({ cwd: tmpDir, directionId: "gestures" });
    const gesturesDirectionId = run.directionIds[0];

    // A DISCARD is structurally a feedback entry carrying a stored thumbnail —
    // its body becomes the DIRECTION's own negative art direction. It must be
    // recorded on the sibling being regenerated (memory is per-direction now,
    // not shared with the seed).
    const DISCARD = "garish neon gradient";
    await core.appendFeedback(gesturesDirectionId, {
      body: DISCARD,
      author: "tester",
      source: "serve",
      asset: `brand/directions/${gesturesDirectionId}/assets/feedback/reject.png`,
    });

    const FEEDBACK = "make it feel more editorial and calm";
    vi.mocked(generateImage).mockClear();
    const regen = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: gesturesDirectionId,
      feedbackNote: FEEDBACK,
    });
    expect(regen.dryRun).toBe(false);

    // Every prompt sent to the image model carries BOTH the generic feedback note
    // (as this-pass art direction) and the discard as an AVOID block.
    const prompts = sentPrompts();
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt).toContain(FEEDBACK.toLowerCase());
      expect(prompt).toContain("avoid (do not use):");
      expect(prompt).toContain(DISCARD.toLowerCase());
    }
  });

  it("4. approve carries the extracted tokens; brand.css projects them byte-exactly, font labeled approximate (SC-09/SC-10)", async () => {
    goLive();
    const config = buildTestConfig(tmpDir);
    await runDirection({ cwd: tmpDir, verb: "new", id: "approvable" });
    await setOneLiner("approvable", "A brand ready to approve.");

    const run = await runExplore({ cwd: tmpDir, directionId: "approvable" });
    const approvableDirectionId = run.directionIds[0];
    const direction = await readHeadVersion(approvableDirectionId);
    const extractedHexes = direction.tokens!.palette.map((t) => t.hex.toLowerCase());

    await runApprove({
      cwd: tmpDir,
      directionId: approvableDirectionId,
      force: true,
    });

    // current-direction.json carries the SAME extracted tokens.
    const approved = JSON.parse(
      await fs.readFile(
        path.join(config.brand.approved, "current-direction.json"),
        "utf-8",
      ),
    ) as DirectionVersion;
    expect(approved.tokens!.palette.map((t) => t.hex.toLowerCase())).toEqual(
      extractedHexes,
    );

    // brand.css is a byte-exact projection of those tokens + the approximate label.
    const css = (
      await fs.readFile(path.resolve(tmpDir, config.outputs.cssVars), "utf-8")
    ).toLowerCase();
    for (const hex of extractedHexes) expect(css).toContain(hex);
    expect(css).toContain(APPROXIMATE_FONT_NOTE.toLowerCase());
    expect(css).toContain(direction.tokens!.typography.heading.toLowerCase());

    // The board projects the SAME shared vars — it can never drift from the CSS.
    const board = renderStyleBoardMarkdown(direction).toLowerCase();
    for (const hex of extractedHexes) expect(board).toContain(hex);
  });

  it("5. dry-run parity: keyless loop completes via the intent fallback; a token-less direction fails loudly (SC-11)", async () => {
    // No key, no image, no mocks overridden — the genuinely keyless path.
    await runDirection({ cwd: tmpDir, verb: "new", id: "keyless" });
    await setOneLiner("keyless", "A keyless dry-run brand.");

    const run = await runExplore({ cwd: tmpDir, directionId: "keyless" });
    expect(run.dryRun).toBe(true);

    // The retained intent→engine fallback still yields a full six-role board.
    const keylessDirectionId = run.directionIds[0];
    const direction = await readHeadVersion(keylessDirectionId);
    expect(direction.tokens!.palette).toHaveLength(6);
    const css = renderBrandCss(direction);
    expect(css).toContain("--brand-primary:");
    expect(css).not.toContain("undefined");

    // Approve still works with no key.
    await runApprove({
      cwd: tmpDir,
      directionId: keylessDirectionId,
      force: true,
    });

    // A token-less direction (NO tokens) no longer has a prose fallback — the
    // renderers require extracted tokens and fail loudly instead.
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
    expect(() => resolveBrandVars(legacy)).toThrow(/no structured tokens/);
  });

  it("6. algorithmic reroll composes: reroll freezes a role + changes the rest (no image call); a rerolled palette fed to regenerate is honored as locks (SC-13)", async () => {
    // ALGORITHMIC reroll — pure engine, NO image call.
    const base = generatePalette({ baseHue: 210, scheme: "complementary", seed: 3 });
    const frozen = base.palette.find((t) => t.role === "primary")!.hex;
    const rerolled = rerollPalette(base.palette, ["primary"], 99);
    const rerolledByRole = new Map(rerolled.palette.map((t) => [t.role, t.hex]));
    // The frozen role is unchanged; the rest rotate.
    expect(rerolledByRole.get("primary")).toBe(frozen);
    const changed = base.palette.filter(
      (t) => t.role !== "primary" && rerolledByRole.get(t.role) !== t.hex,
    );
    expect(changed.length).toBeGreaterThan(0);

    // Now PUSH that rerolled primary into a creative regenerate as a locked color
    // — the two paths compose, and the lock is honored verbatim in the re-extract.
    goLive();
    await runDirection({ cwd: tmpDir, verb: "new", id: "compose" });
    await setOneLiner("compose", "A brand composing reroll + regenerate.");
    const run = await runExplore({ cwd: tmpDir, directionId: "compose" });
    const composeDirectionId = run.directionIds[0];

    const pushedHex = rerolledByRole.get("primary")!.toLowerCase();
    currentSwatches = FIXTURE_B;
    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: composeDirectionId,
      lockedColors: [{ role: "primary", hex: pushedHex }],
    });

    const after = await readHeadVersion(composeDirectionId);
    // The pushed reroll color rode in as a lock — honored verbatim (SC-13/SC-06).
    expect(byRole(after, "primary")).toBe(pushedHex);
    // …and it rode as SOFT guidance into the image prompt, not a hard lock.
    const prompts = sentPrompts();
    expect(prompts.some((p) => p.includes("color guidance (soft)"))).toBe(true);
    expect(prompts.every((p) => !p.includes("color & type lock"))).toBe(true);
  });

  it("7. an unreadable READ muted is AA-finished before it reaches brand.css; a USER-locked one is not", async () => {
    // The docs/examples/starter-brand regression, end to end. That committed
    // example came from a real keyed run whose vision read tagged the pale
    // sprout green as `muted`; it shipped as `--brand-text-muted: #b7d6b2` on a
    // `#f7f1e6` canvas — 1.41:1. Trusting the model's role PLACEMENT never
    // meant shipping an illegible ink token: the engine is the finisher.
    goLive();
    const config = buildTestConfig(tmpDir);
    vi.mocked(describeImageBrand).mockImplementation(async () => ({
      read: {
        colors: STARTER_BRAND_READ,
        palette: STARTER_BRAND_READ.map((c) => c.hex),
        type: {
          attributes: { classification: "sans", mood: "calm humanist" },
          suggestedFamily: "Inter",
        },
      },
      dryRun: false,
    }));

    await runDirection({ cwd: tmpDir, verb: "new", id: "sprout" });
    await setOneLiner("sprout", "A calm, growth-minded brand on warm paper.");
    const run = await runExplore({ cwd: tmpDir, directionId: "sprout" });
    const sproutDirectionId = run.directionIds[0];

    await runApprove({
      cwd: tmpDir,
      directionId: sproutDirectionId,
      force: true,
    });
    const css = (
      await fs.readFile(path.resolve(tmpDir, config.outputs.cssVars), "utf-8")
    ).toLowerCase();

    const cssVar = (name: string): string =>
      css.match(new RegExp(`--brand-${name}:\\s*(#[0-9a-f]{6})`))![1];
    const mutedVar = cssVar("text-muted");
    const backgroundVar = cssVar("background");
    const surfaceVar = cssVar("surface");

    expect(mutedVar).not.toBe("#b7d6b2");
    expect(contrastRatio(mutedVar, backgroundVar)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(mutedVar, surfaceVar)).toBeGreaterThanOrEqual(4.5);
    // Only the unreadable ink role moved — the rest of the read still IS the
    // image, and the lossless primitive layer keeps what the tile printed.
    expect(backgroundVar).toBe("#f7f1e6");
    expect(surfaceVar).toBe("#edf1e8");
    expect(cssVar("text")).toBe("#1f352d");
    expect(cssVar("primary")).toBe("#3f8a63");
    expect(css).toContain("#b7d6b2"); // still a hue-named brand primitive

    // …but a USER lock on the same role outranks the finisher: a pinned hex is
    // honored verbatim everywhere else in the engine, so lock-and-rotate is not
    // quietly overridden by accessibility.
    await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: sproutDirectionId,
      lockedColors: [{ role: "muted", hex: "#b7d6b2" }],
    });
    const after = await readHeadVersion(sproutDirectionId);
    expect(byRole(after, "muted")).toBe("#b7d6b2");
  });
});
