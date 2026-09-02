import type { ReferenceIntent } from "../direction/schema.js";
import type { ReferenceTokenAnalysis } from "../openai.js";
import type { PaletteLock } from "../brand/palette.js";

/**
 * Pure routing helpers for WS-05 references. Given a resolved reference list
 * (direction + run-level, intents already defaulted by the caller), split them by
 * intent and map an `extract` vision read into palette-engine locks. No I/O and
 * no network — unit-testable without a key.
 */

/** A reference resolved by the caller — path is absolute (or cwd-rel), intent concrete. */
export interface RunReference {
  path: string;
  intent: ReferenceIntent;
  note?: string;
}

/**
 * Split resolved references into `inspire` (fed to the reference-capable image
 * model, as today) vs `extract` (vision-analyzed to seed the palette engine).
 * Order within each bucket is preserved. An absent/unknown intent is impossible
 * here — the caller resolves the default to `"inspire"` before calling — but a
 * non-`extract` value is treated as inspire defensively.
 */
export function splitByIntent(refs: RunReference[]): {
  inspire: RunReference[];
  extract: RunReference[];
} {
  const inspire: RunReference[] = [];
  const extract: RunReference[] = [];
  for (const ref of refs) {
    if (ref.intent === "extract") {
      extract.push(ref);
    } else {
      inspire.push(ref);
    }
  }
  return { inspire, extract };
}

/** Matches a full `#rgb` or `#rrggbb` hex color (whole-string). */
const HEX_RE = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;

/**
 * Cap on how many extract-derived locks we honor — a small seed set, mirroring
 * the context-lock cap so an extract read cannot overwhelm the palette. These
 * are SEEDS the generation may refine (Risk Register), not hard rules; global
 * hard-rule locks still take precedence in the engine's ordering.
 */
const MAX_EXTRACT_LOCKS = 4;

/**
 * Map a {@link ReferenceTokenAnalysis} into unroled {@link PaletteLock}s — one
 * per valid, deduped dominant color (case-insensitive), capped small. Invalid or
 * empty input yields `[]`. The engine anchors on these hexes and builds
 * complements around them (SC-13) while remaining free to refine.
 */
export function analysisToLocks(analysis: ReferenceTokenAnalysis): PaletteLock[] {
  const seen = new Set<string>();
  const locks: PaletteLock[] = [];
  for (const raw of analysis.dominantColors ?? []) {
    if (typeof raw !== "string") continue;
    const hex = raw.trim().toLowerCase();
    if (!HEX_RE.test(hex) || seen.has(hex)) continue;
    seen.add(hex);
    locks.push({ hex });
    if (locks.length >= MAX_EXTRACT_LOCKS) break;
  }
  return locks;
}
