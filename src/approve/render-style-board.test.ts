import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DirectionContent, DirectionTokens } from "../types.js";
import {
  renderBrandCss,
  APPROXIMATE_FONT_NOTE,
  type SourceStamp,
} from "./render-guides.js";
import {
  renderStyleBoardMarkdown,
  renderStyleBoardSvg,
} from "./render-style-board.js";

const SAMPLE_TOKENS: DirectionTokens = {
  palette: [
    { role: "primary", name: "Primary", hex: "#3b1e5e" },
    { role: "secondary", name: "Secondary", hex: "#7a4fb5" },
    { role: "background", name: "Background", hex: "#fbf9ff" },
    { role: "surface", name: "Surface", hex: "#efe9f7" },
    { role: "text", name: "Text", hex: "#1c1030" },
    { role: "muted", name: "Muted", hex: "#6b5b83" },
  ],
  typography: { heading: "Fraunces", body: "Nunito Sans", scale: 1.25 },
  shape: { radius: "14px", spacingUnit: "6px" },
};

const TOKENED_DIRECTION: DirectionContent = {
  name: "Token Direction",
  summary: "A tokened direction.",
  positioning: "Positioning prose.",
  character: { mood: "warm earthy prose that must NOT drive the board" },
  homepageMockupPrompt: "Homepage prompt.",
  styleTilePrompt: "Style tile prompt.",
  copyExamples: { headline: "H", subheadline: "S", cta: "C" },
  usage: { rules: ["Rule one"], antiRules: ["Anti one"] },
  tokens: SAMPLE_TOKENS,
};

const LEGACY_DIRECTION: DirectionContent = {
  name: "Legacy Direction",
  summary: "A token-less legacy direction.",
  positioning: "Positioning prose.",
  character: { mood: "A minimal, refined system with restrained palette." },
  homepageMockupPrompt: "Homepage prompt.",
  styleTilePrompt: "Style tile prompt.",
  copyExamples: { headline: "H", subheadline: "S", cta: "C" },
  usage: { rules: ["Rule one"], antiRules: ["Anti one"] },
};

const SAMPLE_STAMP: SourceStamp = {
  directionId: "direction-tokened",
  versionId: "2026-06-30T00-00-00-000Z",
  approvedAt: "2026-06-30T00-00-00.000Z",
};

describe("render-style-board — deterministic token artifact", () => {
  const originalKey = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    if (originalKey !== undefined) process.env.OPENAI_API_KEY = originalKey;
    else delete process.env.OPENAI_API_KEY;
  });

  it("board hex/font values match brand.css exactly (SC-04)", () => {
    const css = renderBrandCss(TOKENED_DIRECTION, SAMPLE_STAMP);
    const md = renderStyleBoardMarkdown(TOKENED_DIRECTION, SAMPLE_STAMP);
    const svg = renderStyleBoardSvg(TOKENED_DIRECTION);

    for (const token of SAMPLE_TOKENS.palette) {
      // Every hex the CSS emits also appears in BOTH board outputs.
      expect(css).toContain(token.hex);
      expect(md).toContain(token.hex);
      expect(svg).toContain(token.hex);
    }
    // The heading/body families appear in all three.
    for (const family of ["Fraunces", "Nunito Sans"]) {
      expect(css).toContain(family);
      expect(md).toContain(family);
      expect(svg).toContain(family);
    }
  });

  it("markdown labels the exact tier and carries the stamp + contrast + shape", () => {
    const md = renderStyleBoardMarkdown(TOKENED_DIRECTION, SAMPLE_STAMP);
    expect(md).toContain("# Palette & Type (exact)");
    expect(md.startsWith("<!-- Source: direction=direction-tokened")).toBe(true);
    // Contrast column present (background vs itself = 1.00:1).
    expect(md).toContain("1.00:1");
    expect(md).toContain("`14px`");
    expect(md).toContain("`6px`");
    // Optional type scale surfaced.
    expect(md).toContain("1.25");
  });

  it("svg is well-formed and escapes text", () => {
    const svg = renderStyleBoardSvg(TOKENED_DIRECTION);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    // Ampersand in the title is escaped, never raw.
    expect(svg).toContain("Palette &amp; Type");
    expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("is byte-identical across repeated calls (deterministic) and needs no key", () => {
    expect(renderStyleBoardSvg(TOKENED_DIRECTION)).toBe(
      renderStyleBoardSvg(TOKENED_DIRECTION),
    );
    expect(renderStyleBoardMarkdown(TOKENED_DIRECTION, SAMPLE_STAMP)).toBe(
      renderStyleBoardMarkdown(TOKENED_DIRECTION, SAMPLE_STAMP),
    );
    // No stamp is byte-identical to the no-arg form.
    expect(renderStyleBoardMarkdown(TOKENED_DIRECTION)).toBe(
      renderStyleBoardMarkdown(TOKENED_DIRECTION, undefined),
    );
  });

  it("labels the extracted-token fonts approximate on both board outputs", () => {
    const md = renderStyleBoardMarkdown(TOKENED_DIRECTION, SAMPLE_STAMP);
    const svg = renderStyleBoardSvg(TOKENED_DIRECTION);
    // The honesty caption is present on the type specimen in both outputs.
    expect(md).toContain(APPROXIMATE_FONT_NOTE);
    expect(svg).toContain(APPROXIMATE_FONT_NOTE);
    // The board's font families/hexes still match brand.css exactly (contract
    // unchanged by the caption — the caption is prose, not a token value).
    const css = renderBrandCss(TOKENED_DIRECTION, SAMPLE_STAMP);
    for (const token of SAMPLE_TOKENS.palette) {
      expect(md).toContain(token.hex);
      expect(svg).toContain(token.hex);
      expect(css).toContain(token.hex);
    }
    // SVG stays well-formed with the extra caption row.
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });

  it("renders the unbounded brand[] primitives on both board outputs", () => {
    const withBrand: DirectionContent = {
      ...TOKENED_DIRECTION,
      tokens: {
        ...SAMPLE_TOKENS,
        brand: [
          { hex: "#ff2d8d", name: "pink", label: "Hot Pink" },
          { hex: "#00b3a4", name: "teal" },
        ],
      },
    };
    const md = renderStyleBoardMarkdown(withBrand, SAMPLE_STAMP);
    const svg = renderStyleBoardSvg(withBrand);

    // Markdown surfaces the hue-named handles, hexes and the printed label.
    expect(md).toContain("## Brand Colors");
    expect(md).toContain("`--brand-pink`");
    expect(md).toContain("`--brand-teal`");
    expect(md).toContain("Hot Pink");
    expect(md).toContain("#ff2d8d");
    expect(md).toContain("#00b3a4");

    // SVG paints the primitive swatches and stays well-formed.
    expect(svg).toContain("Brand colors");
    expect(svg).toContain("#ff2d8d");
    expect(svg).toContain("#00b3a4");
    expect(svg).toContain(">pink<");
    expect(svg).toContain(">teal<");
    expect(svg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(svg).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);

    // A brand-less board emits no primitives section (byte-clean omission).
    const plain = renderStyleBoardMarkdown(TOKENED_DIRECTION, SAMPLE_STAMP);
    expect(plain).not.toContain("## Brand Colors");
    expect(renderStyleBoardSvg(TOKENED_DIRECTION)).not.toContain("Brand colors");
  });

  it("throws for a token-less direction — tokens are the required source", () => {
    // The prose→keyword fallback is gone; a direction must carry extracted
    // tokens, so all three projections fail loudly rather than inventing values.
    expect(() => renderBrandCss(LEGACY_DIRECTION)).toThrow(/no structured tokens/);
    expect(() => renderStyleBoardMarkdown(LEGACY_DIRECTION)).toThrow(
      /no structured tokens/,
    );
    expect(() => renderStyleBoardSvg(LEGACY_DIRECTION)).toThrow(
      /no structured tokens/,
    );
  });
});
