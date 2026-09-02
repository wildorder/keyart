import type { DirectionContent, DirectionTokens, HarmonyScheme } from "../types.js";
import { generatePalette } from "../brand/palette.js";
import { resolveFontPairing } from "../brand/fonts.js";

/**
 * Generated/placeholder direction CONTENT plus the suggested directionId-base
 * slug (`id`). WS-01 replaces the old flat `VisualDirection` return shape: the
 * `id` is a directionId *base* the explore command (WS-02) mints a real,
 * collision-safe directionId from — it is NOT a version id.
 */
export type SeedDirection = DirectionContent & { id: string };

/**
 * Deterministic token config per base template — chosen to echo each template's
 * prose (Bold & Modern → cool-blue complementary; Warm & Approachable →
 * warm-orange analogous; Minimal & Refined → near-monochromatic charcoal). The
 * seed is derived from the template index (never random), so the emitted tokens
 * are stable across runs and give dry-run parity with the real generator.
 */
interface TemplateTokenSpec {
  baseHue: number;
  scheme: HarmonyScheme;
  fontId: string;
  radius: string;
  spacingUnit: string;
  scale: number;
}

const TEMPLATE_TOKEN_SPECS: TemplateTokenSpec[] = [
  // direction-a — Bold & Modern
  { baseHue: 250, scheme: "complementary", fontId: "grotesk-inter", radius: "8px", spacingUnit: "8px", scale: 1.25 },
  // direction-b — Warm & Approachable
  { baseHue: 42, scheme: "analogous", fontId: "dm-sans-inter", radius: "12px", spacingUnit: "8px", scale: 1.2 },
  // direction-c — Minimal & Refined
  { baseHue: 265, scheme: "monochromatic", fontId: "playfair-source-sans", radius: "4px", spacingUnit: "8px", scale: 1.333 },
];

/** Build deterministic tokens for a base template (seed derived from index). */
function buildTemplateTokens(index: number): DirectionTokens {
  const spec = TEMPLATE_TOKEN_SPECS[index % TEMPLATE_TOKEN_SPECS.length];
  const { palette, provenance } = generatePalette({
    baseHue: spec.baseHue,
    scheme: spec.scheme,
    seed: index + 1,
  });
  const pairing = resolveFontPairing(spec.fontId);
  return {
    palette,
    typography: { heading: pairing.heading, body: pairing.body, scale: spec.scale },
    shape: { radius: spec.radius, spacingUnit: spec.spacingUnit },
    provenance,
  };
}

/**
 * Deterministic placeholder directions for dry-run mode.
 * Derives distinct directions from the first 200 chars of the brief.
 *
 * When `count` is omitted (or 3), the output is byte-identical to the original
 * three-direction set. For `count < 3` the templates are sliced; for
 * `count > 3` the three templates are cycled, appending a `-N` suffix to keep
 * every id unique (e.g. `direction-a-2`, `direction-b-2`, …).
 */
export function buildPlaceholderDirections(
  briefText: string,
  count = 3,
): SeedDirection[] {
  const snippet = briefText.slice(0, 200).trim() || "brand";
  const base = buildBaseTemplates(snippet);

  if (count <= 3) {
    return base.slice(0, Math.max(0, count));
  }

  const out: SeedDirection[] = [];
  for (let i = 0; i < count; i++) {
    const template = base[i % 3];
    const cycle = Math.floor(i / 3) + 1;
    out.push(
      cycle === 1
        ? template
        : { ...template, id: `${template.id}-${cycle}` },
    );
  }
  return out;
}

function buildBaseTemplates(snippet: string): SeedDirection[] {
  const templates: SeedDirection[] = [
    {
      id: "direction-a",
      name: "Bold & Modern",
      summary: `A bold, modern direction emphasizing clean geometry and strong contrast, inspired by: ${snippet.slice(0, 60)}`,
      positioning:
        "Position the brand as a confident, forward-thinking leader with a modern aesthetic.",
      // Structured, hex/font-free evocative character (SC-02) — the direct
      // successor of the retired freeform `visualStyle` prose.
      character: {
        mood: "Bold, confident, forward-looking.",
        composition: "Strong contrast with generous whitespace.",
        layout: "Grid-aligned with clean, sharp geometry.",
        rhythm: "Decisive, high-energy pacing.",
      },
      homepageMockupPrompt: `Design a bold, modern homepage mockup for a brand described as: ${snippet.slice(0, 100)}. Use geometric shapes, strong contrast, and sans-serif typography.`,
      styleTilePrompt: `Create a style tile for a bold, modern brand: ${snippet.slice(0, 100)}. Include color swatches (dark navy, white, electric blue accent), typography samples (geometric sans-serif), and UI element examples.`,
      copyExamples: {
        headline: "Built for what comes next",
        subheadline:
          "A modern platform designed with clarity and confidence.",
        cta: "Get started",
      },
      usage: {
        rules: [
          "Use a maximum of 3 brand colors plus neutrals",
          "Maintain at least 4:1 contrast ratio on all text",
          "Use the heading role for headings, the body role for body copy",
          "Keep layouts grid-aligned with consistent 8px spacing",
        ],
        antiRules: [
          "Never use more than two typefaces on a single page",
          "Avoid rounded or playful shapes — keep geometry sharp",
          "Do not use gradients except as subtle background accents",
        ],
      },
    },
    {
      id: "direction-b",
      name: "Warm & Approachable",
      summary: `A warm, approachable direction with organic shapes and friendly typography, inspired by: ${snippet.slice(0, 60)}`,
      positioning:
        "Position the brand as friendly, trustworthy, and human-centered.",
      // Structured, hex/font-free evocative character (see direction-a).
      character: {
        mood: "Warm, friendly, human-centered.",
        composition: "Soft, balanced arrangements with gentle depth.",
        layout: "Roomy, breathing layouts with rounded forms.",
        imagery: "Organic illustration with a hand-made feel.",
        texture: "Soft shadows and tactile, approachable surfaces.",
      },
      homepageMockupPrompt: `Design a warm, approachable homepage mockup for a brand described as: ${snippet.slice(0, 100)}. Use rounded shapes, warm colors, and friendly typography.`,
      styleTilePrompt: `Create a style tile for a warm, approachable brand: ${snippet.slice(0, 100)}. Include color swatches (warm cream, terracotta, sage green), typography samples (rounded sans-serif), and UI element examples.`,
      copyExamples: {
        headline: "Welcome home",
        subheadline:
          "Simple tools that feel like they were made just for you.",
        cta: "Try it free",
      },
      usage: {
        rules: [
          "Use warm, earthy tones as the primary palette",
          "Apply rounded corners (8-12px radius) to all interactive elements",
          "Use a friendly, rounded heading role for headings",
          "Include generous padding and breathing room in layouts",
        ],
        antiRules: [
          "Avoid sharp corners and angular geometric shapes",
          "Never use cold blues or grays as primary colors",
          "Do not use all-caps text except for short labels",
        ],
      },
    },
    {
      id: "direction-c",
      name: "Minimal & Refined",
      summary: `A minimal, refined direction with restrained elegance and precise typography, inspired by: ${snippet.slice(0, 60)}`,
      positioning:
        "Position the brand as sophisticated, premium, and detail-oriented.",
      // Structured, hex/font-free evocative character (see direction-a).
      character: {
        mood: "Restrained, elegant, premium.",
        composition: "Sparse, precise, whitespace-led balance.",
        layout: "Strict vertical rhythm with ample whitespace.",
        rhythm: "Calm, deliberate pacing with subtle motion.",
      },
      homepageMockupPrompt: `Design a minimal, refined homepage mockup for a brand described as: ${snippet.slice(0, 100)}. Use restrained colors, elegant typography, and generous whitespace.`,
      styleTilePrompt: `Create a style tile for a minimal, refined brand: ${snippet.slice(0, 100)}. Include color swatches (off-white, charcoal, single muted accent), typography samples (modern serif headings, clean sans-serif body), and UI element examples.`,
      copyExamples: {
        headline: "Less, but better",
        subheadline:
          "Crafted with precision for those who appreciate the details.",
        cta: "Learn more",
      },
      usage: {
        rules: [
          "Limit the palette to a restrained set of neutrals plus one emphasis color",
          "Pair a refined heading role with a clean body role",
          "Maintain strict vertical rhythm with consistent line-height multiples",
          "Use whitespace as a primary design element",
        ],
        antiRules: [
          "Never use more than one emphasis color at a time",
          "Avoid busy patterns, textures, or decorative elements",
          "Do not use bold weights above 600 for body text",
        ],
      },
    },
  ];
  // ADD structured tokens (prose above is byte-identical to the original set).
  return templates.map((t, i) => ({ ...t, tokens: buildTemplateTokens(i) }));
}
