/**
 * Pure, DOM-free state math for the gallery STAGE — the mode toggle that lives
 * on the stage header (select / crop / eyedropper) and the marquee geometry a
 * drag produces. Kept free of React and the DOM so it is unit-testable in
 * vitest (node env) without JSX, a `<canvas>`, or a real image.
 *
 * Division of labour: this module owns MODE and DRAG geometry in CSS px;
 * mapping a selection into natural image pixels stays in `./crop-math`.
 */
import type { CropRect } from "./crop-math.js";

/**
 * What a gesture on the stage means. `select` is the default, non-destructive
 * mode — the staged image behaves like a plain gallery image (click opens the
 * lightbox). `crop` and `eyedropper` are the capture modes, and they suppress
 * the lightbox so a drag is never stolen by a navigation click.
 */
export type StageMode = "select" | "crop" | "eyedropper";

/** A pending capture — either a cropped PNG or an eyedropper hex, never both. */
export type Capture =
  | { kind: "crop"; blob: Blob; previewUrl: string; size: CropRect }
  | { kind: "color"; hex: string };

/** The stage modes in the order their buttons render on the stage header. */
export const STAGE_MODES: readonly StageMode[] = ["select", "crop", "eyedropper"];

/** The short label on a mode's toggle button. */
export function stageModeLabel(mode: StageMode): string {
  switch (mode) {
    case "crop":
      return "Crop";
    case "eyedropper":
      return "Eyedrop";
    default:
      return "Select";
  }
}

/** The one-line instruction shown for the active mode. */
export function stageHint(mode: StageMode): string {
  switch (mode) {
    case "crop":
      return "Drag a box on the image — the crop lands in the chat composer.";
    case "eyedropper":
      return "Click a pixel to pick its exact color.";
    default:
      return "Click the image to view it full screen.";
  }
}

/**
 * True when the mode captures from the image. Callers use this to suppress the
 * lightbox affordance, since in a capture mode a pointer-down starts a gesture
 * rather than opening the viewer.
 */
export function isCaptureMode(mode: StageMode): boolean {
  return mode === "crop" || mode === "eyedropper";
}

/**
 * The marquee rect between a drag's anchor and the pointer's current position,
 * normalized so width/height are never negative — dragging up and/or left
 * produces the same rect as dragging down and right. Coordinates are CSS px
 * relative to the rendered image box.
 */
export function normalizeDrag(
  start: { x: number; y: number },
  current: { x: number; y: number },
): CropRect {
  return {
    x: Math.min(start.x, current.x),
    y: Math.min(start.y, current.y),
    width: Math.abs(current.x - start.x),
    height: Math.abs(current.y - start.y),
  };
}

/** Minimum CSS-px extent required on BOTH axes for a drag to count as a crop. */
export const MIN_DRAG_PX = 4;

/**
 * True when a marquee is a deliberate drag rather than a stray click. Guards the
 * rasterize path so a bare click in crop mode never produces a degenerate crop.
 */
export function isRealDrag(sel: CropRect | null, min: number = MIN_DRAG_PX): boolean {
  if (!sel) return false;
  return sel.width >= min && sel.height >= min;
}

/**
 * Format a rect's size for the marquee badge and the composer's crop chip, e.g.
 * `212×168`. Fractional CSS-px extents are rounded to whole pixels.
 */
export function formatCropSize(rect: CropRect): string {
  return `${Math.round(rect.width)}×${Math.round(rect.height)}`;
}

/**
 * Decode a `data:` URL (as produced by `canvas.toDataURL`) into a Blob.
 *
 * The stage encodes a crop with the SYNCHRONOUS `toDataURL` rather than the
 * async `toBlob`: Chromium schedules `toBlob`'s encode off the main thread and
 * was observed taking several seconds to call back, so a finished drag looked
 * like nothing happened. A crop is small, so encoding it inline costs only
 * milliseconds and the capture lands the moment the pointer is released.
 * Returns null for anything that is not a base64 data URL.
 */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: match[1] });
}
