import type { DirectiveChannel, DirectivePolarity, GlobalRule } from "./schema.js";
import type { MemoryEntry } from "../direction/schema.js";

/** The resolved, always-concrete classification of a directive. */
export interface EffectiveClassification {
  channel: DirectiveChannel;
  polarity: DirectivePolarity;
}

/**
 * The minimal shape classifyDirective needs. A GlobalRule and a MemoryEntry both
 * satisfy it via the `origin` discriminator + optional structural metadata.
 */
export type ClassifiableDirective =
  | { origin: "rule"; text: string; severity: "hard" | "guideline"; channel?: DirectiveChannel; polarity?: DirectivePolarity }
  | { origin: "memory"; text: string; kind: MemoryEntry["kind"]; channel?: DirectiveChannel; polarity?: DirectivePolarity };

export function fromRule(rule: GlobalRule): ClassifiableDirective {
  return { origin: "rule", text: rule.text, severity: rule.severity, channel: rule.channel, polarity: rule.polarity };
}

export function fromMemoryEntry(entry: MemoryEntry): ClassifiableDirective {
  return { origin: "memory", text: entry.body, kind: entry.kind, channel: entry.channel, polarity: entry.polarity };
}

/**
 * Leading words that flip an unlabeled directive to `polarity: "avoid"`. Matched
 * ONLY at the START of the (trimmed, lower-cased) text — a mid-sentence "no" does
 * not flip polarity. Includes the apostrophe + apostrophe-less "dont".
 */
export const AVOID_LEADING_WORDS = ["never", "no", "avoid", "don't", "dont", "not"] as const;

/**
 * Resolve a directive's EFFECTIVE { channel, polarity }. PURE + deterministic.
 *
 * Precedence:
 *  1. STRUCTURAL metadata wins: if `channel`/`polarity` is set on the record, use it.
 *  2. HEURISTIC fallback for the absent field(s):
 *     - polarity: leading never/no/avoid/don't/dont/not (word-boundary at start of
 *       trimmed, lower-cased text) ⇒ "avoid"; otherwise ⇒ "prefer".
 *     - channel: a `rule` (hard OR guideline) OR a `decision` memory entry ⇒
 *       "visual"; a `learning` or `feedback` memory entry ⇒ "copy".
 * The two fields resolve INDEPENDENTLY — a structural `channel` with an absent
 * `polarity` keeps the structural channel and heuristics only the polarity.
 */
export function classifyDirective(input: ClassifiableDirective): EffectiveClassification {
  return {
    channel: input.channel ?? defaultChannel(input),
    polarity: input.polarity ?? heuristicPolarity(input.text),
  };
}

function defaultChannel(input: ClassifiableDirective): DirectiveChannel {
  if (input.origin === "rule") return "visual";
  return input.kind === "decision" ? "visual" : "copy";
}

function heuristicPolarity(text: string): DirectivePolarity {
  const first = text.trim().toLowerCase().match(/^[a-z']+/)?.[0] ?? "";
  return (AVOID_LEADING_WORDS as readonly string[]).includes(first) ? "avoid" : "prefer";
}

/** True iff the entry carries the non-destructive retire marker (retiredAt set). */
export function isRetired(entry: Pick<MemoryEntry, "retiredAt">): boolean {
  return typeof entry.retiredAt === "string" && entry.retiredAt.length > 0;
}
