/**
 * Pure, JSX-free helpers behind the studio surface board (WS-08,
 * surface-manifest) — the single source of truth so `SurfaceBoard` stays a
 * dumb renderer over these decisions. Mirrors the `asset-shelf-helpers.ts`
 * idiom: `.js`-extension type imports, total, never throws, no mutation, no
 * `Date.now()`.
 */
import type { DashboardSurfaceSlot } from "./types.js";
import { formatDate } from "./format.js";

/** Board display group for a resolved status — gaps/pending first, then
 * derived, then bound (manifest order preserved within each group). */
function statusGroup(status: DashboardSurfaceSlot["status"]): 0 | 1 | 2 {
  switch (status) {
    case "gap":
    case "pending":
      return 0;
    case "derived":
      return 1;
    case "bound":
      return 2;
  }
}

/**
 * Orders slots for the board: gaps + pending first, then derived, then bound
 * — manifest (payload) order preserved within each group. Does not mutate
 * `slots`.
 */
export function orderSurfaceSlots(
  slots: DashboardSurfaceSlot[],
): DashboardSurfaceSlot[] {
  return slots
    .map((slot, index) => ({ slot, index }))
    .sort((a, b) => {
      const diff = statusGroup(a.slot.status) - statusGroup(b.slot.status);
      return diff !== 0 ? diff : a.index - b.index;
    })
    .map((entry) => entry.slot);
}

/**
 * The "requested N× — last by <author>, <date>" line for an `origin: "request"`
 * row. `null` for any other origin — never a fabricated request line.
 */
export function requestLine(slot: DashboardSurfaceSlot): string | null {
  if (slot.origin !== "request") return null;
  const base = `requested ${slot.attributionCount}×`;
  if (!slot.latestAttribution) return base;
  return `${base} — last by ${slot.latestAttribution.author}, ${formatDate(
    slot.latestAttribution.date,
  )}`;
}

/** The `.surface-board__chip--*` class for a resolved status. */
export function statusChipClass(status: DashboardSurfaceSlot["status"]): string {
  return `surface-board__chip surface-board__chip--${status}`;
}

/** The chip's display label — `pending` is spelled out honestly, since a
 * pending slot has no image yet. */
export function statusLabel(status: DashboardSurfaceSlot["status"]): string {
  switch (status) {
    case "bound":
      return "bound";
    case "derived":
      return "derived";
    case "gap":
      return "gap";
    case "pending":
      return "pending (no image yet)";
  }
}

/**
 * True iff this row earns a Generate control: an asset kind (icon/illustration)
 * with status `gap` — NOT `pending` (a pending slot already has a slotId-claimed
 * asset; the fill core rejects a claimed slot) and never a color/type-role
 * (those derive in bind, never fill).
 */
export function isGenerateTarget(slot: DashboardSurfaceSlot): boolean {
  return (
    (slot.kind === "icon" || slot.kind === "illustration") &&
    slot.status === "gap"
  );
}

/** The caption for a `pending` row (points at the Asset Shelf regenerate flow
 * — the correct verb for a claimed-but-imageless asset); `null` for any other
 * status. */
export function pendingHint(slot: DashboardSurfaceSlot): string | null {
  if (slot.status !== "pending") return null;
  return "asset created, image pending — regenerate it from the Asset Shelf";
}

/** Parses a comma-separated text field into a trimmed, non-empty string list.
 * Empty/whitespace input yields `undefined` (the field is omitted, not `[]`). */
export function parseListInput(raw: string): string[] | undefined {
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Parses a comma-separated text field into positive integer pixel sizes,
 * silently dropping non-numeric entries. Empty/whitespace/all-invalid input
 * yields `undefined` (the field is omitted, not `[]`). */
export function parseSizesInput(raw: string): number[] | undefined {
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
  return items.length > 0 ? items : undefined;
}

/** How many ACTIVE board slots came from a scan (WS-07, surface-scan-quality)
 * — the bulk-retire control's gate and its "(N)" label. Retired slots are
 * already excluded from the dashboard payload, so this is a plain origin
 * count. Does not mutate `slots`. */
export function scannedSlotCount(slots: DashboardSurfaceSlot[]): number {
  return slots.filter((s) => s.origin === "scan").length;
}
