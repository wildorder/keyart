/**
 * Pure, JSX-free helpers the chat components consume: which confirm
 * affordance a pending tool call earns, how the studio's focus resolves +
 * renders as the composer's inherited-scope chip, and whether the rail
 * should render the keyless unavailable state. Single source of truth so
 * the components stay dumb. Mirrors `lifecycle-actions.ts`.
 */
import type { DashboardDirection, DashboardGlobal } from "./types.js";

export type PendingMutates = "write" | "destructive";
export type ConfirmAffordance = "light-confirm" | "heavy-confirm";

/**
 * Which confirm affordance a pending tool call earns — keyed SOLELY off the
 * `mutates` field the `pending_approval` event carries (WS-01 is the single
 * source of truth for classification; the UI never re-derives it from a
 * hardcoded leaf-name list, so there is no drift risk). A `none` leaf never
 * suspends, so it never reaches this function — the event union guarantees
 * `pending_approval.mutates` is `"write" | "destructive"`.
 */
export function affordanceFor(mutates: PendingMutates): ConfirmAffordance {
  return mutates === "destructive" ? "heavy-confirm" : "light-confirm";
}

/** The scope a context-free chat message binds to: the focused direction
 * (REQUIRED — the rail mounts only inside a focused DirectionWorkspace) and
 * the version the user is actually viewing. */
export interface InheritedScope {
  directionId: string;
  versionId: string | null;
  /** True when versionId came from the approved pointer (this direction is pinned). */
  pinned: boolean;
}

/** Strip a `version-` prefix when present; otherwise pass the versionId through unchanged. */
function shortVersion(versionId: string): string {
  return versionId.startsWith("version-") ? versionId.slice("version-".length) : versionId;
}

/**
 * Resolve the scope a context-free message binds to, from the studio focus.
 * versionId = the version the user is actually VIEWING in the switcher
 * (`focusedVersionId`), falling back to the focused direction's head when the
 * switcher hasn't been touched. `pinned` marks when that resolved version is
 * the approved-pointer one (a display hint only — it does NOT change which
 * version is inherited). A user reading a historical v2 inherits v2, not head v3.
 */
export function resolveInheritedScope(
  direction: DashboardDirection,
  focusedVersionId: string | null,
  pointer: DashboardGlobal["approvedPointer"],
): InheritedScope {
  const versionId = focusedVersionId ?? direction.head ?? null;
  const pinned =
    pointer !== null &&
    versionId !== null &&
    pointer.directionId === direction.id &&
    pointer.versionId === versionId;
  return { directionId: direction.id, versionId, pinned };
}

/**
 * The composer chip string, e.g. "↳ direction-b · v3" (or "↳ direction-b"
 * when no version resolves — a draft direction has no versions yet).
 */
export function renderScopeChip(scope: InheritedScope): string {
  const versionPart = scope.versionId ? ` · ${shortVersion(scope.versionId)}` : "";
  return `↳ ${scope.directionId}${versionPart}`;
}

/**
 * Whether the rail should render the keyless unavailable state. The keyless
 * response is a normal SSE stream carrying one `error` event with
 * `unavailable: true` (WS-03's uniform contract), so this reads that field.
 */
export function isChatUnavailable(
  ev: { type: "error"; unavailable?: boolean } | null | undefined,
): boolean {
  return ev?.type === "error" && ev.unavailable === true;
}
