import { CommandError } from "../errors.js";
import { sanitizeBriefText } from "../direction/brief-map.js";
import {
  BrandBriefSchema,
  parseBrandBrief,
  type BrandBrief,
} from "../direction/schema.js";

/**
 * Divergent-brief proposal (SC-05): N DISTINCT BrandBriefs over a deterministic
 * keyless placeholder floor. PURE over the injected adapter — no fs, no key
 * read of its own. The floor mints honestly-labeled placeholder briefs; the
 * model tier only ENRICHES what the floor already produces. Brief hygiene is
 * enforced IN CODE (the WS-15 sanitizer), never requested in a prompt.
 */

/**
 * THE ONE CANONICALIZER (SC-05). Used by the compound-key pass, BOTH
 * field-level passes, and EVERY distinctness assertion: trim → collapse
 * internal whitespace to single spaces → case-fold. "Warm  Earthy" and
 * "warm earthy" are THE SAME intent.
 */
export function normalizeIntentValue(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

/** The compound distinctness key. The delimiter is EXACTLY ONE ASCII SPACE
 * (U+0020) — never NUL, never any other separator. */
function compoundKey(brief: BrandBrief): string {
  return `${normalizeIntentValue(brief.positioning ?? "")} ${normalizeIntentValue(brief.colorIntent ?? "")}`;
}

/** Flavor only — every distinctness guarantee is carried by the ordinal. */
const ADJECTIVES = [
  "warm & editorial",
  "bold & structural",
  "calm & minimal",
  "playful & rounded",
  "classic & trustworthy",
];

/** Flavor only — the unconditional `(option <i+1>)` suffix carries injectivity. */
const COLOR_INTENTS = [
  "warm earthy neutrals",
  "cool slate and ink",
  "soft paper and sage",
  "saturated citrus accents",
  "muted stone and clay",
];

/** Ordinal-embedded floor positioning: injective for every i at any count. */
function floorPositioning(i: number): string {
  return `Option ${i + 1} — ${ADJECTIVES[i % ADJECTIVES.length]}`;
}

/** Ordinal-embedded floor colorIntent: independently injective (Replan #7). */
function floorColorIntent(i: number): string {
  return `${COLOR_INTENTS[i % COLOR_INTENTS.length]} (option ${i + 1})`;
}

/**
 * The injected model seam. A keyed run that produced no usable proposal must
 * THROW rather than return []; the adapter never returns [].
 */
export type ProposeBriefsAdapter = (input: {
  seed: string;
  source?: { directionId: string; brief: BrandBrief };
  context: string;
  count: number;
}) => Promise<unknown>;

export interface ProposalResult {
  /** Exactly `count` briefs, pairwise-distinct in the compound key AND in each
   * field independently (under normalizeIntentValue). */
  briefs: BrandBrief[];
  /** true ⇒ NO adapter was present (pure keyless floor). false ⇒ keyed
   * (possibly degraded — see floorCount). One boolean never states two facts. */
  keyless: boolean;
  /** How many of `briefs` came from the floor (0..count). Keyless ⇒ count. */
  floorCount: number;
}

/**
 * Deterministic keyless placeholder brief for index `i`. The `reason` labels
 * the note honestly: "keyless" (no adapter at all) vs "model-short" (a
 * degraded keyed run padding a shortfall — NEVER the no-key note). When
 * `opts.source` is present, otherNotes additionally embeds the greppable
 * `Derived from <source.directionId>: <source positioning, truncated>` token
 * (the id travels WITH the brief — BrandBrief itself carries no id).
 */
export function floorBrief(
  seed: string,
  i: number,
  reason: "keyless" | "model-short",
  opts?: {
    short?: { returned: number; requested: number };
    source?: { directionId: string; brief: BrandBrief };
  },
): BrandBrief {
  const notes: string[] = [];
  if (reason === "keyless") {
    notes.push(`Placeholder brief (no OPENAI_API_KEY) derived from: ${seed}`);
  } else {
    const returned = opts?.short?.returned ?? 0;
    const requested = opts?.short?.requested ?? 0;
    notes.push(
      `Placeholder brief (model returned ${returned} of ${requested} proposals) derived from: ${seed}`,
    );
  }
  if (opts?.source) {
    const sourcePositioning = (opts.source.brief.positioning ?? "").slice(0, 80);
    notes.push(
      `Derived from ${opts.source.directionId}: ${sourcePositioning}`,
    );
  }
  return sanitizeBrief(
    parseBrandBrief({
      positioning: floorPositioning(i),
      colorIntent: floorColorIntent(i),
      otherNotes: notes.join(" "),
    }),
  );
}

/** The schema-derived whitelist — never restated by hand. */
const BRIEF_FIELD_NAMES: readonly string[] = Object.keys(
  BrandBriefSchema.removeDefault().shape,
);

/** Brief fields the schema types as a replacement `string[]`. */
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

function coerceStringArray(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : typeof value === "string"
      ? value.split(",")
      : [];
  return items.map((s) => s.trim()).filter(Boolean);
}

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
    out.push({ who, ...(context ? { context } : {}), ...(need ? { need } : {}) });
  }
  return out;
}

/**
 * Whitelist + sanitize one proposal (model OR floor) into a BrandBrief. Every
 * scalar-string and array-of-string soft field runs through the WS-15
 * `sanitizeBriefText` (hex strip + catalog-family strip + whitespace collapse);
 * unknown keys are dropped; empties are omitted. Returns null for a non-object.
 */
function sanitizeBriefRaw(raw: unknown): BrandBrief | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
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
      const arr = coerceStringArray(val).map(sanitizeBriefText).filter(Boolean);
      if (arr.length > 0) patch[key] = arr;
      continue;
    }
    if (typeof val === "string") {
      const clean = sanitizeBriefText(val);
      if (clean) patch[key] = clean;
    }
  }
  if (Object.keys(patch).length === 0) return null;
  return parseBrandBrief(patch);
}

/** Sanitize a brief that is already a BrandBrief (floor briefs included). */
function sanitizeBrief(brief: BrandBrief): BrandBrief {
  return sanitizeBriefRaw(brief) ?? parseBrandBrief({});
}

const NO_USABLE_PROPOSAL =
  "Divergent explore: the model returned no usable brief proposals. " +
  "A keyed run that produced nothing is a failure, not a keyless run — retry, or unset OPENAI_API_KEY for the deterministic placeholder floor.";

/**
 * Propose N distinct BrandBrief payloads. Absent adapter ⇒ keyless floor.
 * Present adapter: a THROWN adapter propagates (no floor fallback); null / a
 * non-array / no usable element THROWS (per-proposal honesty); 1..count-1
 * usable proposals ⇒ DEGRADED keyed run padded with `model-short` floor briefs;
 * >= count ⇒ the first count (floorCount 0). Then the THREE repair passes in
 * FIXED order: compound-key → colorIntent → positioning, every later pass
 * re-checking the compound key before accepting an edit.
 */
export async function proposeDivergentBriefs(opts: {
  seed: string;
  source?: { directionId: string; brief: BrandBrief };
  context: string;
  count: number;
  adapter?: ProposeBriefsAdapter;
}): Promise<ProposalResult> {
  const { seed, source, context, count, adapter } = opts;

  let briefs: BrandBrief[];
  let keyless: boolean;
  let floorCount: number;

  if (!adapter) {
    briefs = Array.from({ length: count }, (_, i) =>
      floorBrief(seed, i, "keyless", { source }),
    );
    keyless = true;
    floorCount = count;
  } else {
    const raw = await adapter({ seed, source, context, count }); // thrown propagates
    const usable = Array.isArray(raw)
      ? raw
          .map(sanitizeBriefRaw)
          .filter((b): b is BrandBrief => b !== null)
      : [];
    if (usable.length === 0) {
      throw new CommandError(NO_USABLE_PROPOSAL);
    }
    keyless = false;
    if (usable.length >= count) {
      briefs = usable.slice(0, count);
      floorCount = 0;
    } else {
      const short = { returned: usable.length, requested: count };
      briefs = [...usable];
      for (let i = usable.length; i < count; i += 1) {
        briefs.push(floorBrief(seed, i, "model-short", { short, source }));
      }
      floorCount = count - usable.length;
    }
  }

  repairDistinctness(briefs);
  return { briefs, keyless, floorCount };
}

/**
 * The three fixed-order repair passes over the final count-sized array.
 * Every seen-Set and comparison applies normalizeIntentValue — no raw-string
 * comparison anywhere.
 */
function repairDistinctness(briefs: BrandBrief[]): void {
  // Pass 1 — compound-key repair (C-2): on a collision at index i, take the
  // floor's positioning AND colorIntent starting at j = i, advancing until the
  // key is free. Terminates because floor keys are injective.
  const seenKeys = new Set<string>();
  for (let i = 0; i < briefs.length; i += 1) {
    if (!seenKeys.has(compoundKey(briefs[i]))) {
      seenKeys.add(compoundKey(briefs[i]));
      continue;
    }
    for (let j = i; ; j += 1) {
      const candidate: BrandBrief = {
        ...briefs[i],
        positioning: floorPositioning(j),
        colorIntent: floorColorIntent(j),
      };
      if (!seenKeys.has(compoundKey(candidate))) {
        briefs[i] = candidate;
        seenKeys.add(compoundKey(candidate));
        break;
      }
    }
  }

  const keyUniqueWith = (index: number, candidate: BrandBrief): boolean =>
    briefs.every(
      (other, k) => k === index || compoundKey(other) !== compoundKey(candidate),
    );

  // Pass 2 — colorIntent pass (Replan #9): catches two MODEL proposals sharing
  // an aesthetic-intent phrase while differing in positioning (invisible to
  // the compound key). The edit touches only colorIntent, and the compound key
  // is re-checked before it is accepted.
  const seenColor = new Set<string>();
  for (let i = 0; i < briefs.length; i += 1) {
    const norm = normalizeIntentValue(briefs[i].colorIntent ?? "");
    if (!seenColor.has(norm)) {
      seenColor.add(norm);
      continue;
    }
    for (let j = i; ; j += 1) {
      const value = floorColorIntent(j);
      const valueNorm = normalizeIntentValue(value);
      if (seenColor.has(valueNorm)) continue;
      const candidate: BrandBrief = { ...briefs[i], colorIntent: value };
      if (!keyUniqueWith(i, candidate)) continue;
      briefs[i] = candidate;
      seenColor.add(valueNorm);
      break;
    }
  }

  // Pass 3 — positioning pass (Replan #13, the mirror image): identical
  // positioning with distinct colorIntent collides on neither the compound key
  // nor the colorIntent set. The edit touches only positioning, preserving
  // pass 2's colorIntent injectivity by construction; the compound key is
  // re-checked before the edit is accepted.
  const seenPositioning = new Set<string>();
  for (let i = 0; i < briefs.length; i += 1) {
    const norm = normalizeIntentValue(briefs[i].positioning ?? "");
    if (!seenPositioning.has(norm)) {
      seenPositioning.add(norm);
      continue;
    }
    for (let j = i; ; j += 1) {
      const value = floorPositioning(j);
      const valueNorm = normalizeIntentValue(value);
      if (seenPositioning.has(valueNorm)) continue;
      const candidate: BrandBrief = { ...briefs[i], positioning: value };
      if (!keyUniqueWith(i, candidate)) continue;
      briefs[i] = candidate;
      seenPositioning.add(valueNorm);
      break;
    }
  }
}
