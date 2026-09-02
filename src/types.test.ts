import { describe, it, expect } from "vitest";
import type {
  DirectionCharacter,
  DirectionContent,
  DirectionTokens,
  DirectionUsage,
  DirectionVersion,
  PaletteRole,
  PaletteToken,
} from "./types.js";

/**
 * WS-01 schema shape assertions (pure, no I/O). Proves the "structure is truth"
 * reshape: a direction carries structured `character` + `usage`, the token model
 * is two-tier (six semantic roles + unbounded `brand[]`), and there is no
 * `accent` role and no freeform hex/font-holding prose field.
 */

/** The six semantic roles, in canonical order — no `accent`. */
const SIX_ROLES: PaletteRole[] = [
  "background",
  "surface",
  "text",
  "muted",
  "primary",
  "secondary",
];

function sixRolePalette(): PaletteToken[] {
  return SIX_ROLES.map((role, i) => ({
    role,
    name: role,
    hex: `#0000${(10 + i).toString(16)}`,
  }));
}

function twoTierTokens(): DirectionTokens {
  return {
    palette: sixRolePalette(),
    brand: [
      { hex: "#ff33aa", name: "pink", label: "Hot Pink" },
      { hex: "#33aaff", name: "sky-blue" },
    ],
    typography: { heading: "Space Grotesk", body: "Inter", scale: 1.25 },
    shape: { radius: "8px", spacingUnit: "8px" },
    provenance: {
      baseHue: 250,
      scheme: "complementary",
      seed: 1,
      extracted: ["#ff33aa"],
    },
  };
}

describe("DirectionContent structured shape (WS-01)", () => {
  it("round-trips a populated character + usage + two-tier tokens", () => {
    const character: DirectionCharacter = {
      mood: "bold",
      composition: "high contrast",
      layout: "grid",
      imagery: "geometric",
      texture: "flat",
      rhythm: "decisive",
    };
    const usage: DirectionUsage = {
      rules: ["use the darkest role for body text"],
      antiRules: ["never use more than two typefaces"],
    };
    const direction: DirectionContent = {
      name: "Bold & Modern",
      summary: "A bold direction.",
      positioning: "Confident, forward-thinking leader.",
      character,
      homepageMockupPrompt: "homepage prompt",
      styleTilePrompt: "style tile prompt",
      copyExamples: { headline: "H", subheadline: "S", cta: "C" },
      usage,
      tokens: twoTierTokens(),
    };

    const roundTripped = JSON.parse(
      JSON.stringify(direction),
    ) as DirectionContent;
    expect(roundTripped).toEqual(direction);
    // Two-tier tokens survived: six semantic roles + the unbounded brand set.
    expect(roundTripped.tokens?.palette).toHaveLength(6);
    expect(roundTripped.tokens?.brand).toHaveLength(2);
  });

  it("a DirectionVersion inherits the structured content shape", () => {
    const version: DirectionVersion = {
      name: "V",
      summary: "s",
      positioning: "p",
      character: { mood: "calm" },
      homepageMockupPrompt: "h",
      styleTilePrompt: "t",
      copyExamples: { headline: "H", subheadline: "S", cta: "C" },
      usage: { rules: ["r"], antiRules: ["a"] },
      id: "v1",
      createdAt: "2026-01-01T00:00:00.000Z",
      briefSnapshot: "brief",
      contextSnapshot: "context",
    };
    expect(JSON.parse(JSON.stringify(version))).toEqual(version);
  });
});

describe("PaletteRole is exactly the six semantic roles", () => {
  it("lists six roles and none of them is 'accent'", () => {
    const roles: PaletteRole[] = [
      "background",
      "surface",
      "text",
      "muted",
      "primary",
      "secondary",
    ];
    expect(roles).toHaveLength(6);
    expect(roles).not.toContain("accent");
  });

  it("rejects 'accent' as a PaletteRole at compile time", () => {
    // @ts-expect-error — "accent" is no longer a valid PaletteRole (SC-03).
    const bad: PaletteRole = "accent";
    // Runtime touch so the binding is used; the assertion above is compile-time.
    expect(bad).toBe("accent");
  });
});

describe("empty structured fields are a legal shape (SC-09)", () => {
  it("admits an empty character and empty usage arrays", () => {
    const direction: DirectionContent = {
      name: "Empty",
      summary: "keyless run placeholder",
      positioning: "p",
      character: {},
      homepageMockupPrompt: "h",
      styleTilePrompt: "t",
      copyExamples: { headline: "H", subheadline: "S", cta: "C" },
      usage: { rules: [], antiRules: [] },
    };
    expect(JSON.parse(JSON.stringify(direction))).toEqual(direction);
    expect(direction.character).toEqual({});
    expect(direction.usage.rules).toEqual([]);
  });
});
