import path from "node:path";
import { CommandError } from "../errors.js";
import { loadConfig } from "../config.js";
import { pathExists, readTextFile, writeJsonFile } from "../fs.js";
import { loadEnvFiles } from "../env.js";
import { createSurfaceCore } from "./store.js";
import { surfaceScanDir, type ScanCandidate, type ScanProposal } from "./scan.js";
import { SLOT_ID_RE, SLOT_KINDS } from "./schema.js";
import type { SlotKind } from "./schema.js";
import { matchKnownFamily } from "../brand/fonts.js";
import {
  classifySurfaceCandidates,
  type SurfaceCandidateInput,
  type SurfaceCandidateSuggestion,
} from "../openai.js";

const VALID_KINDS: ReadonlySet<string> = new Set<SlotKind>(SLOT_KINDS);

/** Kinds whose ids are judged by the value-derived guard. icon/illustration ids
 *  are NEVER judged — an icon's depicted subject IS its function, and
 *  `icon.green-flag` may be a legitimate concept. */
const VALUE_NAMED_KINDS: ReadonlySet<SlotKind> = new Set<SlotKind>(["color-role", "type-role"]);

/** Unambiguous appearance words. Whole-token match only (never substring), so
 *  "background-app" and "greenhouse-hero" are not falsely rejected. */
const COLOR_WORDS: ReadonlySet<string> = new Set([
  "aqua", "amber", "azure", "beige", "black", "blue", "bronze", "brown", "charcoal",
  "chartreuse", "coral", "crimson", "cyan", "ecru", "emerald", "fuchsia", "gold", "gray",
  "green", "grey", "indigo", "ivory", "jade", "khaki", "lavender", "lilac", "lime",
  "magenta", "maroon", "mauve", "navy", "ochre", "olive", "orange", "peach", "periwinkle",
  "pink", "plum", "purple", "red", "rose", "ruby", "russet", "salmon", "sapphire",
  "scarlet", "sepia", "sienna", "silver", "slate", "tan", "teal", "terracotta",
  "turquoise", "violet", "white", "yellow",
] as const);

/** Hex-ish token lengths (3/4/6/8 hex digits). A token must ALSO contain at
 *  least one digit to be judged hex-ish — this keeps real words made only of
 *  hex letters (`beef`, `face`, `added`, `cafe`) out of the rejection class. */
const HEX_ISH_RE = /^(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/;

/** Color-space/format keywords — a token match here is unambiguous. */
const COLOR_FORMAT_TOKENS: ReadonlySet<string> = new Set([
  "rgb", "rgba", "hsl", "hsla", "oklch", "oklab", "hex",
] as const);

/** CSS generic font-family keywords judged as single tokens. Deliberately does
 *  NOT include the bare token "sans" or "display" — both are legitimate usage
 *  words (e.g. `type-role.display-heading`, `type-role.sans-nav`). The
 *  two-token pair "sans serif" is checked separately below. */
const GENERIC_FONT_FAMILIES: ReadonlySet<string> = new Set([
  "serif", "monospace", "cursive", "fantasy",
] as const);

/**
 * The offending detail, or undefined when the id is clean. Private — the
 * exported predicate is the contract; this feeds the recorded drop reason.
 *
 * PURE: no I/O, no clock, no randomness. Assumes `id` already passed
 * SLOT_ID_RE (at least two dot segments, each lowercase-kebab starting with a
 * letter). Judges only the NAME segment(s) — `id.split(".").slice(1)` — the
 * first (FAMILY) segment is never judged (a color-role id's family is
 * literally "color" or "color-role"; judging it would reject every id).
 *
 * Evaluation order is A (color word) → B (hex-ish / color-format token) → C
 * (catalog font family / CSS generic family), first hit wins, so the result
 * is order-deterministic for a given input.
 *
 * Known, accepted false positives (the Risk Register's accepted trade):
 * `color-role.gold-tier` (a loyalty tier) and `color-role.b2b-banner` ("b2b"
 * is 3 hex chars with a digit) are rejected. The guard is kind-scoped (never
 * touches icon/illustration), the drop is recorded with the rejected value so
 * triage shows exactly what was rejected and why, and the candidate remains
 * fully reviewable under its anonymous id — a human can author the slot
 * deliberately with `surface set`/`patch`. A false NEGATIVE (a value-named
 * slot silently entering the demand record) is the failure this program
 * exists to eliminate; a false positive is visible and recoverable.
 */
function valueDerivedReason(id: string, kind: SlotKind): string | undefined {
  if (!VALUE_NAMED_KINDS.has(kind)) return undefined;

  const nameSegments = id.split(".").slice(1);
  const tokenized = nameSegments.map((segment) => segment.split("-"));

  // Class A — color word (whole-token match only).
  for (const tokens of tokenized) {
    for (const token of tokens) {
      if (COLOR_WORDS.has(token)) return `color word "${token}"`;
    }
  }

  // Class B — hex-ish token (with a digit) or color-format keyword.
  for (const tokens of tokenized) {
    for (const token of tokens) {
      if (HEX_ISH_RE.test(token) && /[0-9]/.test(token)) {
        return `hex-ish token "${token}"`;
      }
      if (COLOR_FORMAT_TOKENS.has(token)) {
        return `color-format token "${token}"`;
      }
    }
  }

  // Class C — catalog font family (reused matchKnownFamily) or CSS generic family.
  for (const tokens of tokenized) {
    const maxRun = Math.min(4, tokens.length);
    for (let len = 1; len <= maxRun; len += 1) {
      for (let start = 0; start + len <= tokens.length; start += 1) {
        const run = tokens.slice(start, start + len).join(" ");
        if (len === 1 && GENERIC_FONT_FAMILIES.has(run)) {
          return `generic font family "${run}"`;
        }
        if (run === "sans serif") {
          return `generic font family "${run}"`;
        }
        const known = matchKnownFamily(run);
        if (known) return `font family "${known}"`;
      }
    }
  }

  return undefined;
}

/**
 * True ⇒ DROP the suggestion. SCOPED to "color-role" | "type-role" only.
 * Rejects ids whose NAME segment(s) contain a color word, a hex-ish token, or a
 * catalog font-family name — the "names supply, not demand" defect the manifest
 * cannot tolerate (a value-named slot is false the moment the brand changes).
 * PURE: no I/O, no clock, no randomness. Assumes `id` already passed SLOT_ID_RE.
 */
export function isValueDerivedId(id: string, kind: SlotKind): boolean {
  return valueDerivedReason(id, kind) !== undefined;
}

export interface RefineOutcome {
  proposal: ScanProposal; // the upgraded proposal (new object)
  refinedCount: number; // candidates that received >= 1 field this round
  droppedSuggestions: {
    signature: string;
    field: "suggestedId" | "kind";
    value: string;
    reason: string;
  }[];
}

/**
 * Pure: merge validated suggestions into a proposal. No I/O, no model call.
 * `tone` has no fixed per-field flag of its own — its provenance rides under
 * `refined.description` (tone/description are the same descriptive facet
 * supplied by the same model turn), so tone alone still sets
 * `refined.description = true`.
 */
export function mergeRefinement(
  proposal: ScanProposal,
  suggestions: SurfaceCandidateSuggestion[],
  opts: { takenSlotIds: Set<string>; now: string },
): RefineOutcome {
  const bySignature = new Map<string, SurfaceCandidateSuggestion>();
  for (const s of suggestions) {
    bySignature.set(s.signature, s);
  }

  const assignedIds = new Set(proposal.candidates.map((c) => c.proposedId));
  const dropped: RefineOutcome["droppedSuggestions"] = [];
  let refinedCount = 0;

  const candidates: ScanCandidate[] = proposal.candidates.map((candidate) => {
    const suggestion = bySignature.get(candidate.signature);
    if (!suggestion) return candidate;

    let next: ScanCandidate = candidate;
    let touched = false;
    const refined = { ...(candidate.refined ?? {}) };

    // Judge the id against the kind this candidate will END UP with in this merge —
    // the model's corrected kind when it supplies (and we accept) one, else the
    // floor's. Judging the floor kind alone lets a kind-correcting suggestion smuggle
    // a value-derived id past the guard (e.g. an icon-floor candidate suggesting both
    // `suggestedId: "color-role.brand-green"` and `kind: "color-role"` would clear a
    // guard scoped to "icon", then the later `kind` rung promotes it to `color-role`).
    const acceptedSuggestionKind: SlotKind | undefined =
      suggestion.kind !== undefined && VALID_KINDS.has(suggestion.kind)
        ? (suggestion.kind as SlotKind)
        : undefined;
    const effectiveKind: SlotKind = acceptedSuggestionKind ?? candidate.kind;

    if (suggestion.suggestedId !== undefined) {
      const value = suggestion.suggestedId;
      const others = new Set(assignedIds);
      others.delete(candidate.proposedId);

      let reason: string | undefined;
      if (!SLOT_ID_RE.test(value)) {
        reason = "invalid id format";
      } else if (opts.takenSlotIds.has(value)) {
        reason = `collides with existing manifest slot ${value}`;
      } else if (others.has(value)) {
        reason = "duplicate of another candidate's id";
      } else {
        const detail = valueDerivedReason(value, effectiveKind);
        if (detail) {
          reason = `value-derived id (${detail}) — name the role, not the value`;
        }
      }

      if (reason) {
        dropped.push({ signature: candidate.signature, field: "suggestedId", value, reason });
      } else {
        assignedIds.delete(candidate.proposedId);
        assignedIds.add(value);
        next = { ...next, proposedId: value };
        refined.proposedId = true;
        touched = true;
      }
    }

    if (suggestion.kind !== undefined) {
      if (VALID_KINDS.has(suggestion.kind)) {
        next = { ...next, kind: suggestion.kind as SlotKind };
        refined.kind = true;
        touched = true;
      } else {
        dropped.push({
          signature: candidate.signature,
          field: "kind",
          value: suggestion.kind,
          reason: "unknown kind",
        });
      }
    }

    let descriptionTouched = false;
    if (typeof suggestion.description === "string" && suggestion.description.trim()) {
      next = { ...next, description: suggestion.description };
      descriptionTouched = true;
    }
    if (typeof suggestion.tone === "string" && suggestion.tone.trim()) {
      next = { ...next, context: { ...(next.context ?? {}), tone: suggestion.tone } };
      descriptionTouched = true;
    }
    if (descriptionTouched) {
      refined.description = true;
      touched = true;
    }

    if (Object.keys(refined).length > 0) {
      next = { ...next, refined };
    }

    if (touched) refinedCount += 1;
    return next;
  });

  const refineNotes = dropped.map(
    (d) => `dropped ${d.field} ${JSON.stringify(d.value)} for ${d.signature}: ${d.reason}`,
  );

  const nextProposal: ScanProposal = {
    ...proposal,
    candidates,
    refinedAt: opts.now,
    refineNotes,
  };

  return { proposal: nextProposal, refinedCount, droppedSuggestions: dropped };
}

export interface SurfaceRefineResult {
  proposalFile: string; // repo-relative
  refinedCount: number;
  candidateCount: number;
  dropped: RefineOutcome["droppedSuggestions"];
  dryRun: boolean; // true ⇔ keyless — proposal left byte-untouched
  skippedReason?: string;
  filesWritten: string[]; // [proposal.json] when written; [] on dry-run
}

const NO_KEY_MESSAGE =
  "No OPENAI_API_KEY — proposal left unrefined (anonymous ids). Add a key and run `keyart surface scan --refine-only` to upgrade it.";

/**
 * Reads the floor's scan proposal, calls the key-gated vision refinement seam
 * ({@link classifySurfaceCandidates}), and merges accepted suggestions back
 * into the SAME proposal file — never the manifest. Keyless or a failing
 * adapter degrades to the untouched floor proposal (the conflict-guard
 * "failing adapter degrades to the floor" discipline). Re-running upgrades the
 * same proposal in place.
 */
export async function runSurfaceRefine(opts: { cwd: string }): Promise<SurfaceRefineResult> {
  // `.env*` FIRST — before loadConfig and before the seam's hasApiKey() gate —
  // so the standalone `--refine-only` path honors a key stored only in
  // `.env.local` (the explore/doctor convention; the direct CLI path does not
  // preload env the way MCP/serve do).
  loadEnvFiles(opts.cwd);

  const config = await loadConfig(opts.cwd);
  const cwd = path.resolve(opts.cwd);
  const rel = (abs: string): string => path.relative(cwd, abs).split(path.sep).join("/");

  const scanDir = surfaceScanDir(cwd, config);
  const proposalPath = path.join(scanDir, "proposal.json");

  if (!(await pathExists(proposalPath))) {
    throw new CommandError(
      `No scan proposal found at ${rel(proposalPath)}. Run \`keyart surface scan <url>\` first.`,
    );
  }

  const proposal = JSON.parse(await readTextFile(proposalPath)) as ScanProposal;

  const seamCandidates: SurfaceCandidateInput[] = [];
  let missingCropCount = 0;
  for (const candidate of proposal.candidates) {
    const cropAbsPath = path.resolve(cwd, candidate.cropFile);
    if (!(await pathExists(cropAbsPath))) {
      missingCropCount += 1;
      continue;
    }
    seamCandidates.push({
      signature: candidate.signature,
      kind: candidate.kind,
      cropPath: cropAbsPath,
      hints: candidate.hints,
      contextNote: candidate.context?.note,
    });
  }
  if (missingCropCount > 0) {
    console.log(`Warning: ${missingCropCount} candidate(s) skipped — crop file missing on disk.`);
  }

  const taxonomy = SLOT_KINDS.join(" | ");

  let seamResult: Awaited<ReturnType<typeof classifySurfaceCandidates>>;
  try {
    seamResult = await classifySurfaceCandidates({
      model: config.models.vision,
      candidates: seamCandidates,
      taxonomy,
    });
  } catch (err) {
    // Defensive: the seam contract says it never throws, but a rejecting
    // adapter must still degrade to the floor proposal rather than an
    // unhandled rejection (the conflict-guard swallow).
    seamResult = {
      candidates: [],
      dryRun: false,
      skippedReason: err instanceof Error ? err.message : String(err),
    };
  }

  if (seamResult.dryRun) {
    console.log(NO_KEY_MESSAGE);
    return {
      proposalFile: rel(proposalPath),
      refinedCount: 0,
      candidateCount: proposal.candidates.length,
      dropped: [],
      dryRun: true,
      filesWritten: [],
    };
  }

  if (seamResult.candidates.length === 0) {
    if (seamResult.skippedReason) {
      console.log(`Refinement skipped: ${seamResult.skippedReason}`);
    }
    return {
      proposalFile: rel(proposalPath),
      refinedCount: 0,
      candidateCount: proposal.candidates.length,
      dropped: [],
      dryRun: false,
      skippedReason: seamResult.skippedReason,
      filesWritten: [],
    };
  }

  const manifest = await createSurfaceCore(cwd, config).read();
  const takenSlotIds = new Set<string>(manifest ? manifest.slots.map((s) => s.id) : []);

  const outcome = mergeRefinement(proposal, seamResult.candidates, {
    takenSlotIds,
    now: new Date().toISOString(),
  });

  await writeJsonFile(proposalPath, outcome.proposal);

  const lines = [`Refined ${outcome.refinedCount} of ${proposal.candidates.length} candidate(s).`];
  for (const d of outcome.droppedSuggestions) {
    lines.push(`  dropped ${d.field} ${JSON.stringify(d.value)} for ${d.signature}: ${d.reason}`);
  }
  console.log(lines.join("\n"));

  return {
    proposalFile: rel(proposalPath),
    refinedCount: outcome.refinedCount,
    candidateCount: proposal.candidates.length,
    dropped: outcome.droppedSuggestions,
    dryRun: false,
    filesWritten: [rel(proposalPath)],
  };
}
