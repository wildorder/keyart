/**
 * Client-side persistence for the ONE focused direction (WS-18: direction is
 * the aggregate root — there is no per-parent keying anymore).
 *
 * Mechanism: sessionStorage, one key. Scope: one browser tab's session. A page
 * reload within the same tab restores the last-focused direction. Opening a
 * new tab starts fresh (sessionStorage is tab-isolated by the browser).
 *
 * Fallback: if the persisted id is absent or no longer exists in the direction
 * list, callers fall back to the latest direction.
 *
 * No URL hash, no API route, no server-side state.
 */

const STORAGE_KEY = "keyart:selectedDirectionId";

export interface SelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * Read the persisted selectedDirectionId. Returns null when nothing is stored
 * or sessionStorage is unavailable.
 */
export function readSelectedDirection(
  storage: SelectionStorage = globalThis.sessionStorage,
): string | null {
  try {
    return storage.getItem(STORAGE_KEY);
  } catch {
    // sessionStorage unavailable (e.g. private-browsing restrictions).
    return null;
  }
}

/**
 * Persist the selectedDirectionId. Silently swallows storage errors (quota
 * exceeded, private-browsing restriction) — persistence is best-effort; the
 * studio falls back to the latest direction on next load.
 */
export function writeSelectedDirection(
  directionId: string,
  storage: SelectionStorage = globalThis.sessionStorage,
): void {
  try {
    storage.setItem(STORAGE_KEY, directionId);
  } catch {
    // Best-effort — do not crash the UI on storage failure.
  }
}

/** Clear the persisted selection so the next open starts from the latest. */
export function clearSelectedDirection(
  storage: SelectionStorage = globalThis.sessionStorage,
): void {
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort.
  }
}

/**
 * Given the current direction list, resolve the initial selectedDirectionId:
 * the persisted id if it still exists in the list, otherwise the latest
 * direction (last element in ascending order). Returns null when the list is
 * empty.
 *
 * Pure — no side effects; suitable for useState initializer.
 */
export function resolveInitialDirection(
  directionIds: string[],
  storage: SelectionStorage = globalThis.sessionStorage,
): string | null {
  const persisted = readSelectedDirection(storage);
  if (persisted !== null && directionIds.includes(persisted)) {
    return persisted;
  }
  return directionIds[directionIds.length - 1] ?? null;
}
