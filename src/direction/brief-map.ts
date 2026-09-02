import { stripCatalogFamilies } from "../brand/fonts.js";
import { chatJson } from "../openai.js";
import {
  BrandBriefSchema,
  type BrandBrief,
  type BrandBriefPatch,
} from "./schema.js";

/**
 * The OPTIONAL internal LLM mapper — the ONE brief verb that can use the model.
 * It turns a user's meandering, natural-language ramble into a **proposed**
 * structured brief patch: the LLM proposes; the user disposes. This module is
 * PURE orchestration over `chatJson` — it never reads/writes the filesystem and
 * never mutates anything. With no key (dry-run) it returns an EMPTY field patch,
 * so manual editing (`direction brief set/patch`) remains fully sufficient and
 * keyless.
 *
 * The one law it enforces: color/type in the brief are SOFT INTENT words
 * ("warm, earthy") — exact hexes belong in memory locks + extracted tokens, never
 * in brief prose. Any exact hex in the freeform is surfaced as a lock suggestion
 * (routed to `recordColorLock` on apply), NEVER written as a brief field, and the
 * returned patch is sanitized so no brief field value carries a bare hex.
 */

/** Matches `#rgb` and `#rrggbb` hex color tokens — the SAME convention as
 * `deriveLocksFromContext` (`src/explore/token-intent.ts`) so a "hex" means the
 * same thing everywhere. Kept as a module-local const (token-intent's is not
 * exported) rather than depending on that module. */
const HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

/**
 * The canonical whitelist of brief field names, derived from the schema so it can
 * never drift from {@link BrandBriefSchema}. Derived locally (a `const` here)
 * rather than importing `BRAND_BRIEF_FIELDS` from `src/commands/direction.ts`
 * so correctness never depends on that module having landed — and to avoid a
 * circular import (that module imports this one).
 */
const BRIEF_FIELD_NAMES: readonly string[] = Object.keys(
  BrandBriefSchema.removeDefault().shape,
);

/** Brief fields the schema types as a REPLACEMENT `string[]` (see schema.ts). */
const ARRAY_STRING_FIELDS: ReadonlySet<string> = new Set([
  "aliases",
  "neverCallIt",
  "differentiateFrom",
  "tone",
  "values",
  "inspirations",
  "constraints",
  "surfaces",
]);

/** A hex found in the freeform input, surfaced as a "lock this?" suggestion —
 * routed to recordColorLock on apply, NEVER written as a brief field. */
export interface HexLockSuggestion {
  hex: string;
  note?: string;
}

/** The mapper's PROPOSAL. Never applied automatically. */
export interface BriefMapProposal {
  patch: BrandBriefPatch; // proposed field changes (soft intent only)
  hexLocks: HexLockSuggestion[]; // exact hexes → lock suggestions (not brief fields)
  dryRun: boolean; // true ⇒ empty field patch (no key)
  notes?: string; // optional model rationale, for display only
}

/**
 * Deterministic hex scan — happens OUTSIDE (and regardless of) the model. This
 * guarantees exact hexes are steered to locks by the deterministic layer, not
 * trusted to the LLM, even if the model misbehaves. Deduped case-insensitively
 * (normalized to lower-case, matching `deriveLocksFromContext`), first-seen
 * order preserved.
 */
function extractHexLocks(freeform: string): HexLockSuggestion[] {
  const seen = new Set<string>();
  const out: HexLockSuggestion[] = [];
  for (const match of freeform.matchAll(HEX_RE)) {
    const hex = match[0].toLowerCase();
    if (seen.has(hex)) continue;
    seen.add(hex);
    out.push({ hex });
  }
  return out;
}

/**
 * Strip any hex token from a string field value and collapse whitespace. A
 * model that returns `colorIntent: "#ff5722 warm"` yields `"warm"`; the hex
 * reaches memory via the deterministic lock scan, never the brief field. (We
 * DROP the hex from the string rather than reject the field.)
 */
function stripHexes(value: string): string {
  return value.replace(HEX_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * The single keyless brief-text sanitizer: strip hexes, strip catalog font
 * families (a specific family is as much brief poison as a hex — the brief
 * carries soft intent words only), collapse whitespace, trim. Every soft brief
 * field write routes through this — buildPatch here, `direction new
 * --describe`, and WS-16's divergent-brief proposals all consume it verbatim.
 */
export function sanitizeBriefText(value: string): string {
  return stripCatalogFamilies(stripHexes(value)).replace(/\s+/g, " ").trim();
}

/** Coerce a model value into a clean `string[]`: an array of strings (trimmed,
 * empties dropped), or a comma-split string, else empty. */
function coerceStringArray(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : typeof value === "string"
      ? value.split(",")
      : [];
  return items.map((s) => s.trim()).filter(Boolean);
}

/** Coerce a model value into the structured `audiences` array — objects with a
 * non-empty string `who` (context/need kept only when string). */
function coerceAudiences(
  value: unknown,
): { who: string; context?: string; need?: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { who: string; context?: string; need?: string }[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const who = typeof rec.who === "string" ? rec.who.trim() : "";
    if (!who) continue;
    const context =
      typeof rec.context === "string" && rec.context.trim()
        ? rec.context.trim()
        : undefined;
    const need =
      typeof rec.need === "string" && rec.need.trim()
        ? rec.need.trim()
        : undefined;
    out.push({
      who,
      ...(context ? { context } : {}),
      ...(need ? { need } : {}),
    });
  }
  return out;
}

/**
 * Whitelist + sanitize the model's returned object into a `BrandBriefPatch`.
 * ONLY known field names survive (an unknown key like `"colour"` is dropped);
 * scalar/array string values are hex-sanitized; empty results are omitted so the
 * patch stays a minimal diff. An optional `notes` rationale is lifted out for
 * display only (never a brief field).
 */
function buildPatch(raw: unknown): { patch: BrandBriefPatch; notes?: string } {
  if (!raw || typeof raw !== "object") return { patch: {} };
  const rec = raw as Record<string, unknown>;
  const patch: Record<string, unknown> = {};

  for (const key of BRIEF_FIELD_NAMES) {
    if (!(key in rec)) continue;
    const val = rec[key];

    if (key === "audiences") {
      const audiences = coerceAudiences(val);
      if (audiences.length > 0) patch[key] = audiences;
      continue;
    }
    if (ARRAY_STRING_FIELDS.has(key)) {
      const arr = coerceStringArray(val)
        .map(sanitizeBriefText)
        .filter(Boolean);
      if (arr.length > 0) patch[key] = arr;
      continue;
    }
    // Everything else in the whitelist is a scalar string field (soft intent).
    if (typeof val === "string") {
      const clean = sanitizeBriefText(val);
      if (clean) patch[key] = clean;
    }
  }

  const notes =
    typeof rec.notes === "string" && rec.notes.trim()
      ? rec.notes.trim()
      : undefined;
  return { patch: patch as BrandBriefPatch, notes };
}

const SYSTEM_PROMPT = [
  "You map a user's freeform brand talk into a structured brand-brief PATCH (a diff over the current brief).",
  `Return ONLY a JSON object whose keys are a subset of these brief fields: ${BRIEF_FIELD_NAMES.join(", ")}.`,
  "Rules:",
  "- Propose ONLY fields the freeform text adds or changes; OMIT everything else. This is a diff, not a wholesale rewrite.",
  "- colorIntent and typeIntent are SOFT INTENT WORDS ONLY (e.g. \"warm, earthy\" / \"geometric sans, high contrast\") — NEVER hex codes and NEVER specific font family names. Exact colors are handled elsewhere.",
  "- Route anything that does not fit a specific field into otherNotes (\"route, don't constrain\").",
  "- Array fields (aliases, neverCallIt, differentiateFrom, tone, values, inspirations, constraints, surfaces) must be arrays of short strings. audiences is an array of { who, context?, need? } objects.",
  "- Do NOT invent facts the user did not state.",
  "- You may include an optional top-level \"notes\" string with a one-line rationale (display only; it is not a brief field).",
].join("\n");

function buildUserPrompt(current: BrandBrief, freeform: string): string {
  return [
    "CURRENT BRIEF (JSON — propose only additions/changes as a diff over this):",
    JSON.stringify(current),
    "",
    "FREEFORM BRAND TALK to map into brief fields:",
    freeform,
  ].join("\n");
}

/**
 * Propose a structured brief patch from freeform text + the current brief. PURE:
 * reads its inputs and calls `chatJson` (the ONLY model entry point) — no `fs`,
 * no writes, never mutates. NEVER throws.
 *
 * - Deterministic hex scan ALWAYS runs (even keyless), so a pasted hex is flagged
 *   for locking regardless of the model.
 * - No key / dry-run ⇒ `{ patch: {}, hexLocks, dryRun: true }` (empty FIELD patch;
 *   hexLocks still populated).
 * - Keyed ⇒ whitelist + hex-sanitize the model's object into `patch`, `dryRun: false`.
 */
export async function proposeBriefPatch(opts: {
  model: string;
  freeform: string;
  current: BrandBrief;
}): Promise<BriefMapProposal> {
  const hexLocks = extractHexLocks(opts.freeform);

  let result: { data: unknown; dryRun: boolean };
  try {
    result = await chatJson<unknown>({
      model: opts.model,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(opts.current, opts.freeform),
    });
  } catch {
    // A failed/malformed model read must never abort — degrade to an empty field
    // patch while keeping the deterministic hex-lock suggestions.
    return { patch: {}, hexLocks, dryRun: false };
  }

  if (result.dryRun || result.data == null) {
    return { patch: {}, hexLocks, dryRun: result.dryRun };
  }

  const { patch, notes } = buildPatch(result.data);
  return notes
    ? { patch, hexLocks, dryRun: false, notes }
    : { patch, hexLocks, dryRun: false };
}
