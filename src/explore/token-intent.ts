import type {
  DirectionContent,
  DirectionTokens,
  HarmonyScheme,
  ShapeTokens,
  TypographyTokens,
} from "../types.js";
import {
  generatePalette,
  type PaletteLock,
} from "../brand/palette.js";
import {
  resolveFontPairing,
  snapToKnownScheme,
  matchDescriptionToPairing,
  DEFAULT_FONT_PAIRING,
} from "../brand/fonts.js";

/**
 * Pure token plumbing shared by `generate-directions.ts` (stamping tokens onto
 * generated directions) and `write-direction-version.ts` (composing the
 * image-prompt lock).
 * ALL non-network token logic lives here so the two routes share ONE
 * implementation and it is unit-testable without a key/network.
 *
 * The model is asked for INTENT only (a base hue + harmony scheme + a catalog
 * font pairing id) — never a raw palette. `normalizeIntent` snaps any malformed
 * intent onto safe values, and `buildTokens` runs WS-01's deterministic engine
 * to expand that intent into a complete, accessible `DirectionTokens`.
 */

/** The raw color/type intent shape the model is asked to return per direction. */
export interface RawTokenIntent {
  baseHue?: number;
  scheme?: string;
  fontPairingId?: string;
  radius?: string;
  spacingUnit?: string;
  scale?: number;
}

/** Default base hue used when intent is absent/malformed (a stable, calm blue). */
const DEFAULT_BASE_HUE = 220;
/** Default shape metrics when intent omits them (matches the CSS-var defaults). */
const DEFAULT_RADIUS = "8px";
const DEFAULT_SPACING_UNIT = "8px";
/** Cap on how many context-derived locks we honor (keep the palette free-ish). */
const MAX_CONTEXT_LOCKS = 4;

/** Coerce an arbitrary value to a hue wrapped into [0, 360); default on NaN. */
function coerceHue(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BASE_HUE;
  return ((n % 360) + 360) % 360;
}

/** Coerce a value to a non-empty CSS length string, else the provided default. */
function coerceLength(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return fallback;
}

/** Coerce a value to a positive finite scale ratio, else undefined. */
function coerceScale(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Normalize a possibly-malformed raw intent into engine-ready inputs. Snaps an
 * unknown scheme to the nearest `HarmonyScheme`, an off-catalog/absent font
 * pairing to the default catalog pairing, and clamps/wraps the hue. NEVER throws
 * — garbage in yields safe, deterministic defaults out.
 */
export function normalizeIntent(raw: unknown): {
  baseHue: number;
  scheme: HarmonyScheme;
  typography: TypographyTokens;
  shape: ShapeTokens;
} {
  const intent: RawTokenIntent =
    raw && typeof raw === "object" ? (raw as RawTokenIntent) : {};

  const baseHue = coerceHue(intent.baseHue);
  const scheme = snapToKnownScheme(intent.scheme);
  const pairing = resolveFontPairing(intent.fontPairingId);
  const scale = coerceScale(intent.scale);
  const typography: TypographyTokens = {
    heading: pairing.heading,
    body: pairing.body,
    ...(scale !== undefined ? { scale } : {}),
  };
  const shape: ShapeTokens = {
    radius: coerceLength(intent.radius, DEFAULT_RADIUS),
    spacingUnit: coerceLength(intent.spacingUnit, DEFAULT_SPACING_UNIT),
  };

  return { baseHue, scheme, typography, shape };
}

/**
 * Ordered color-word → base-hue map for {@link briefIntentToSeed}. First matching
 * keyword wins so a multi-word intent ("warm earthy") is deterministic. Values
 * are OKLCH-space hue degrees the palette engine anchors on. WORDS ONLY — this
 * table never sees a hex (a hex in the brief is WS-03's memory-lock concern).
 */
const COLOR_WORD_HUES: [RegExp, number][] = [
  [/\b(warm|earthy|earth|terracotta|rust|cozy|amber|sand|clay|autumn)\b/, 40],
  [/\b(cool|calm|serene|icy|cold|breezy|aqua|ocean|sky|glacial)\b/, 220],
  [/\b(fresh|natural|organic|eco|botanical|verdant|forest|leafy|mint|sage)\b/, 140],
  [/\b(bold|energetic|vibrant|passionate|fiery|hot|intense|electric)\b/, 8],
  [/\b(regal|luxurious|luxe|creative|mysterious|opulent|royal|moody)\b/, 290],
  [/\b(sunny|cheerful|optimistic|playful|golden|bright)\b/, 55],
  [/\b(soft|pastel|gentle|delicate|dreamy|rosy|blush)\b/, 340],
];

/** Optional harmony-scheme cues in the color words (still just a soft bias). */
const COLOR_WORD_SCHEMES: [RegExp, string][] = [
  [/\b(monochrom\w*|tonal|minimal|muted|understated|restrained)\b/, "monochromatic"],
  [/\b(vibrant|striking|dynamic|contrasty)\b/, "complementary"],
];

/**
 * Bias engine intent from the brief's SOFT color/type words — never a lock,
 * never a hex/font spec. Deterministic; empty/absent ⇒ no bias.
 *
 * Maps the brief's `colorIntent` words to a base hue (+ an optional harmony
 * scheme) and the `typeIntent` words to a real CATALOG font pairing id (via the
 * shared {@link matchDescriptionToPairing} scorer, so no family is invented).
 * The result is fed to generation as engine-intent DEFAULTS — the model's own
 * per-direction intent and any explicit locks (extract refs / memory
 * color-locks) still WIN (soft = lowest precedence).
 *
 * CRITICAL hygiene: this NEVER parses a hex out of the intent string into a lock
 * or a color value — it only maps words to a hue/scheme/pairing. A hex sitting in
 * the brief text is routed to a memory color-lock by WS-03, not leaked here.
 */
export function briefIntentToSeed(opts: {
  colorIntent?: string;
  typeIntent?: string;
}): { baseHue?: number; scheme?: string; fontPairingId?: string } {
  const seed: { baseHue?: number; scheme?: string; fontPairingId?: string } = {};

  const color = (opts.colorIntent ?? "").toLowerCase();
  if (color.trim().length > 0) {
    for (const [re, hue] of COLOR_WORD_HUES) {
      if (re.test(color)) {
        seed.baseHue = hue;
        break;
      }
    }
    for (const [re, scheme] of COLOR_WORD_SCHEMES) {
      if (re.test(color)) {
        seed.scheme = scheme;
        break;
      }
    }
  }

  const type = (opts.typeIntent ?? "").trim();
  if (type.length > 0) {
    const pairing = matchDescriptionToPairing(type);
    // matchDescriptionToPairing falls back to DEFAULT on no signal; only treat a
    // genuine, non-default match as a bias so an unmatched type word doesn't
    // force the default pairing (which normalizeIntent already yields anyway).
    if (pairing !== DEFAULT_FONT_PAIRING) seed.fontPairingId = pairing.id;
  }

  return seed;
}

/** Matches `#rgb` and `#rrggbb` hex color tokens. */
const HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

/**
 * Extract locked hexes from an assembled context block. The brief's colors and
 * the global HARD rules are rendered into that block by `assemble-context`, so
 * any explicit hex there acts as a palette lock (SC-13) without a new plumbing
 * path — hard rules already win via the context block. Deduped
 * (case-insensitive), capped, returned as unroled locks the engine anchors on.
 */
export function deriveLocksFromContext(contextBlock?: string): PaletteLock[] {
  if (!contextBlock) return [];
  const seen = new Set<string>();
  const locks: PaletteLock[] = [];
  for (const match of contextBlock.matchAll(HEX_RE)) {
    const hex = match[0].toLowerCase();
    if (seen.has(hex)) continue;
    seen.add(hex);
    locks.push({ hex });
    if (locks.length >= MAX_CONTEXT_LOCKS) break;
  }
  return locks;
}

/**
 * Build a complete `DirectionTokens` by running WS-01's palette engine with the
 * normalized intent + a per-direction seed + locks + prior-run palettes as
 * anti-examples. The engine owns ALL color math; this only assembles its output
 * with the resolved typography/shape. Deterministic given the same inputs.
 */
export function buildTokens(opts: {
  raw: unknown;
  seed: number;
  locks?: PaletteLock[];
  priorPalettes?: string[][];
}): DirectionTokens {
  const { baseHue, scheme, typography, shape } = normalizeIntent(opts.raw);
  const { palette, provenance } = generatePalette({
    baseHue,
    scheme,
    seed: opts.seed,
    locks: opts.locks,
    antiExamples: opts.priorPalettes,
  });
  return { palette, typography, shape, provenance };
}

/** Deep-copy a token set so an inheriting direction never shares/mutates arrays. */
export function cloneTokens(tokens: DirectionTokens): DirectionTokens {
  return {
    palette: tokens.palette.map((t) => ({ ...t })),
    brand: tokens.brand ? tokens.brand.map((b) => ({ ...b })) : undefined,
    typography: { ...tokens.typography },
    shape: { ...tokens.shape },
    provenance: tokens.provenance
      ? { ...tokens.provenance, extracted: [...tokens.provenance.extracted] }
      : undefined,
  };
}

/**
 * Compose SOFT image-prompt guidance from the user's LOCKED colors only.
 * Unlike the retired `composePaletteLock`, it does NOT forbid other colors and
 * carries NO fonts — the image model renders type + the unlocked palette
 * freely; tokens are EXTRACTED from the result afterward (SC-03/SC-04). This is
 * the inversion of the token spine: guidance flows into the image only for the
 * few colors the user pinned; everything else is read back from the pixels.
 *
 * Returns `null` when there are no locked colors (byte-identical output for the
 * unlocked case, preserving dry-run/back-compat parity). Hexes are trimmed and
 * deduped case-insensitively, preserving first-seen order. Pure + deterministic.
 */
export function composeLockedColorsGuidance(
  lockedColors: string[],
): string | null {
  const seen = new Set<string>();
  const hexes: string[] = [];
  for (const raw of lockedColors) {
    const hex = raw.trim();
    if (hex.length === 0) continue;
    const key = hex.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hexes.push(hex);
  }
  if (hexes.length === 0) return null;
  return (
    `COLOR GUIDANCE (soft): build the palette around these locked colors — ` +
    `${hexes.join(", ")}. Choose the rest of the colors and all typography ` +
    `freely to suit the brief.`
  );
}

/**
 * Compose the authoritative "CONTENT LOCK" from a direction's current editable
 * fields (name, summary, positioning, character, usage rules/anti-rules, and
 * the headline/subheadline/CTA copy). Appended to an image prompt so the
 * generated imagery reflects the direction's CURRENT definition and overrides
 * any stale name/description/copy baked into the frozen `styleTilePrompt` /
 * `homepageMockupPrompt` prose — the direct sibling of the soft
 * {@link composeLockedColorsGuidance} for content instead of color. Purely
 * derived, so editing any of these
 * fields (via the studio's Edit form) and re-running re-projects it.
 *
 * Every field is required on a {@link DirectionContent}, so this always returns a
 * block (unlike the negatives block, which is nullable). Deterministic — no I/O.
 */
export function composeContentLock(direction: DirectionContent): string {
  const { headline, subheadline, cta } = direction.copyExamples;
  // Project the structured `character` into ONE descriptive sentence — hex/
  // font-free by construction (color/type live in `tokens`), the successor of
  // the retired freeform `visualStyle` prose. Empty character ⇒ omit the line.
  const character = [
    direction.character.mood,
    direction.character.composition,
    direction.character.layout,
    direction.character.imagery,
    direction.character.texture,
    direction.character.rhythm,
  ]
    .filter(Boolean)
    .join(" ");
  const rules = direction.usage.rules.map((r) => `- ${r}`).join("\n");
  const antis = direction.usage.antiRules.map((r) => `- ${r}`).join("\n");

  // `usage` arrays are always present but may be empty (SC-09) — guard each
  // join so an empty-field direction still yields a valid, non-throwing block.
  const lines: string[] = [
    `CONTENT LOCK — this direction's current definition is authoritative; override any conflicting name, description, or copy in the prompt above.`,
    `Direction: ${direction.name} — ${direction.summary}`,
    `Positioning: ${direction.positioning}`,
  ];
  if (character) lines.push(`Character: ${character}`);
  if (rules) lines.push(`Design rules:\n${rules}`);
  if (antis) lines.push(`Never:\n${antis}`);
  lines.push(
    `On-screen text MUST read EXACTLY (show no other headline, subheadline, or CTA wording):`,
    `- Headline: "${headline}"`,
    `- Subheadline: "${subheadline}"`,
    `- CTA button: "${cta}"`,
  );
  return lines.join("\n");
}

/**
 * Compose the image-prompt "AVOID" block from a concept's NEGATIVE art
 * direction (the bodies of discard-feedback entries, via WS-01
 * `selectNegatives`). Returns an imperative "AVOID (do not use):" bullet list
 * so every generated image prompt is steered away from what the user discarded
 * (SC-06) — words only; a discard thumbnail is NEVER passed as a reference
 * image (SC-05).
 *
 * Returns `null` for an empty/whitespace-only list — mirroring the `lock`
 * pattern in `write-direction-version.ts` so every caller can conditionally append it and
 * keep byte-identical output when the concept has no negatives (back-compat /
 * dry-run parity). Pure and deterministic — no I/O, no network.
 */
export function composeNegativesBlock(negatives: string[]): string | null {
  const items = negatives.map((n) => n.trim()).filter((n) => n.length > 0);
  if (items.length === 0) return null;
  return ["AVOID (do not use):", ...items.map((n) => `- ${n}`)].join("\n");
}
