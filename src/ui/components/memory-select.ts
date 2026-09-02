/**
 * Pure entry-selection logic for the MemoryPanel.
 * Extracted into a plain .ts module so tests can import it without JSX.
 */
import type { DashboardMemoryEntry } from "../types.js";

/**
 * Returns the `fields` fragment for element-feedback POSTs. Scope is location
 * now — the focused direction is always the target (no scope choice), and
 * `versionId` is preserved when provided (provenance-only, per WS-04 contract).
 */
export function elementFeedbackTargetFields(
  directionId: string,
  versionId?: string,
): Record<string, string> & { directionId: string } {
  return {
    directionId,
    ...(versionId ? { versionId } : {}),
  };
}

/**
 * Orders and slices the memory array for display.
 * Rail mode reverses to most-recent-first; full mode preserves original order.
 * Does not mutate the input array.
 */
export function selectMemoryEntries(
  memory: DashboardMemoryEntry[],
  variant: "full" | "rail",
  limit?: number,
): DashboardMemoryEntry[] {
  const ordered = variant === "rail" ? [...memory].reverse() : memory;
  return limit !== undefined ? ordered.slice(0, limit) : ordered;
}

/** Cap for the curated Key decisions list in the rail. */
export const DECISIONS_LIMIT = 5;

/**
 * Curated "Key decisions" for the rail: non-retired `decision` entries,
 * most-recent-first, capped at `limit` (default DECISIONS_LIMIT). Pure —
 * does not mutate the input array.
 */
export function selectDecisions(
  memory: DashboardMemoryEntry[],
  limit: number = DECISIONS_LIMIT,
): DashboardMemoryEntry[] {
  const decisions = memory.filter(
    (e) => e.kind === "decision" && !e.retiredAt,
  );
  return decisions.reverse().slice(0, limit);
}
