/**
 * Pure, DOM-free coordinate + pixel math for the studio crop / eyedropper
 * overlay ({@link ../components/ElementFeedback}). Every export takes plain
 * numbers / typed arrays and NEVER throws, so it is unit-testable in vitest
 * (node env) without JSX, a `<canvas>`, or a real image — and correct across
 * CSS-scaled / retina images where the rendered box differs from the intrinsic
 * pixel grid (the Risk-Register "coordinate drift" mitigation lives here).
 */

/** A rectangle in NATURAL image pixels (also reused for CSS-px selections). */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The measurements needed to map a rendered selection back to source pixels. */
export interface DisplayMetrics {
  /** The rendered `<img>` box, in CSS px (`getBoundingClientRect`). */
  clientWidth: number;
  clientHeight: number;
  /** The intrinsic image dimensions, in device pixels (`naturalWidth/Height`). */
  naturalWidth: number;
  naturalHeight: number;
}

/**
 * Map a selection rect (in CSS px, relative to the rendered image box) to a
 * crop rect in NATURAL image pixels, clamped to the image bounds.
 *
 * The selection is scaled by `natural/client` on each axis and rounded to whole
 * pixels. The result is guaranteed to be a valid, in-bounds rect: the origin is
 * clamped into the image, the size is at least 1×1 (so a bare click still yields
 * a pixel for the eyedropper), and `x + width ≤ naturalWidth` /
 * `y + height ≤ naturalHeight`. Never emits a negative or out-of-bounds value;
 * never throws (a degenerate zero-size display box falls back to 1:1).
 */
export function toNaturalCrop(sel: CropRect, m: DisplayMetrics): CropRect {
  // Guard against a zero/negative display box (avoid div-by-zero → NaN/Infinity).
  const scaleX = m.clientWidth > 0 ? m.naturalWidth / m.clientWidth : 1;
  const scaleY = m.clientHeight > 0 ? m.naturalHeight / m.clientHeight : 1;

  const maxW = Math.max(0, Math.floor(m.naturalWidth));
  const maxH = Math.max(0, Math.floor(m.naturalHeight));

  // Scale into natural-pixel space, rounding to whole pixels.
  let x = Math.round(sel.x * scaleX);
  let y = Math.round(sel.y * scaleY);
  let width = Math.round(sel.width * scaleX);
  let height = Math.round(sel.height * scaleY);

  // Clamp the origin so at least one pixel of crop fits inside the image; a
  // negative origin snaps to 0.
  x = Math.min(Math.max(0, x), Math.max(0, maxW - 1));
  y = Math.min(Math.max(0, y), Math.max(0, maxH - 1));

  // A click / zero-area selection still yields a 1×1 pixel, and the crop never
  // spills past the far edge.
  width = Math.max(1, Math.min(Math.max(1, width), maxW - x));
  height = Math.max(1, Math.min(Math.max(1, height), maxH - y));

  return { x, y, width, height };
}

/** Format a 0..255 channel as a two-digit, lower-case hex byte. */
function toHexByte(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, "0");
}

/**
 * Read the RGBA bytes at `(x, y)` from a row-major `ImageData` buffer of the
 * given `width` and format the RGB channels as a lower-case `#rrggbb` string
 * (alpha is ignored). Out-of-range indices read as `0`, so the output is always
 * a valid 7-character hex color; never throws.
 */
export function pixelToHex(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
): string {
  const i = (y * width + x) * 4;
  const r = data[i] ?? 0;
  const g = data[i + 1] ?? 0;
  const b = data[i + 2] ?? 0;
  return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
}
