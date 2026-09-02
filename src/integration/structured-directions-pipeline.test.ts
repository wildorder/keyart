import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  KeyartConfig,
  PaletteRole,
  DirectionContent,
} from "../types.js";

// Mock loadConfig (tmp project) AND openai — the SAME pattern as the sibling
// invert-extract / token pipeline tests. Every other export keeps its real
// implementation; the openai fns default to `actual` (genuine dry-run without a
// key) and are overridden ONLY inside the keyed test that exercises the live
// generate→extract path with a stubbed image write + role-tagged vision read.
// Nothing hits the network and no key is ever required — the whole proof is
// deterministic, network-free, and key-free (SC-09/SC-10).
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
  };
});

import { runDirection } from "../commands/direction.js";
import { runExplore } from "../commands/explore.js";
import { directionsRoot } from "../config.js";
import { readHead } from "../direction/store.js";
import {
  hasApiKey,
  chatJson,
  generateImage,
  describeImageBrand,
  type BrandColorRead,
} from "../openai.js";
import { renderBrandCss } from "../approve/render-guides.js";
import { renderStyleBoardMarkdown } from "../approve/render-style-board.js";
import { FONT_PAIRINGS } from "../brand/fonts.js";

// --- fixtures ---------------------------------------------------------------

/**
 * A role-tagged vision read of a DARK-MODE style tile. The point of the fixture
 * is to prove roles come from the model's TAGS, not a lightness sort: the color
 * tagged `background` is the DARKEST of all seven and the color tagged `text`
 * is the LIGHTEST — the exact inverse of what a "sort by lightness" heuristic
 * would pick. Four universal roles are tagged directly (background/text/
 * primary/secondary, WS-02) and three more colors are the open `brand` set. All
 * seven hexes are distinct, so the lossless `brand[]` layer must carry seven
 * entries — none dropped, none synthesized (SC-03).
 */
const READ: BrandColorRead[] = [
  { hex: "#0d1b2a", role: "background", label: "Midnight" }, // DARKEST → background
  { hex: "#f5f5f5", role: "text", label: "Paper" }, //           LIGHTEST → text
  { hex: "#ff5722", role: "primary", label: "Ember" },
  { hex: "#06d6a0", role: "secondary", label: "Mint" },
  { hex: "#ffc107", role: "brand", label: "Amber" },
  { hex: "#7209b7", role: "brand", label: "Grape" },
  { hex: "#4361ee", role: "brand", label: "Cobalt" },
];

/** The distinct normalized hexes the read carries, lowercase. */
const READ_HEXES = READ.map((c) => c.hex.toLowerCase());

/** The role → tagged hex the extraction MUST honor verbatim (not a lightness
 * sort). `surface`/`muted` are left for the engine to finish. */
const TAGGED_ROLES: Record<string, string> = {
  background: "#0d1b2a",
  text: "#f5f5f5",
  primary: "#ff5722",
  secondary: "#06d6a0",
};

/** The six semantic roles the two-tier palette always resolves. */
const SEMANTIC_ROLES: PaletteRole[] = [
  "background",
  "surface",
  "text",
  "muted",
  "primary",
  "secondary",
];

/** Every real catalog family — no font name may leak into a direction's prose. */
const CATALOG_FONTS = [
  ...new Set(FONT_PAIRINGS.flatMap((p) => [p.heading, p.body])),
];

/** Matches a `#rgb` or `#rrggbb` hex — no color may leak into prose. */
const HEX_RE = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/;

const byRole = (direction: DirectionContent, role: PaletteRole): string =>
  direction.tokens!.palette.find((t) => t.role === role)!.hex.toLowerCase();

/** Every evocative-prose string on a direction: the `character` values + the
 * `usage` rules/antiRules. Color/type live ONLY in `tokens`, so this set must be
 * hex-free and font-free (SC-08). */
function proseStrings(direction: DirectionContent): string[] {
  return [
    ...Object.values(direction.character).filter(
      (v): v is string => typeof v === "string",
    ),
    ...direction.usage.rules,
    ...direction.usage.antiRules,
  ];
}

// --- config / harness (mirrors the sibling integration tests) ---------------

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Structured Directions ITest", type: "prototype", framework: "next" },
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-structdir-"));
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

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

/** Overwrite a direction's scaffolded brief with searchable content. */
async function writeBrief(directionId: string, body: string): Promise<void> {
  const config = buildTestConfig(tmpDir);
  const briefPath = path.join(directionsRoot(tmpDir, config), directionId, "brief.md");
  await fs.writeFile(briefPath, body, "utf-8");
}

/** Absolute `directions/` dir for a direction under the tmp project. */
function directionsDirOf(directionId: string): string {
  const config = buildTestConfig(tmpDir);
  return directionsRoot(tmpDir, config);
}

/** The raw on-disk head `direction-version.json` object (untyped) — lets us
 * assert the retired fields are ABSENT from the persisted shape (SC-02). */
async function readHeadRaw(
  directionId: string,
): Promise<Record<string, unknown>> {
  const directionsDir = directionsDirOf(directionId);
  const head = await readHead(directionsDir, directionId);
  const raw = await fs.readFile(
    path.join(directionsDir, directionId, "versions", head.id, "direction-version.json"),
    "utf-8",
  );
  return JSON.parse(raw) as Record<string, unknown>;
}

/**
 * Flip the openai mocks to a "keyed" world: a present key, a text model that
 * returns one valid direction with STRUCTURED `character` + `usage` (no prose
 * hex/font), an image model that WRITES a placeholder tile (so extraction runs),
 * and ONE consolidated brand read that transcribes the dark-mode ROLE-TAGGED
 * palette. No bytes cross the network.
 */
function goLive(): void {
  vi.mocked(hasApiKey).mockReturnValue(true);
  vi.mocked(chatJson).mockResolvedValue({
    data: {
      directions: [
        {
          id: "direction-a",
          name: "Nocturne",
          summary: "A dark, editorial system read back off its own tile.",
          positioning: "Calm authority for teams that work after dark.",
          // Structured, hex/font-free evocative character (SC-02/SC-08) — the
          // successor of the retired freeform `visualStyle` prose. Every value
          // references feeling/structure, never a color hex or a font family.
          character: {
            mood: "Confident and nocturnal — a calm, focused energy.",
            composition: "Generous negative space around a strong central column.",
            layout: "A twelve-column grid, dense above the fold, airy below.",
            imagery: "Editorial photography with soft, diffuse lighting.",
            texture: "Matte surfaces with a faint paper grain.",
            rhythm: "Steady, unhurried pacing with deliberate pauses.",
          },
          homepageMockupPrompt: "A dark homepage mockup.",
          styleTilePrompt: "A dark style tile printing a labeled palette panel.",
          copyExamples: { headline: "Ship it", subheadline: "After dark", cta: "Start" },
          // Imperative rules that reference ROLES, never raw hexes (SC-08).
          usage: {
            rules: [
              "Lead with the primary role for calls to action",
              "Reserve the darkest role for page backgrounds",
              "Let the text role carry long-form reading",
            ],
            antiRules: [
              "Never place body copy on the primary role",
              "Do not crowd the composition",
            ],
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
      // The model returns its OWN role assignment; the extractor honors the tags
      // (never a lightness sort) and preserves every color as a brand primitive.
      colors: READ,
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

describe("structured-directions pipeline (end-to-end, no network / no key)", () => {
  it("proves generate → role-tagged extraction → two-tier projections → hex/font-free prose in ONE keyed flow (SC-02/03/04/06/08)", async () => {
    goLive();
    await runDirection({ cwd: tmpDir, verb: "new", id: "nocturne" });
    await writeBrief("nocturne", "A dark, editorial analytics brand.");

    const run = await runExplore({ cwd: tmpDir, directionId: "nocturne" });
    expect(run.dryRun).toBe(false); // the keyed generate→extract path ran

    const directionId = run.directionIds[0];
    const raw = await readHeadRaw(directionId);
    const direction = raw as unknown as DirectionContent;

    // ── SC-02: structured content; the freeform holdouts are GONE from disk ──
    expect(typeof direction.character).toBe("object");
    expect(Array.isArray(direction.usage.rules)).toBe(true);
    expect(Array.isArray(direction.usage.antiRules)).toBe(true);
    expect(direction.character.mood).toMatch(/nocturnal/i);
    expect("visualStyle" in raw).toBe(false);
    expect("designRules" in raw).toBe(false);
    expect("antiRules" in raw).toBe(false);

    // ── SC-04: roles are ASSIGNED BY THE TAGS, not a lightness sort ──
    // The darkest color is the background and the lightest is the text — the
    // inverse of a sort — because the model tagged them that way.
    expect(direction.tokens!.palette).toHaveLength(6);
    for (const [role, hex] of Object.entries(TAGGED_ROLES)) {
      expect(byRole(direction, role as PaletteRole)).toBe(hex);
    }
    // The engine only FINISHED the untagged neutrals (they still resolve).
    expect(byRole(direction, "surface")).toMatch(HEX_RE);
    expect(byRole(direction, "muted")).toMatch(HEX_RE);

    // ── SC-03: lossless brand[] — N distinct read colors → N entries, none
    // dropped or synthesized (structural neutrals included). ──
    const brand = direction.tokens!.brand!;
    expect(brand).toHaveLength(READ.length);
    const brandHexes = new Set(brand.map((b) => b.hex.toLowerCase()));
    expect(brandHexes).toEqual(new Set(READ_HEXES));
    // Names are unique handles (the two-tier lower layer's CSS-var suffixes).
    expect(new Set(brand.map((b) => b.name)).size).toBe(brand.length);

    // ── SC-06: brand.css emits BOTH tiers; hexes match the tokens byte-for-byte,
    // and there is no legacy `--brand-accent`. ──
    const css = renderBrandCss(direction);
    for (const role of ["primary", "secondary", "background", "surface", "text"]) {
      expect(css).toContain(`--brand-${role}:`);
    }
    expect(css).toContain("--brand-text-muted:");
    expect(css).not.toContain("--brand-accent");
    for (const t of direction.tokens!.palette) {
      expect(css).toContain(t.hex.toLowerCase());
    }
    for (const b of brand) {
      expect(css).toContain(`--brand-${b.name}: ${b.hex.toLowerCase()}`);
    }

    // ── SC-06: the board lists the six semantic swatches + the full brand table,
    // and every hex matches the tokens. ──
    const board = renderStyleBoardMarkdown(direction);
    for (const label of ["Primary", "Secondary", "Background", "Surface", "Text", "Text Muted"]) {
      expect(board).toContain(label);
    }
    expect(board).toContain("## Brand Colors");
    for (const t of direction.tokens!.palette) {
      expect(board).toContain(t.hex.toLowerCase());
    }
    for (const b of brand) {
      expect(board).toContain(b.hex.toLowerCase());
      expect(board).toContain(`--brand-${b.name}`);
    }

    // ── SC-08: NO hex and NO catalog font family leaks into the prose. ──
    const prose = proseStrings(direction);
    expect(prose.length).toBeGreaterThan(0);
    for (const line of prose) {
      expect(line).not.toMatch(HEX_RE);
      const lower = line.toLowerCase();
      for (const font of CATALOG_FONTS) {
        expect(lower).not.toContain(font.toLowerCase());
      }
    }
  });

  it("keyless parity: no key still yields structured directions + a full six-role board and never throws (SC-09)", async () => {
    // No key, no image, no mocks overridden — the genuinely keyless path.
    await runDirection({ cwd: tmpDir, verb: "new", id: "keyless" });
    await writeBrief("keyless", "A keyless dry-run brand.");

    const run = await runExplore({ cwd: tmpDir, directionId: "keyless" });
    expect(run.dryRun).toBe(true);

    const directionId = run.directionIds[0];
    const raw = await readHeadRaw(directionId);
    const direction = raw as unknown as DirectionContent;

    // Structured content still lands — even without a model call.
    expect(typeof direction.character).toBe("object");
    expect(Array.isArray(direction.usage.rules)).toBe(true);
    expect("visualStyle" in raw).toBe(false);
    expect("designRules" in raw).toBe(false);

    // The intent→engine fallback still yields a full six-role board + exact CSS.
    expect(direction.tokens!.palette).toHaveLength(6);
    for (const role of SEMANTIC_ROLES) {
      expect(byRole(direction, role)).toMatch(HEX_RE);
    }
    let css = "";
    let board = "";
    expect(() => {
      css = renderBrandCss(direction);
      board = renderStyleBoardMarkdown(direction);
    }).not.toThrow();
    expect(css).toContain("--brand-primary:");
    expect(css).not.toContain("--brand-accent");
    expect(css).not.toContain("undefined");
    for (const label of ["Primary", "Background", "Text Muted"]) {
      expect(board).toContain(label);
    }

    // The keyless prose is likewise hex/font-free (the placeholder fields carry
    // no color/type facts — the structural defense, not a prompt plea).
    for (const line of proseStrings(direction)) {
      expect(line).not.toMatch(HEX_RE);
      const lower = line.toLowerCase();
      for (const font of CATALOG_FONTS) {
        expect(lower).not.toContain(font.toLowerCase());
      }
    }
  });
});
