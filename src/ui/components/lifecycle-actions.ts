/**
 * Pure, JSX-free lifecycle-affordance helpers for the studio's per-signal
 * Edit/Promote/Delete menu and the global-rule Edit/Remove controls. Single
 * source of truth for which controls a row offers, so `MemoryEntryActions` /
 * `GlobalRulesView` stay dumb renderers over these decisions. Mirrors the
 * `memory-select.ts` convention: pure, `.js`-extension import, no mutation.
 */
import type { DashboardMemoryEntry, DashboardRule } from "../types.js";

/** The up-ladder promote rungs. Scope is location now, so the ladder has ONE
 * rung: a direction entry may only be lifted straight to global. */
const PROMOTE_RUNG_ORDER: Record<"global", number> = {
  global: 0,
};

export interface EntryLifecycleActions {
  canEdit: boolean;
  canDelete: boolean;
  /** Ordered lowest-rung-first; [] ⇒ no promote control. */
  promoteScopes: "global"[];
}

/**
 * Which lifecycle controls to offer for a memory entry, from its affordances.
 * A retired entry (retiredAt or supersededBy set) offers NOTHING — it is
 * history, not active. Absent affordances default: canEdit/canDelete = true
 * for a live entry; promoteScopes = entry.promotableTo ?? [] (global-only).
 */
export function lifecycleActionsFor(
  entry: DashboardMemoryEntry,
): EntryLifecycleActions {
  if (entry.retiredAt || entry.supersededBy) {
    return { canEdit: false, canDelete: false, promoteScopes: [] };
  }
  const promoteScopes = [...(entry.promotableTo ?? [])].sort(
    (a, b) => PROMOTE_RUNG_ORDER[a] - PROMOTE_RUNG_ORDER[b],
  );
  return {
    canEdit: entry.editable ?? true,
    canDelete: entry.deletable ?? true,
    promoteScopes,
  };
}

export interface RuleLifecycleActions {
  canRemove: boolean;
  canEdit: boolean;
  /** True for a HARD rule — its remove/edit must be force-gated in the UI. */
  forceRequired: boolean;
}

/** Which lifecycle controls to offer for a global rule, from its affordances. */
export function ruleLifecycleActionsFor(
  rule: DashboardRule,
): RuleLifecycleActions {
  return {
    canRemove: rule.removable ?? true,
    canEdit: rule.editable ?? true,
    forceRequired: rule.severity === "hard",
  };
}

/** True when a memory entry is retired/superseded (read-only history). */
export function isRetiredEntry(entry: DashboardMemoryEntry): boolean {
  return entry.retiredAt !== undefined || entry.supersededBy !== undefined;
}

/** The active (non-retired) subset of a memory array. Does not mutate the input. */
export function selectActiveMemoryEntries(
  memory: DashboardMemoryEntry[],
): DashboardMemoryEntry[] {
  return memory.filter((e) => !isRetiredEntry(e));
}

/** The retired/superseded subset of a memory array. Does not mutate the input. */
export function selectRetiredMemoryEntries(
  memory: DashboardMemoryEntry[],
): DashboardMemoryEntry[] {
  return memory.filter(isRetiredEntry);
}
