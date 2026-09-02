import { describe, it, expect } from "vitest";
import type { DirectionContent, DirectionTokens } from "../types.js";
import {
  resolveBrandVars,
  renderBrandCss,
  APPROXIMATE_FONT_NOTE,
} from "../approve/render-guides.js";
import { CommandError } from "../errors.js";
import {
  renderDtcgTokens,
  hexToDtcgColor,
  cssLengthToDtcgDimension,
} from "./render-dtcg-tokens.js";

const FIXTURE_TOKENS: DirectionTokens = {
  palette: [
    { role: "primary", name: "Hot Pink", hex: "#e84393" },
    { role: "secondary", name: "Sky Blue", hex: "#2d98da" },
    { role: "background", name: "Cream", hex: "#faf6f0" },
    { role: "surface", name: "White", hex: "#ffffff" },
    { role: "text", name: "Ink", hex: "#1c1a17" },
    { role: "muted", name: "Slate", hex: "#6c757d" },
  ],
  brand: [
    { hex: "#e84393", name: "pink", label: "Hot Pink" },
    { hex: "#2d98da", name: "sky-blue" },
  ],
  typography: { heading: "Space Grotesk", body: "Inter", scale: 1.25 },
  shape: { radius: "8px", spacingUnit: "8px" },
};

function makeFixture(tokens: DirectionTokens): DirectionContent {
  return {
    name: "Test Direction",
    summary: "A summary.",
    positioning: "A positioning statement.",
    character: {},
    homepageMockupPrompt: "",
    styleTilePrompt: "",
    copyExamples: { headline: "h", subheadline: "s", cta: "c" },
    usage: { rules: [], antiRules: [] },
    tokens,
  };
}

const FIXTURE_DIRECTION = makeFixture(FIXTURE_TOKENS);

describe("hexToDtcgColor / renderDtcgTokens — DTCG color spine (SC-06)", () => {
  it("color .hex values match the BrandVars values byte-for-byte, proven against brand.css", () => {
    const vars = resolveBrandVars(FIXTURE_DIRECTION);
    const dtcg = renderDtcgTokens(vars) as any;

    expect(dtcg.color.background.$value.hex).toBe(vars.background);
    expect(dtcg.color.surface.$value.hex).toBe(vars.surface);
    expect(dtcg.color.text.$value.hex).toBe(vars.text);
    expect(dtcg.color.muted.$value.hex).toBe(vars.textMuted);
    expect(dtcg.color.primary.$value.hex).toBe(vars.primary);
    expect(dtcg.color.secondary.$value.hex).toBe(vars.secondary);

    const css = renderBrandCss(FIXTURE_DIRECTION);
    expect(css).toContain(`--brand-primary: ${dtcg.color.primary.$value.hex};`);
    expect(css).toContain(`--brand-secondary: ${dtcg.color.secondary.$value.hex};`);
    expect(css).toContain(`--brand-background: ${dtcg.color.background.$value.hex};`);
    expect(css).toContain(`--brand-surface: ${dtcg.color.surface.$value.hex};`);
    expect(css).toContain(`--brand-text: ${dtcg.color.text.$value.hex};`);
    expect(css).toContain(`--brand-text-muted: ${dtcg.color.muted.$value.hex};`);
  });

  it("emits structured { colorSpace, components, alpha, hex } color values", () => {
    const vars = resolveBrandVars(FIXTURE_DIRECTION);
    const dtcg = renderDtcgTokens(vars) as any;

    for (const role of ["background", "surface", "text", "muted", "primary", "secondary"]) {
      const value = dtcg.color[role].$value;
      expect(value.colorSpace).toBe("srgb");
      expect(value.alpha).toBe(1);
      const hex = value.hex as string;
      const r = parseInt(hex.slice(1, 3), 16) / 255;
      const g = parseInt(hex.slice(3, 5), 16) / 255;
      const b = parseInt(hex.slice(5, 7), 16) / 255;
      expect(value.components).toEqual([r, g, b]);
    }

    expect(hexToDtcgColor("#ffffff").components).toEqual([1, 1, 1]);
  });

  it("every brand[] primitive is present, labeled/unlabeled correctly, nothing dropped or synthesized", () => {
    const vars = resolveBrandVars(FIXTURE_DIRECTION);
    const dtcg = renderDtcgTokens(vars) as any;

    for (const b of FIXTURE_TOKENS.brand!) {
      expect(dtcg.color.brand[b.name].$value.hex).toBe(b.hex);
    }
    expect(dtcg.color.brand.pink.$description).toBe("Hot Pink");
    expect("$description" in dtcg.color.brand["sky-blue"]).toBe(false);
    expect(Object.keys(dtcg.color.brand)).toHaveLength(FIXTURE_TOKENS.brand!.length);

    const noBrandVars = resolveBrandVars(makeFixture({ ...FIXTURE_TOKENS, brand: [] }));
    const noBrandDtcg = renderDtcgTokens(noBrandVars) as any;
    expect(noBrandDtcg.color.brand).toBeUndefined();
  });

  it("$type correctness + structured dimensions", () => {
    const vars = resolveBrandVars(FIXTURE_DIRECTION);
    const dtcg = renderDtcgTokens(vars) as any;

    for (const role of ["background", "surface", "text", "muted", "primary", "secondary"]) {
      expect(dtcg.color[role].$type).toBe("color");
    }

    expect(dtcg.typography.heading.$type).toBe("fontFamily");
    expect(dtcg.typography.heading.$value).toBe(vars.fontHeadingFamily);
    expect(dtcg.typography.heading.$value).not.toContain("system-ui");
    expect(dtcg.typography.body.$type).toBe("fontFamily");
    expect(dtcg.typography.body.$value).toBe(vars.fontBodyFamily);

    expect(dtcg.shape.radius.$type).toBe("dimension");
    expect(dtcg.shape.radius.$value).toEqual({ value: 8, unit: "px" });
    expect(dtcg.shape.spacingUnit.$type).toBe("dimension");
    expect(dtcg.shape.spacingUnit.$value).toEqual({ value: 8, unit: "px" });

    expect(cssLengthToDtcgDimension("0.5rem")).toEqual({ value: 0.5, unit: "rem" });
    expect(() => cssLengthToDtcgDimension("12em")).toThrow(CommandError);
    expect(() => cssLengthToDtcgDimension("auto")).toThrow(CommandError);
  });

  it("typography carries the approximate-font note (the same constant, not a re-typed copy)", () => {
    const vars = resolveBrandVars(FIXTURE_DIRECTION);
    const dtcg = renderDtcgTokens(vars) as any;
    expect(dtcg.typography.$description).toBe(APPROXIMATE_FONT_NOTE);
  });

  it("emits typography.scale only when opts.scale is provided", () => {
    const vars = resolveBrandVars(FIXTURE_DIRECTION);

    const withScale = renderDtcgTokens(vars, { scale: 1.25 }) as any;
    expect(withScale.typography.scale).toEqual({ $type: "number", $value: 1.25 });

    const withoutOpts = renderDtcgTokens(vars) as any;
    expect("scale" in withoutOpts.typography).toBe(false);

    const undefinedScale = renderDtcgTokens(vars, { scale: undefined }) as any;
    expect("scale" in undefinedScale.typography).toBe(false);
  });

  it("is deterministic — identical input yields JSON.stringify-identical output", () => {
    const vars = resolveBrandVars(FIXTURE_DIRECTION);
    const a = JSON.stringify(renderDtcgTokens(vars, { scale: 1.25 }));
    const b = JSON.stringify(renderDtcgTokens(vars, { scale: 1.25 }));
    expect(a).toBe(b);
  });
});
