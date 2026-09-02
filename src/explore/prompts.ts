import type { DirectionContent } from "../types.js";
import { FONT_PAIRINGS } from "../brand/fonts.js";

/** The `tokenIntent` schema block injected into both system prompts. */
const TOKEN_INTENT_SCHEMA = `  "tokenIntent": {   // color/type INTENT ONLY — Keyart derives the exact, accessible palette
    "baseHue": number,        // 0–360, the dominant hue family
    "scheme": string,         // one of: complementary, analogous, triadic, split-complementary, monochromatic, tetradic
    "fontPairingId": string,  // choose one id from the catalog listed below
    "radius": string,         // optional, e.g. "8px"
    "spacingUnit": string     // optional, e.g. "8px"
  },`;

/** Human-readable catalog of the curated font pairing ids the model may pick. */
const FONT_PAIRING_CATALOG = FONT_PAIRINGS.map(
  (p) => `  - ${p.id}: ${p.label} (${p.tags.join(", ")})`,
).join("\n");

/** Shared rules governing `tokenIntent` — identical for explore and refine. */
const TOKEN_INTENT_RULES = `- "tokenIntent" is REQUIRED per direction and carries color/type INTENT ONLY.
- Do NOT output raw color hex values or a palette array — only the base hue + scheme; Keyart derives the exact, accessible palette from them.
- Choose "fontPairingId" from this catalog (use the id exactly):
${FONT_PAIRING_CATALOG}`;

/**
 * Shared instruction that forces the generated style tile to PRINT the tokens as
 * legible labels. Keyart reads the palette + fonts back OFF the rendered tile
 * (a vision transcription — the inverted spine), so the tile MUST label each
 * swatch with its exact hex code and print the intended font family names.
 * Identical for explore and refine so the two routes never drift.
 */
const STYLE_TILE_LABELING_RULE = `- The "styleTilePrompt" MUST instruct the image to include, legibly: (a) a color-palette panel where every brand color is shown as a swatch with its EXACT hex code (e.g. #1A2B3C) printed as a text label beside it, and (b) a typography panel that prints the intended heading and body FONT FAMILY NAMES as text labels next to their specimens. These printed labels are read back to derive the brand tokens, so they must be present, accurate, and readable.`;

/**
 * Keeps color/type FACTS in the structured layer (tokenIntent → extracted
 * tokens) and OUT of the prose fields, so the human copy can never drift from
 * the extracted palette/fonts. The ONLY prose allowed to carry hex codes is the
 * image prompts (they instruct the image model). Identical for explore/refine.
 */
const PROSE_HYGIENE_RULE = `- "character" describes the look's CHARACTER only (mood/composition/layout/imagery/texture/rhythm). It MUST NOT contain hex color codes or font-family names — color and type are captured structurally (tokenIntent → tokens).
- "usage.rules"/"usage.antiRules" are imperative rules that reference ROLES (e.g. "use --brand-text for body copy", "the primary role only for CTAs"), NEVER raw hex codes or font-family names.
- Only the image prompts ("styleTilePrompt"/"homepageMockupPrompt") may contain hex codes and font names (they instruct the image generator).`;

export function buildExploreSystemPrompt(): string {
  return `You are a senior brand strategist and visual designer. Given a creative brief, you produce exactly 3 distinct visual directions for a digital product brand.

Return a JSON object with a single key "directions" whose value is an array of exactly 3 objects, each matching this schema:

{
  "id": string,        // kebab-case slug derived from the name, e.g. "bold-modern"
  "name": string,      // short human-readable name, 2-4 words
  "summary": string,   // 1-2 sentence overview of the direction
  "positioning": string, // how the brand should be positioned in the market
  "character": {          // the EVOCATIVE look ONLY — NO hex codes, NO font-family names (color/type live in tokenIntent)
    "mood": string,        // emotional tone
    "composition": string, // arrangement / balance
    "layout": string,      // grid / density / structure
    "imagery": string,     // illustration / photo / icon vibe
    "texture": string,     // surface qualities
    "rhythm": string       // pacing / repetition / motion
  },
  "homepageMockupPrompt": string, // a detailed prompt for generating a homepage mockup image
  "styleTilePrompt": string,     // a detailed prompt for generating a style tile image
  "copyExamples": {
    "headline": string,     // example headline copy
    "subheadline": string,  // example subheadline copy
    "cta": string           // example call-to-action button text
  },
  "usage": {              // IMPERATIVE rules referencing ROLES, never raw hexes/fonts
    "rules": string[],     // at least 3 do-this rules (layout, hierarchy, spacing, a11y, behavior)
    "antiRules": string[]  // at least 2 never-do-this rules
  },
${TOKEN_INTENT_SCHEMA}
}

Rules:
- Each direction must be clearly distinct in tone, color palette, and typography.
- usage.rules must have at least 3 items; usage.antiRules at least 2.
- Image prompts should be detailed enough for an AI image generator.
- Copy examples should reflect the direction's tone.
- IDs must be kebab-case slugs.
${TOKEN_INTENT_RULES}
${PROSE_HYGIENE_RULE}
${STYLE_TILE_LABELING_RULE}
- Non-negotiable global hard rules are absolute — every direction must obey them, overriding any direction memory or brief detail that conflicts.
- Reference images may be attached alongside the brief; when present, treat them as the user's moodboard, but never above the hard rules.
- Return ONLY the JSON object, no markdown fences or extra text.`;
}

export interface ExploreUserPromptOptions {
  contextBlock?: string;
  /** When true, reference images are attached to the request — instruct the model to let them drive the directions. */
  hasReferenceImages?: boolean;
  /** Number of directions to request. Defaults to 3 (output unchanged from the original). */
  count?: number;
  /**
   * One-shot steering for THIS generation only (the studio's "Guidance for this
   * run" box / the CLI `--instructions`). NOT persisted to direction memory —
   * highest priority after the non-negotiable global hard rules.
   */
  instructions?: string;
}

export function buildExploreUserPrompt(
  brief: string,
  opts?: ExploreUserPromptOptions,
): string {
  const contextBlock = opts?.contextBlock;
  const count = opts?.count ?? 3;
  const referencePart = opts?.hasReferenceImages
    ? `\n\nThe attached reference images are the user's moodboard — let them drive the palette, typography, texture, and overall mood; the directions should visibly reflect them. The non-negotiable global hard rules still override the references wherever they conflict.`
    : "";

  const instructions = opts?.instructions?.trim();
  const instructionsPart = instructions
    ? `\n\nONE-SHOT INSTRUCTIONS for THIS generation (apply directly; higher priority than the brief and direction memory, but still below the non-negotiable global hard rules):\n${instructions}`
    : "";

  const briefPart =
    `Here is the creative brief:\n\n${brief}\n\nGenerate ${count} distinct visual directions as specified.` +
    instructionsPart +
    referencePart;

  if (!contextBlock || contextBlock.trim().length === 0) {
    return briefPart;
  }

  return (
    `The following project context is AUTHORITATIVE. Obey the non-negotiable global hard rules above all else; treat direction memory as exploratory and subordinate to hard rules.\n\n` +
    `${contextBlock}\n\n` +
    briefPart
  );
}
