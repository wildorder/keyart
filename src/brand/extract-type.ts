import type { TypographyTokens } from "../types.js";
import type { BrandTypeRead } from "../openai.js";
import {
  DEFAULT_FONT_PAIRING,
  matchAttributesToPairing,
  matchKnownFamily,
  snapFontFamilies,
  type FontPairing,
} from "./fonts.js";

/**
 * Typography mapped from the vision read of a GENERATED style tile
 * (`describeImageBrand`, `src/openai.ts`) to the nearest loadable catalog
 * pairing. Match priority, most-trusted first:
 *   1. `printedFamilies` — font family NAMES transcribed from labels printed in
 *      the tile's typography panel; snapped to catalog when they resolve;
 *   2. structured `attributes` (+ advisory `suggestedFamily`) — scored against
 *      catalog metadata when no printed name resolves;
 *   3. the supplied fallback pairing.
 *
 * The returned families are ALWAYS real catalog names (never invented, SC-05),
 * and the read is ALWAYS `approximate` — rendered glyphs may not be faithful to
 * the named/estimated font (the Risk Register mandates this honesty label). Pure
 * & deterministic; the image is NEVER constrained to the result (SC-05).
 */
export interface MappedType {
  /** heading/body are REAL, loadable catalog families — never invented. */
  typography: TypographyTokens;
  /** Always true — an approximate read of the image, not exact font ID. */
  approximate: boolean;
}

/** Project a catalog pairing onto the {@link TypographyTokens} shape. */
function typographyFrom(pairing: FontPairing): TypographyTokens {
  return { heading: pairing.heading, body: pairing.body };
}

/**
 * Map a {@link BrandTypeRead} to catalog typography. See {@link MappedType} for
 * the match priority. Pure and deterministic; never throws. An absent/empty read
 * yields the fallback (default catalog) pairing, still labeled approximate.
 */
export function mapTypeRead(
  read: BrandTypeRead | undefined,
  opts: { fallback?: FontPairing } = {},
): MappedType {
  const fallback = opts.fallback ?? DEFAULT_FONT_PAIRING;

  // 1. Transcribed printed family names — the strongest intent signal. Trust
  //    them only when at least one resolves to a real catalog family; snap the
  //    pair (a partial match keeps the known side, defaults the other).
  const printed = read?.printedFamilies;
  if (
    printed &&
    (matchKnownFamily(printed.heading) || matchKnownFamily(printed.body))
  ) {
    return {
      typography: snapFontFamilies(printed.heading, printed.body),
      approximate: true,
    };
  }

  // 2. Structured letterform attributes + advisory family → nearest catalog.
  const attrs = read?.attributes;
  const suggested = read?.suggestedFamily;
  const hasAttrs = !!attrs && Object.values(attrs).some((v) => !!v);
  if (hasAttrs || suggested) {
    return {
      typography: typographyFrom(matchAttributesToPairing(attrs, suggested)),
      approximate: true,
    };
  }

  // 3. Nothing usable — the fallback pairing.
  return { typography: typographyFrom(fallback), approximate: true };
}
