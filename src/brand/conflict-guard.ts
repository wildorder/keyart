import type { GlobalRule } from "./schema.js";
import type { MemoryEntry } from "../direction/schema.js";

// ── Exported types ─────────────────────────────────────────────────────────────

/** The kind of contradiction detected — which two things clash. */
export type ContradictionKind =
  | "live-vs-hardrule"
  | "live-vs-memory"
  | "memory-vs-memory"
  | "live-vs-guideline";

/** Advisory severity — informational only; NEVER blocks generation. */
export type ContradictionSeverity = "warning" | "info";
export type ReconciliationAction = "keep" | "retire" | "supersede" | "promote";

/** Stable, structured pointer consumed by reconciliation (WS-05). */
export interface ContradictionRef {
  source: "live" | "memory" | "hard-rule" | "guideline";
  id: string;
  text: string;
}

/** A single advisory contradiction. Detection NEVER edits the compiled block. */
export interface Contradiction {
  /** Stable deterministic id derived from kind + both structured refs. */
  id: string;
  kind: ContradictionKind;
  subject: ContradictionRef;
  conflictsWith: ContradictionRef;
  severity: ContradictionSeverity;
  /** Human-readable why (deterministic template for floor; model prose for LLM). */
  explanation: string;
  /** Optional resolution hints (WS-05 turns these into actions). Advisory only. */
  suggestions: ReconciliationAction[];
}

/** Structured command warning; render `message` at CLI/MCP boundaries. */
export interface ContradictionWarning {
  code: "hard-rule-conflict" | "advisory-contradiction";
  severity: ContradictionSeverity;
  message: string;
  contradictionId: string;
}

/** The one result payload shared by commands, MCP summaries, serve jobs, and WS-05. */
export interface ContradictionReport {
  items: Contradiction[];
  warnings: ContradictionWarning[];
  detector: "deterministic" | "deterministic+semantic";
}

/** The detector's INPUT — derived from the already-scoped assembled context. */
export interface ContradictionInput {
  /** The live one-shot steer for THIS pass; empty string ⇒ no live instruction. */
  liveInstruction: string;
  /** Stable id for this ephemeral instruction; required even when text is empty. */
  liveInstructionId: string;
  hardRules: GlobalRule[];
  guidelines: GlobalRule[];
  /** ONE direction's memory (caller-scoped — the detector never reads a sibling). */
  memory: MemoryEntry[];
}

/** The injected adapter seam. The deterministic floor is built in; `semantic` is
 * the OPTIONAL key-gated LLM adapter. Tests pass a mock here. */
export interface ContradictionDeps {
  /** When present, awaited; if it throws, the port swallows and keeps the floor. */
  semantic?: (input: ContradictionInput) => Promise<Contradiction[]>;
}

// ── Normalization helpers (deterministic floor only) ──────────────────────────

// Stop-words dropped during token normalization (kept small and inline per spec).
const STOP_WORDS = new Set([
  "the", "a", "an", "of", "to", "and", "or", "with", "for",
  "in", "on", "is", "use", "used", "using",
]);

// Words indicating a prohibition or negation in a directive.
const NEGATION_MARKERS = new Set([
  "never", "no", "not", "avoid", "dont", "without", "ban", "forbid",
]);

// Words indicating a mandate or positive requirement in a directive.
const MANDATE_MARKERS = new Set(["always", "must", "only", "prefer"]);

function normalizeTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1)
    .map((w) => (w.endsWith("s") && w.length > 3 ? w.slice(0, -1) : w))
    .filter((w) => !STOP_WORDS.has(w));
}

function hasNegation(tokens: string[]): boolean {
  return tokens.some((t) => NEGATION_MARKERS.has(t));
}

function hasMandate(tokens: string[]): boolean {
  return tokens.some((t) => MANDATE_MARKERS.has(t));
}

function contentTokenSet(tokens: string[]): Set<string> {
  return new Set(
    tokens.filter((t) => !NEGATION_MARKERS.has(t) && !MANDATE_MARKERS.has(t)),
  );
}

function sharedCount(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const t of a) if (b.has(t)) count++;
  return count;
}

function mintId(
  kind: ContradictionKind,
  subjectId: string,
  conflictsWithId: string,
): string {
  return `${kind}::${subjectId}::${conflictsWithId}`;
}

/**
 * Detect if a live instruction semantically opposes a rule text via lexical overlap.
 * Conservative by design: only flags clear negation clashes (prohibition vs positive,
 * or mandate vs negation). Ambiguous cases are NOT flagged — the LLM adapter handles
 * those. This keeps the floor quiet and avoids false-positive warning fatigue.
 */
function detectsConflict(live: string, ruleText: string): boolean {
  if (!live.trim()) return false;
  const liveToks = normalizeTokens(live);
  const ruleToks = normalizeTokens(ruleText);
  const liveContent = contentTokenSet(liveToks);
  const ruleContent = contentTokenSet(ruleToks);
  if (sharedCount(liveContent, ruleContent) < 1) return false;
  const ruleHasNeg = hasNegation(ruleToks);
  const liveHasNeg = hasNegation(liveToks);
  const ruleHasMand = hasMandate(ruleToks);
  // Negation clash: rule is a prohibition, live instruction is a positive assertion.
  if (ruleHasNeg && !liveHasNeg) return true;
  // Conservative direct collision: rule mandates X, live instruction negates it.
  if (ruleHasMand && liveHasNeg) return true;
  return false;
}

function dedupeContradictions(contradictions: Contradiction[]): Contradiction[] {
  const seen = new Set<string>();
  const out: Contradiction[] = [];
  for (const c of contradictions) {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  }
  return out;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * The always-on deterministic floor: a pure, no-I/O overlap check of the live
 * instruction against global hard rules (live-vs-hardrule, severity warning) and
 * guidelines (live-vs-guideline, severity info). Memory-vs-memory and live-vs-memory
 * detection are the SEMANTIC adapter's job — the floor never attempts them (the floor
 * must be quiet on ambiguity; false positives are costly per the Risk Register).
 *
 * Never throws. Returns [] when nothing overlaps. Byte-stable given the same inputs
 * (SC-11): the same live instruction + rules always yield the same output.
 */
export function detectContradictionsDeterministic(
  input: ContradictionInput,
): Contradiction[] {
  if (!input.liveInstruction.trim()) return [];
  const out: Contradiction[] = [];
  const live = input.liveInstruction;
  const liveRef: ContradictionRef = {
    source: "live",
    id: input.liveInstructionId,
    text: live,
  };

  for (const rule of input.hardRules) {
    if (!detectsConflict(live, rule.text)) continue;
    const id = mintId("live-vs-hardrule", input.liveInstructionId, rule.id);
    out.push({
      id,
      kind: "live-vs-hardrule",
      subject: liveRef,
      conflictsWith: { source: "hard-rule", id: rule.id, text: rule.text },
      severity: "warning",
      explanation: `Live tweak "${live}" appears to contradict the hard rule "${rule.text}". The hard rule wins by precedence.`,
      suggestions: ["keep"],
    });
  }

  for (const guideline of input.guidelines) {
    if (!detectsConflict(live, guideline.text)) continue;
    const id = mintId("live-vs-guideline", input.liveInstructionId, guideline.id);
    out.push({
      id,
      kind: "live-vs-guideline",
      subject: liveRef,
      conflictsWith: { source: "guideline", id: guideline.id, text: guideline.text },
      severity: "info",
      explanation: `Live tweak "${live}" may conflict with the guideline "${guideline.text}".`,
      suggestions: ["keep"],
    });
  }

  return out;
}

/**
 * SC-08 helper: maps live-vs-hardrule contradictions to structured warnings.
 * The message states that the hard rule wins by precedence and the live input is
 * subordinate — it NEVER claims the live text was removed from the compiled prompt
 * (detection is advisory; the compiled block is byte-identical regardless).
 */
export function hardRuleGuardWarnings(
  contradictions: Contradiction[],
): ContradictionWarning[] {
  return contradictions
    .filter((c) => c.kind === "live-vs-hardrule")
    .map((c) => ({
      code: "hard-rule-conflict" as const,
      severity: "warning" as const,
      message: `[hard-rule-conflict] Live instruction contradicts global hard rule "${c.conflictsWith.text}". The rule wins by precedence — detection is advisory only; the compiled prompt is unchanged.`,
      contradictionId: c.id,
    }));
}

/**
 * The detection PORT. Composes the always-on deterministic floor with an optional
 * key-gated semantic adapter. Advisory only — never edits the compiled block or
 * token extraction. Never throws: a throwing semantic adapter degrades to the floor
 * result (SC-07). Degrades to the floor when no semantic adapter is supplied (SC-11).
 */
export async function detectContradictions(
  input: ContradictionInput,
  deps?: ContradictionDeps,
): Promise<ContradictionReport> {
  const floor = detectContradictionsDeterministic(input);
  if (!deps?.semantic) {
    return {
      items: floor,
      warnings: hardRuleGuardWarnings(floor),
      detector: "deterministic",
    };
  }
  let semantic: Contradiction[] = [];
  try {
    semantic = await deps.semantic(input);
  } catch {
    // Swallow: a failing semantic adapter degrades to the floor (SC-07).
    return {
      items: floor,
      warnings: hardRuleGuardWarnings(floor),
      detector: "deterministic",
    };
  }
  const items = dedupeContradictions([...floor, ...semantic]);
  return {
    items,
    warnings: hardRuleGuardWarnings(items),
    detector: "deterministic+semantic",
  };
}
