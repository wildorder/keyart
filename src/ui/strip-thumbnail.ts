import type { DashboardDirection } from "./types.js";

/**
 * Deterministic fallback chain for the direction strip thumbnail.
 * Returns styleTile → homepageMockup → null (no path → show PaletteStrip).
 */
export function stripThumbnailPath(direction: DashboardDirection): string | null {
  const head = direction.versions[direction.versions.length - 1];
  return head?.images?.styleTile ?? head?.images?.homepageMockup ?? null;
}
