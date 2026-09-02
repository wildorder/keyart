/** Small display formatters shared across UI components. */
import type { DashboardDirection } from "./types.js";

/** A locale date string, or the raw value when it isn't a parseable date. */
export function formatDate(s: string): string {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString();
}

/**
 * Returns an opaque artifact handle suitable for `/api/asset?path=`, or `null`.
 *
 * Deterministic fallback order (only head versions are considered):
 *   1. Head styleTile.
 *   2. Head homepageMockup.
 *   3. First moodboard asset with kind === "image".
 *   4. null — caller renders the initial placeholder; no <img> is mounted.
 *
 * Non-image asset kinds (feedback / inspire / extract) are never returned.
 */
export function representativeImage(
  direction: DashboardDirection,
): string | null {
  const head = direction.versions[direction.versions.length - 1];
  if (head?.images?.styleTile) return head.images.styleTile;
  if (head?.images?.homepageMockup) return head.images.homepageMockup;

  const imageAsset = direction.assets?.find(
    (a) => a.kind === "image" && a.path,
  );
  if (imageAsset) return imageAsset.path;

  return null;
}

/**
 * Returns the raw ISO string of the most recent activity on the direction, or
 * null.
 *
 * Derived "updated" value: collects every version createdAt and every memory
 * date, filters to valid timestamps (malformed values are skipped), and
 * returns the one with the greatest epoch-millis. Comparison is numeric, not
 * lexicographic, so ISO strings with differing offsets or precisions sort
 * correctly.
 *
 * Returns null when the direction has no versions and no memory entries.
 */
export function lastUpdated(direction: DashboardDirection): string | null {
  const candidates: string[] = [];

  for (const ver of direction.versions) {
    candidates.push(ver.createdAt);
  }
  for (const mem of direction.memory) {
    candidates.push(mem.date);
  }

  let bestMs = -Infinity;
  let bestRaw: string | null = null;

  for (const raw of candidates) {
    const ms = new Date(raw).getTime();
    if (Number.isNaN(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      bestRaw = raw;
    }
  }

  return bestRaw;
}
