import { describe, it, expect } from "vitest";
import { buildPlaceholderDirections } from "./placeholders.js";
import type { SeedDirection } from "./placeholders.js";
import { contrastRatio } from "../brand/palette.js";
import { FONT_PAIRINGS } from "../brand/fonts.js";
import type { PaletteRole } from "../types.js";

const ALL_ROLES: PaletteRole[] = [
  "primary",
  "secondary",
  "background",
  "surface",
  "text",
  "muted",
];

const SAMPLE_BRIEF = "A calm meditation app for busy professionals.";
const KNOWN_FAMILIES = new Set(
  FONT_PAIRINGS.flatMap((p) => [p.heading, p.body]),
);

function assertValidTokens(d: SeedDirection): void {
  expect(d.tokens).toBeDefined();
  const tokens = d.tokens!;
  // Six palette roles, each a valid hex.
  expect(tokens.palette.map((t) => t.role).sort()).toEqual(
    [...ALL_ROLES].sort(),
  );
  for (const t of tokens.palette) {
    expect(t.hex).toMatch(/^#[0-9a-f]{6}$/);
  }
  // Typography from the real catalog (never hallucinated).
  expect(KNOWN_FAMILIES.has(tokens.typography.heading)).toBe(true);
  expect(KNOWN_FAMILIES.has(tokens.typography.body)).toBe(true);
  // Shape tokens present.
  expect(tokens.shape.radius).toMatch(/px$/);
  expect(tokens.shape.spacingUnit).toMatch(/px$/);
  // Contrast holds.
  const byRole = Object.fromEntries(tokens.palette.map((t) => [t.role, t.hex]));
  expect(contrastRatio(byRole.text, byRole.background)).toBeGreaterThanOrEqual(
    4.5,
  );
  expect(contrastRatio(byRole.text, byRole.surface)).toBeGreaterThanOrEqual(4.5);
}

describe("buildPlaceholderDirections tokens", () => {
  it("every default direction carries valid, contrast-safe tokens", () => {
    for (const d of buildPlaceholderDirections(SAMPLE_BRIEF)) {
      assertValidTokens(d);
    }
  });

  it("prose text is byte-identical to the original template output", () => {
    const dirs = buildPlaceholderDirections(SAMPLE_BRIEF);
    expect(dirs.map((d) => d.id)).toEqual([
      "direction-a",
      "direction-b",
      "direction-c",
    ]);
    expect(dirs.map((d) => d.name)).toEqual([
      "Bold & Modern",
      "Warm & Approachable",
      "Minimal & Refined",
    ]);
    // Snippet-independent structured character projects to prose verbatim.
    const characterProse = (d: SeedDirection): string =>
      [
        d.character.mood,
        d.character.composition,
        d.character.layout,
        d.character.imagery,
        d.character.texture,
        d.character.rhythm,
      ]
        .filter(Boolean)
        .join(" ");
    expect(characterProse(dirs[0])).toBe(
      "Bold, confident, forward-looking. Strong contrast with generous whitespace. Grid-aligned with clean, sharp geometry. Decisive, high-energy pacing.",
    );
    expect(characterProse(dirs[1])).toBe(
      "Warm, friendly, human-centered. Soft, balanced arrangements with gentle depth. Roomy, breathing layouts with rounded forms. Organic illustration with a hand-made feel. Soft shadows and tactile, approachable surfaces.",
    );
    expect(characterProse(dirs[2])).toBe(
      "Restrained, elegant, premium. Sparse, precise, whitespace-led balance. Strict vertical rhythm with ample whitespace. Calm, deliberate pacing with subtle motion.",
    );
    expect(dirs[0].usage.rules).toEqual([
      "Use a maximum of 3 brand colors plus neutrals",
      "Maintain at least 4:1 contrast ratio on all text",
      "Use the heading role for headings, the body role for body copy",
      "Keep layouts grid-aligned with consistent 8px spacing",
    ]);
    expect(dirs[2].usage.antiRules).toEqual([
      "Never use more than one emphasis color at a time",
      "Avoid busy patterns, textures, or decorative elements",
      "Do not use bold weights above 600 for body text",
    ]);
    // Summary still reflects the brief snippet verbatim (unchanged shape).
    expect(dirs[0].summary).toContain("A bold, modern direction");
    expect(dirs[0].summary).toContain(SAMPLE_BRIEF.slice(0, 60));
  });

  it("is deterministic including tokens", () => {
    expect(buildPlaceholderDirections(SAMPLE_BRIEF)).toEqual(
      buildPlaceholderDirections(SAMPLE_BRIEF),
    );
  });
});

describe("buildPlaceholderDirections structured character/usage", () => {
  const HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/;

  it("emits a populated character object + usage rules/antiRules, never the legacy keys (SC-08)", () => {
    for (const d of buildPlaceholderDirections(SAMPLE_BRIEF)) {
      // Structured character is a non-empty object (at least one facet set).
      expect(typeof d.character).toBe("object");
      expect(Object.values(d.character).some((v) => !!v)).toBe(true);
      // Usage carries the minimum imperative rule counts.
      expect(d.usage.rules.length).toBeGreaterThanOrEqual(3);
      expect(d.usage.antiRules.length).toBeGreaterThanOrEqual(2);
      // The retired freeform fields are gone.
      const rec = d as unknown as Record<string, unknown>;
      expect(rec.visualStyle).toBeUndefined();
      expect(rec.designRules).toBeUndefined();
      expect(rec.antiRules).toBeUndefined();
    }
  });

  it("leaks no hex code or catalog font family into character/usage (SC-02)", () => {
    for (const d of buildPlaceholderDirections(SAMPLE_BRIEF)) {
      const prose = [
        ...Object.values(d.character).filter((v): v is string => !!v),
        ...d.usage.rules,
        ...d.usage.antiRules,
      ];
      for (const s of prose) {
        expect(s).not.toMatch(HEX_RE);
        for (const family of KNOWN_FAMILIES) {
          expect(s).not.toContain(family);
        }
      }
    }
  });
});
