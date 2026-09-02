import type { GlobalBrand, GlobalRule, DirectiveChannel, DirectivePolarity } from "./schema.js";
import { classifyDirective, fromRule } from "./classify-directive.js";

/**
 * Structurally compatible with `direction/schema.ts`'s `MemoryEntry`. Declared
 * locally so this module compiles independently of `src/direction/`.
 */
export interface ContextMemoryEntry {
  kind: "feedback" | "learning" | "decision";
  body: string;
  author: string;
  source: string;
  date: string;
  /**
   * Set on discard entries (a stored thumbnail); its presence marks a feedback
   * entry as a negative (the direction's NEGATIVE art direction). Flows in with
   * no caller change because `DirectionCore.memoryEntries` returns
   * `MemoryEntry[]` (carrying `asset`) and callers pass it straight through as
   * `memory`.
   */
  asset?: string;
  /** Visual/copy channel override. Absent ⇒ classifier default. */
  channel?: DirectiveChannel;
  /** Prefer/avoid polarity override. Absent ⇒ classifier heuristic. */
  polarity?: DirectivePolarity;
  /** Retire marker — entry is skipped by the art-direction compiler. Never deleted. */
  supersededBy?: string;
  /** Retire marker — ISO timestamp. Entry is skipped when set. Never deleted. */
  retiredAt?: string;
}

/**
 * A direction image asset elevated into the assembled context. Path is
 * cwd-relative, forward-slash; note is the AssetRef note when present.
 *
 * Structurally identical to `DirectionImageRef` in `src/direction/core.ts`.
 * Declared here so the brand layer stays independent of `src/direction/` (and
 * vice-versa).
 */
export interface ReferenceItem {
  path: string;
  note?: string;
  /**
   * How the reference is used: `"inspire"` feeds the image model, `"extract"`
   * seeds/locks the palette engine. Optional so pre-existing callers still
   * compile; absent renders as `inspire`. Carried through untouched and
   * annotated into the context block so `context-snapshot.md` records provenance.
   */
  intent?: "inspire" | "extract";
}

/**
 * Maximum number of reference images elevated into the assembled context.
 * Bounds token/cost per the Risk Register ("Many/large reference images blow
 * token/cost budgets"). Exported so callers can reuse the same cap when
 * selecting which assets to send to the model. Callers should pass the most
 * relevant/most-recent assets first, since the cap keeps a stable prefix.
 */
export const MAX_CONTEXT_REFERENCES = 6;

/**
 * The direction + global VISUAL art direction, split into symmetric tiers and
 * ordered by precedence within each tier. The image-lane sibling of the
 * text-lane sections in `renderContextBlock`. Copy-only entries are EXCLUDED;
 * superseded/retired entries are SKIPPED. Always present (empty arrays when
 * none) so the compiler never needs a null guard.
 */
export interface VisualDirectives {
  /** Visual HARD rules — non-negotiable; render as MUST. Highest precedence. */
  must: string[];
  /** Positive visual directives (guidelines + decisions/learnings, polarity
   *  prefer) — render as PREFER (do). Ordered guidelines ▸ direction decisions. */
  prefer: string[];
  /** Lower-precedence negative visual directives (negative guidelines +
   *  discards + negative decisions) — render as AVOID. Hard prohibitions
   *  remain non-negotiable MUST instructions. */
  avoid: string[];
}

export interface AssembledContext {
  brief: string;
  /** Global hard rules — highest precedence; MUST be obeyed everywhere. */
  hardRules: GlobalRule[];
  /** Global guidelines — strong but overridable by direction specifics. */
  guidelines: GlobalRule[];
  /** This direction's memory entries (already resolved to ONE direction by the caller). */
  memory: ContextMemoryEntry[];
  /**
   * Reference images (moodboard) elevated from the direction's `AssetRef[]`.
   * Always present (empty array when none); capped at {@link MAX_CONTEXT_REFERENCES}.
   * Subordinate to hard rules and guidelines — inspiration, not a rule.
   */
  references: ReferenceItem[];
  /**
   * The direction's NEGATIVE art direction — the bodies of DISCARD feedback
   * entries (feedback entries carrying a stored `asset` thumbnail). Always
   * present (empty array when none). Rendered into an "AVOID (do not use)"
   * block in every generated image prompt. Computed by {@link selectNegatives}.
   */
  negatives: string[];
  /**
   * The image-lane sibling of the text-lane sections in `renderContextBlock`.
   * Computed inside `assembleContext` via `classifyDirective`; copy-only and
   * retired/superseded entries are excluded. Always present (empty arrays when
   * none). Consumed by `composeArtDirection` — never by `renderContextBlock`.
   */
  visualDirectives: VisualDirectives;
}

export interface AssembleContextInput {
  brief: string;
  global: GlobalBrand; // from BrandCore.read()
  /**
   * The memory entries to assemble — already resolved to exactly ONE direction
   * by the caller (`DirectionCore.memoryEntries(id)`). `assembleContext` is a
   * straight RESOLUTION, not a scope filter: whatever is passed here is what
   * assembles. There is no `directionId` field — scope is location, and the
   * caller already read the right `memory.yaml`.
   */
  memory: ContextMemoryEntry[];
  /**
   * Optional reference images for the direction. Optional so callers that pass
   * none still compile; defaults to `[]`. Truncated to
   * {@link MAX_CONTEXT_REFERENCES} (stable order — pass the most
   * relevant/most-recent first).
   */
  references?: ReferenceItem[];
}

/** Inline retired predicate (mirrors `isRetired` in direction/reconcile.ts; kept local to avoid a brand→direction import cycle). */
function isRetiredEntry(e: Pick<ContextMemoryEntry, "retiredAt" | "supersededBy">): boolean {
  return e.retiredAt !== undefined || e.supersededBy !== undefined;
}

/** Local retired-rule predicate (kept local to avoid a brand→direction import cycle; a rule has a single marker). */
function isRetiredRule(rule: { retiredAt?: string }): boolean {
  return typeof rule.retiredAt === "string" && rule.retiredAt.length > 0;
}

/**
 * The direction's NEGATIVE art direction — the bodies of DISCARD feedback
 * entries (feedback entries carrying a stored `asset` thumbnail). Rendered
 * into an "AVOID (do not use)" block in every generated image prompt. A
 * discard is structurally a feedback entry with an `asset`; plain feedback,
 * learnings, decisions, and color-lock decisions are excluded. Retired/superseded
 * entries are skipped so stale discards no longer reach the image model.
 * Order preserved.
 */
export function selectNegatives(entries: ContextMemoryEntry[]): string[] {
  return entries
    .filter(
      (e) =>
        e.kind === "feedback" &&
        typeof e.asset === "string" &&
        e.asset.length > 0 &&
        !isRetiredEntry(e),
    )
    .map((e) => e.body);
}

/** True when a ContextMemoryEntry is a discard (feedback + non-empty asset). */
function isDiscardEntry(e: ContextMemoryEntry): boolean {
  return e.kind === "feedback" && typeof e.asset === "string" && e.asset.length > 0;
}

/**
 * Pure helper: resolves the visual-directive tiers from the split global
 * rules + direction memory. Stable input order (no sort), superseded/retired
 * entries dropped first, copy-only excluded. Exported for unit tests.
 *
 * Precedence ladder:
 *   MUST ← all visual hard rules (polarity irrelevant — hard rules always MUST)
 *   PREFER ← visual guidelines (prefer) ▸ visual direction entries (prefer)
 *   AVOID ← visual guidelines (avoid) ▸ visual direction entries (avoid) ▸ discards
 */
export function selectVisualDirectives(input: {
  hardRules: GlobalRule[];
  guidelines: GlobalRule[];
  memory: ContextMemoryEntry[];
}): VisualDirectives {
  const must: string[] = [];
  const prefer: string[] = [];
  const avoid: string[] = [];
  const seenMust = new Set<string>();
  const seenPrefer = new Set<string>();
  const seenAvoid = new Set<string>();

  function dedupeAdd(tier: string[], seen: Set<string>, text: string): void {
    const key = text.trim().toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      tier.push(text);
    }
  }

  // MUST: all visual hard rules regardless of polarity
  for (const rule of input.hardRules) {
    const cls = classifyDirective(fromRule(rule));
    if (cls.channel === "copy") continue;
    dedupeAdd(must, seenMust, rule.text);
  }

  // PREFER: visual guidelines (prefer polarity) — input order
  for (const rule of input.guidelines) {
    const cls = classifyDirective(fromRule(rule));
    if (cls.channel === "copy") continue;
    if (cls.polarity === "prefer") {
      dedupeAdd(prefer, seenPrefer, rule.text);
    }
  }

  // PREFER: visual direction memory entries (prefer polarity, non-discard) — input order
  for (const entry of input.memory) {
    if (entry.supersededBy || entry.retiredAt) continue;
    if (isDiscardEntry(entry)) continue;
    const cls = classifyDirective({
      origin: "memory",
      text: entry.body,
      kind: entry.kind,
      channel: entry.channel,
      polarity: entry.polarity,
    });
    if (cls.channel === "copy") continue;
    if (cls.polarity === "prefer") {
      dedupeAdd(prefer, seenPrefer, entry.body);
    }
  }

  // AVOID: visual guidelines (avoid polarity) — input order
  for (const rule of input.guidelines) {
    const cls = classifyDirective(fromRule(rule));
    if (cls.channel === "copy") continue;
    if (cls.polarity === "avoid") {
      dedupeAdd(avoid, seenAvoid, rule.text);
    }
  }

  // AVOID: visual direction memory entries (avoid polarity, non-discard) — input order
  for (const entry of input.memory) {
    if (entry.supersededBy || entry.retiredAt) continue;
    if (isDiscardEntry(entry)) continue;
    const cls = classifyDirective({
      origin: "memory",
      text: entry.body,
      kind: entry.kind,
      channel: entry.channel,
      polarity: entry.polarity,
    });
    if (cls.channel === "copy") continue;
    if (cls.polarity === "avoid") {
      dedupeAdd(avoid, seenAvoid, entry.body);
    }
  }

  // AVOID: discards (always visual/avoid, lowest precedence in this tier) — input order
  for (const entry of input.memory) {
    if (entry.supersededBy || entry.retiredAt) continue;
    if (isDiscardEntry(entry)) {
      dedupeAdd(avoid, seenAvoid, entry.body);
    }
  }

  return { must, prefer, avoid };
}

/**
 * The precedence chokepoint. A PURE function (no I/O) that merges the brief +
 * a single direction's memory + the global layer, splitting global rules by
 * severity so global hard rules can be rendered as winning over everything
 * below them.
 *
 * It reads only its inputs — `memory` is already resolved to one direction by
 * the caller (whichever `memory.yaml` it read), so this can never accidentally
 * read a sibling direction's memory. There is no scope filter here anymore:
 * scope is location, so `assembleContext` is a straight resolution.
 */
export function assembleContext(
  input: AssembleContextInput,
): AssembledContext {
  const hardRules: GlobalRule[] = [];
  const guidelines: GlobalRule[] = [];
  for (const rule of input.global.rules) {
    if (isRetiredRule(rule)) continue; // retired rules never assemble
    if (rule.severity === "hard") {
      hardRules.push(rule);
    } else {
      guidelines.push(rule);
    }
  }

  const references = (input.references ?? []).slice(0, MAX_CONTEXT_REFERENCES);

  const visualDirectives = selectVisualDirectives({
    hardRules,
    guidelines,
    memory: input.memory,
  });

  return {
    brief: input.brief,
    hardRules,
    guidelines,
    memory: input.memory,
    references,
    // Discard-feedback bodies only; [] when none. Does not affect renderContextBlock.
    negatives: selectNegatives(input.memory),
    visualDirectives,
  };
}

/**
 * Renders the assembled context into a single deterministic markdown block for
 * model prompts AND for stamping into generated artifacts. Ordering encodes
 * precedence: hard rules first (non-negotiable), then guidelines, then
 * direction memory (exploratory), then reference images (moodboard
 * inspiration), then the brief. Direction feedback that contradicts a hard
 * rule is explicitly subordinate — the block states hard rules are absolute.
 * Reference images sit after memory and before the brief: inspiration the
 * brief contextualizes, subordinate to everything above. The section is
 * omitted entirely when there are no references, keeping output
 * byte-identical to pre-references callers.
 *
 * TEXT LANE — intentionally independent of `visualDirectives` (the image lane).
 * Adding or changing visual directives must not shift a single byte of this output.
 */
export function renderContextBlock(ctx: AssembledContext): string {
  const sections: string[] = [];

  if (ctx.hardRules.length > 0) {
    const lines = [
      "## Non-Negotiable Global Rules (HARD — always obey, override everything below)",
      ...ctx.hardRules.map((r) => `- ${r.text}`),
    ];
    sections.push(lines.join("\n"));
  }

  if (ctx.guidelines.length > 0) {
    const lines = [
      "## Global Guidelines (strong defaults)",
      ...ctx.guidelines.map((r) => `- ${r.text}`),
    ];
    sections.push(lines.join("\n"));
  }

  if (ctx.memory.length > 0) {
    const lines = [
      "## Direction Memory (exploratory — must yield to the hard rules above)",
      ...ctx.memory.map((e) => `- [${e.kind}] ${e.body}`),
    ];
    sections.push(lines.join("\n"));
  }

  if (ctx.references.length > 0) {
    const lines = [
      "## Reference Images (moodboard — visual inspiration; subordinate to the rules above)",
      ...ctx.references.map((ref) => {
        // Absent intent renders as inspire (resolved at read time). The intent
        // tag records how each reference was used — provenance.
        const intent = ref.intent ?? "inspire";
        const head = ref.note ? `- ${ref.path} — ${ref.note}` : `- ${ref.path}`;
        return `${head} [intent: ${intent}]`;
      }),
    ];
    sections.push(lines.join("\n"));
  }

  sections.push(["## Brief", ctx.brief].join("\n"));

  return sections.join("\n\n");
}
