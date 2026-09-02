import type { BrandVars } from "../approve/render-guides.js";
import { APPROXIMATE_FONT_NOTE } from "../approve/render-guides.js";
import { CommandError } from "../errors.js";

/**
 * `BrandVars → W3C DTCG design-tokens JSON` — the deterministic, keyless
 * designer handoff for a direction's tokens. Values MUST come through
 * `resolveBrandVars` — the SAME single source `brand.css` and the
 * deterministic style board project from — so every emitted color hex matches
 * `brand.css` byte-for-byte. This module takes an already-resolved
 * `BrandVars` (never `DirectionTokens`) precisely so it CANNOT re-derive or
 * transform a value: the caller resolves once, and CSS/board/DTCG are three
 * projections of one object. Assets are never a token source (the inverted
 * spine is untouched — this module only reads).
 */

/**
 * A stable-DTCG (2025.10) structured color `$value`: `hex` carries the
 * VERBATIM `BrandVars` hex (the byte-for-byte brand.css invariant attaches to
 * it), `components` are the channel/255 values at full JS number precision —
 * deterministic, same input, same bytes.
 */
export function hexToDtcgColor(hex: string): {
  colorSpace: "srgb";
  components: [number, number, number];
  alpha: 1;
  hex: string;
} {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return { colorSpace: "srgb", components: [r, g, b], alpha: 1, hex };
}

/**
 * A stable-DTCG structured dimension `$value`: parses `^(-?\d*\.?\d+)(px|rem)$`
 * — the only units a stable-DTCG dimension allows. Engine-emitted
 * `ShapeTokens` are px strings by construction; anything else throws
 * `CommandError` (fail loudly, the `resolveBrandVars` precedent) rather than
 * silently emitting a wrong value.
 */
export function cssLengthToDtcgDimension(
  css: string,
): { value: number; unit: "px" | "rem" } {
  const match = /^(-?\d*\.?\d+)(px|rem)$/.exec(css);
  if (!match) {
    throw new CommandError(
      `Unsupported CSS length for a DTCG dimension: "${css}" — expected a plain px or rem value (e.g. "8px", "0.5rem").`,
    );
  }
  return { value: Number(match[1]), unit: match[2] as "px" | "rem" };
}

/**
 * `BrandVars → W3C DTCG design-tokens object` (`$value`/`$type`). Structure
 * is built with fixed key insertion order (group order `color`, `typography`,
 * `shape`; role order `background, surface, text, muted, primary, secondary`;
 * brand primitives in `vars.brand` array order) so `JSON.stringify` is
 * deterministic. `opts.scale` threads `DirectionTokens.typography.scale` —
 * additive because the real `BrandVars` shape carries no scale field.
 */
export function renderDtcgTokens(
  vars: BrandVars,
  opts?: { scale?: number },
): Record<string, unknown> {
  const color: Record<string, unknown> = {
    background: { $type: "color", $value: hexToDtcgColor(vars.background) },
    surface: { $type: "color", $value: hexToDtcgColor(vars.surface) },
    text: { $type: "color", $value: hexToDtcgColor(vars.text) },
    muted: { $type: "color", $value: hexToDtcgColor(vars.textMuted) },
    primary: { $type: "color", $value: hexToDtcgColor(vars.primary) },
    secondary: { $type: "color", $value: hexToDtcgColor(vars.secondary) },
  };

  if (vars.brand.length > 0) {
    const brand: Record<string, unknown> = {};
    for (const b of vars.brand) {
      brand[b.name] = {
        $type: "color",
        $value: hexToDtcgColor(b.hex),
        ...(b.label !== undefined ? { $description: b.label } : {}),
      };
    }
    color.brand = brand;
  }

  const typography: Record<string, unknown> = {
    $description: APPROXIMATE_FONT_NOTE,
    heading: { $type: "fontFamily", $value: vars.fontHeadingFamily },
    body: { $type: "fontFamily", $value: vars.fontBodyFamily },
  };
  if (opts?.scale !== undefined) {
    typography.scale = { $type: "number", $value: opts.scale };
  }

  const shape: Record<string, unknown> = {
    radius: {
      $type: "dimension",
      $value: cssLengthToDtcgDimension(vars.radius),
    },
    spacingUnit: {
      $type: "dimension",
      $value: cssLengthToDtcgDimension(vars.spacingUnit),
    },
  };

  return { color, typography, shape };
}
