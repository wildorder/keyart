/**
 * Pure, JSX-free helpers behind the studio scan triage checklist (WS-09,
 * surface-manifest; extended by WS-07 surface-scan-quality with the skip
 * summary / migration findings / overlay warning formatters) — the single
 * source of truth so `ScanTriage` stays a dumb renderer over these decisions.
 * Mirrors the `surface-board-helpers.ts` idiom: `.js`-extension type imports,
 * total, never throws, no mutation, no `Date.now()`.
 */
import type {
  MigrationFinding,
  ScanCandidate,
  ScanHints,
  ScanProposal,
  ScanSkipGroup,
  SkipReason,
} from "./types.js";

/** True when the proposal carries WS-06 refinement (a `refinedAt` stamp) —
 * the keyless-banner switch. */
export function proposalIsRefined(proposal: ScanProposal): boolean {
  return proposal.refinedAt !== undefined;
}

export interface RefinedFieldBadges {
  id: boolean;
  kind: boolean;
  description: boolean;
}

/** Per-field refined-vs-floor badges — display of WS-06's `refined?`
 * provenance (what the vision model claimed vs what the DOM walk observed).
 * An absent `refined` reads as floor on every field. */
export function refinedFieldBadges(candidate: ScanCandidate): RefinedFieldBadges {
  return {
    id: candidate.refined?.proposedId === true,
    kind: candidate.refined?.kind === true,
    description: candidate.refined?.description === true,
  };
}

/** The honest description shown on a candidate row — a set description
 * passes through verbatim; an unset one reads as the floor placeholder,
 * never a fabricated name/description. */
export function candidateDescription(candidate: ScanCandidate): string {
  return candidate.description ?? "no description (floor scan)";
}

export interface PartitionResult {
  acceptedIds: string[];
  rejectedCount: number;
}

/**
 * Splits `candidates` into accepted (checked) signatures + a rejected count —
 * the total-triage semantics the apply route mirrors (unchecked = reject).
 * `acceptedIds` preserves candidate order; does not mutate `candidates`.
 */
export function partitionAccepted(
  candidates: ScanCandidate[],
  checkedSignatures: Set<string>,
): PartitionResult {
  const acceptedIds: string[] = [];
  let rejectedCount = 0;
  for (const c of candidates) {
    if (checkedSignatures.has(c.signature)) {
      acceptedIds.push(c.signature);
    } else {
      rejectedCount += 1;
    }
  }
  return { acceptedIds, rejectedCount };
}

/** The URL's `host:port` (e.g. `"http://localhost:3000/menu"` ⇒
 * `"localhost:3000"`); falls back to the raw input when unparseable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// WS-07 (surface-scan-quality) — skip summary / migration findings / overlay
// warning formatters. All additive, total, never throw, no mutation, no clock.
// ---------------------------------------------------------------------------

/** Example sources/URLs kept per rendered row — the no-silent-caps boundary
 * (an overflow is always stated in the rendered text, never dropped quietly). */
export const SKIP_EXAMPLE_CAP = 3;

const SKIP_REASON_LABELS: Record<SkipReason, string> = {
  "repeated-content": "dynamic content",
  "foreign-origin": "remote-origin content",
  "ignored-selector": "ignored by scan.ignore",
};

export interface SkipRow {
  reason: SkipReason;
  /** Human label: "dynamic content" | "remote-origin content" | "ignored by scan.ignore". */
  label: string;
  /** Summed count across every `skipped[]` entry carrying this reason. */
  count: number;
  /** How many `skipped[]` entries (groups) carried this reason. */
  groupCount: number;
  /** First {@link SKIP_EXAMPLE_CAP} distinct example sources, in first-seen order. */
  examples: string[];
  /** Distinct examples beyond the cap (0 when none) — the no-silent-caps number. */
  moreExamples: number;
}

/** Merges `skipped[]` by reason, first-appearance order preserved. Tolerates
 * `undefined` (a pre-program `proposal.json` carries no `skipped` field). */
export function skipRows(skipped: ScanSkipGroup[] | undefined): SkipRow[] {
  if (!skipped || skipped.length === 0) return [];

  const order: SkipReason[] = [];
  const byReason = new Map<
    SkipReason,
    { count: number; groupCount: number; examples: string[] }
  >();

  for (const group of skipped) {
    let entry = byReason.get(group.reason);
    if (!entry) {
      entry = { count: 0, groupCount: 0, examples: [] };
      byReason.set(group.reason, entry);
      order.push(group.reason);
    }
    entry.count += group.count;
    entry.groupCount += 1;
    for (const source of group.exampleSources) {
      if (!entry.examples.includes(source)) entry.examples.push(source);
    }
  }

  return order.map((reason) => {
    const entry = byReason.get(reason)!;
    return {
      reason,
      label: SKIP_REASON_LABELS[reason],
      count: entry.count,
      groupCount: entry.groupCount,
      examples: entry.examples.slice(0, SKIP_EXAMPLE_CAP),
      moreExamples: Math.max(0, entry.examples.length - SKIP_EXAMPLE_CAP),
    };
  });
}

/** "skipped 47 as dynamic content (3 repeated groups)" — the group clause
 * appears only when `groupCount > 1`. */
export function formatSkipRow(row: SkipRow): string {
  const groupClause = row.groupCount > 1 ? ` (${row.groupCount} repeated groups)` : "";
  return `skipped ${row.count} as ${row.label}${groupClause}`;
}

/** "Skipped 59 element(s) — not proposed as slots"; `null` when nothing was skipped. */
export function skipHeadline(skipped: ScanSkipGroup[] | undefined): string | null {
  if (!skipped || skipped.length === 0) return null;
  const total = skipped.reduce((sum, g) => sum + g.count, 0);
  return `Skipped ${total} element(s) — not proposed as slots`;
}

export interface MigrationRow {
  kind: MigrationFinding["kind"];
  value: string;
  nearestRole: string;
  occurrences: number;
  examples: string[];
  moreExamples: number;
  /** "#2e7d32 → --brand-primary — appears 14×; replace the literal with the
   * --brand-primary role" — `nearestRole` rendered verbatim, no `var(...)`
   * synthesis (the finding record is the authority). */
  line: string;
}

/** Formats every migration finding — proposal-only, ADVISORY, never a
 * candidate. Tolerates `undefined` (a pre-program `proposal.json` carries no
 * `migrations` field). */
export function migrationRows(migrations: MigrationFinding[] | undefined): MigrationRow[] {
  if (!migrations) return [];
  return migrations.map((m) => ({
    kind: m.kind,
    value: m.value,
    nearestRole: m.nearestRole,
    occurrences: m.occurrences,
    examples: m.examples.slice(0, SKIP_EXAMPLE_CAP),
    moreExamples: Math.max(0, m.examples.length - SKIP_EXAMPLE_CAP),
    line: `${m.value} → ${m.nearestRole} — appears ${m.occurrences}×; replace the literal with the ${m.nearestRole} role`,
  }));
}

export interface OverlayWarning {
  /** `Math.round(fraction * 100)`, clamped to 0..100. */
  percent: number;
  /** `ariaLabel ?? alt ?? classNames.join(".") ?? nearbyText ?? null` — never fabricated. */
  detail: string | null;
  /** The full sentence, including the `scan.dismiss` fix hint. */
  message: string;
}

/** `null` when no proposal carries `blockedByOverlay`. Otherwise the rounded
 * viewport fraction, an honest detail ladder, and the actionable
 * `scan.dismiss` fix hint — the honest half of SC-03's surfacing. */
export function overlayWarning(
  blocked: { fraction: number; hints: ScanHints } | undefined,
): OverlayWarning | null {
  if (!blocked) return null;

  const percent = Math.max(0, Math.min(100, Math.round(blocked.fraction * 100)));
  const detail =
    blocked.hints.ariaLabel ??
    blocked.hints.alt ??
    (blocked.hints.classNames && blocked.hints.classNames.length > 0
      ? blocked.hints.classNames.join(".")
      : undefined) ??
    blocked.hints.nearbyText ??
    null;
  const detailClause = detail ? ` (${detail})` : "";

  const message =
    `This scan may have inventoried an overlay. An element covering ~${percent}% of the ` +
    `viewport was still on screen after setup${detailClause}. Add a scan.dismiss selector ` +
    `to your keyart.config.ts scan block and re-scan.`;

  return { percent, detail, message };
}
