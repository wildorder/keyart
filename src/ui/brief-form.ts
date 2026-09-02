/**
 * Pure, DOM-free helpers backing the structured `BriefEditor` form (WS-05). Kept
 * out of the `.tsx` component so they are unit-testable in the node vitest
 * environment (no jsdom) and never pull React into a test. Every function is a
 * pure transform over the hand-kept `BrandBrief` mirror in `./types`.
 */
import type { Audience, BrandBrief, BrandBriefPatch } from "./types.js";

/**
 * Matches a `#rgb`/`#rrggbb` hex token — the SAME convention as the server's
 * brief mapper (`src/direction/brief-map.ts`). Used only to HINT that a soft-intent
 * field value looks like an exact color the user should lock instead of typing
 * into the brief (SC-06); the brief never stores a hex.
 */
export const BRIEF_HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/;

/** True when a scalar field value contains an exact hex color (a lock hint). */
export function hasHex(value: string | undefined): boolean {
  return typeof value === "string" && BRIEF_HEX_RE.test(value);
}

/** Split a comma-separated tag input into trimmed, non-empty strings. */
export function splitTags(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Render a `string[]` back into a comma-separated tag input value. */
export function joinTags(items: string[]): string {
  return items.join(", ");
}

/** A fully-defaulted empty brief — arrays present (`[]`), scalars absent. Seeds
 * the form when a direction has no brief yet, matching the schema's defaults. */
export function emptyBrief(): BrandBrief {
  return {
    aliases: [],
    neverCallIt: [],
    audiences: [],
    differentiateFrom: [],
    tone: [],
    values: [],
    inspirations: [],
    constraints: [],
    surfaces: [],
  };
}

/** Trim a scalar; `undefined`/all-whitespace collapses to `""` so a cleared field
 * is sent as an empty string (JSON drops `undefined`, so `""` is how a PATCH
 * clears a scalar via the server's shallow re-parse). */
function scalar(value: string | undefined): string {
  return (value ?? "").trim();
}

/** Keep only audiences with a non-empty `who`; trim `who`/`context`/`need` and
 * drop empty optional suffixes (mirrors the server-side `coerceAudiences`). */
export function cleanAudiences(audiences: Audience[]): Audience[] {
  const out: Audience[] = [];
  for (const a of audiences) {
    const who = (a.who ?? "").trim();
    if (who === "") continue;
    const context = (a.context ?? "").trim();
    const need = (a.need ?? "").trim();
    out.push({
      who,
      ...(context ? { context } : {}),
      ...(need ? { need } : {}),
    });
  }
  return out;
}

/**
 * Normalize the working form into the PATCH body sent to the field endpoint. The
 * WHOLE form is sent (every field): arrays are replaced wholesale (an empty array
 * clears), scalars are trimmed (an empty string clears). SC-06 belongs to the
 * server + the lock affordance — this does not strip hexes (the form HINTS; the
 * user routes a hex to a lock), so a scalar is passed through verbatim-but-trimmed.
 */
export function toPatch(form: BrandBrief): BrandBriefPatch {
  return {
    aliases: form.aliases,
    neverCallIt: form.neverCallIt,
    oneLiner: scalar(form.oneLiner),
    audiences: cleanAudiences(form.audiences),
    problem: scalar(form.problem),
    positioning: scalar(form.positioning),
    differentiateFrom: form.differentiateFrom,
    tone: form.tone,
    values: form.values,
    voice: scalar(form.voice),
    colorIntent: scalar(form.colorIntent),
    typeIntent: scalar(form.typeIntent),
    moodImagery: scalar(form.moodImagery),
    mascot: scalar(form.mascot),
    inspirations: form.inspirations,
    constraints: form.constraints,
    surfaces: form.surfaces,
    otherNotes: scalar(form.otherNotes),
  };
}

/** Deep value-equality of two briefs (normalized) — powers the dirty indicator.
 * Compares the normalized PATCH shape so cosmetic whitespace never reads dirty. */
export function briefEquals(a: BrandBrief, b: BrandBrief): boolean {
  return JSON.stringify(toPatch(a)) === JSON.stringify(toPatch(b));
}

/** A hex the mapper flagged for locking (mirrors `HexLockSuggestion`). */
export interface HexLockSuggestion {
  hex: string;
  note?: string;
}

/** The brief mapper's proposal returned by `POST /api/directions/:id/brief/map`
 * (mirrors `BriefMapProposal` in `src/direction/brief-map.ts`). */
export interface BriefMapProposal {
  patch: BrandBriefPatch;
  hexLocks: HexLockSuggestion[];
  dryRun: boolean;
  notes?: string;
}
