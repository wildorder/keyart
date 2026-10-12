import path from "node:path";
import { loadConfig, directionsRoot } from "../config.js";
import { ensureDir, writeTextFile } from "../fs.js";
import { hasApiKey, detectContradictionsLLM } from "../openai.js";
import {
  detectContradictions,
  type ContradictionReport,
  type ContradictionInput,
  type ContradictionDeps,
} from "../brand/conflict-guard.js";
import { resolveDirection } from "../direction/store.js";
import { resolveFoundation, assertFoundationPath } from "../direction/foundation.js";
import { assertDirectionHasVersions } from "../direction/draft-guard.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import {
  MAX_CONTEXT_REFERENCES,
  assembleContext,
  renderContextBlock,
  type ReferenceItem,
} from "../brand/assemble-context.js";
import {
  renderArtDirectionPrecedence,
} from "../explore/compose-art-direction.js";
import { cloneTokens, deriveLocksFromContext } from "../explore/token-intent.js";
import {
  splitByIntent,
  type RunReference,
} from "../explore/reference-intent.js";
import { writeDirectionVersion } from "../explore/write-direction-version.js";
import {
  renderStyleBoardSvg,
  renderStyleBoardMarkdown,
} from "../approve/render-style-board.js";
import type { PaletteLock } from "../brand/palette.js";
import { loadEnvFiles } from "../env.js";
import type {
  DirectionContent,
  DirectionVersion,
  PaletteRole,
} from "../types.js";

export interface RegenerateVisualsResult {
  /** The NEW version appended by this regenerate (the direction's new head). */
  versionId: string;
  directionId: string;
  filesWritten: string[]; // cwd-relative, forward slashes
  imageSkips: string[];
  dryRun: boolean;
  /** True when the deterministic style board (SVG + markdown) was rendered from
   * the new version's tokens — a model-free artifact that lands even keyless.
   * False only for a (legacy) token-less version. */
  boardWritten: boolean;
  /** Advisory contradiction report — never edits the compiled block (SC-07/SC-11). */
  contradictionReport: ContradictionReport;
}

/**
 * The single iterate path: **feedback → regenerate appends a new
 * `DirectionVersion`**. Addressed by `<directionId>`, this reads the direction's
 * **selected** version, renders a new authoritative tile (soft locked-color guidance + kept
 * `inspire` crops + discard negatives), re-extracts the UNLOCKED tokens off the
 * new tile (locked roles held verbatim — lock-and-rotate, SC-06), and **appends**
 * the result as the next version — the head advances and prior versions are never
 * touched (append-only history, SC-06/SC-11).
 *
 * Token extraction lives in exactly ONE place — the WS-01
 * {@link writeDirectionVersion} — so regenerate composes the new version and
 * hands it to the writer rather than re-implementing the read. The one-shot
 * `tweak` / `feedbackNote` steer THIS pass's imagery via the writer's
 * `oneShotArtDirection` seam (never persisted). The prose/copy of the new version
 * is a verbatim clone of the head — regenerate NEVER rewrites copy.
 *
 * The refine command's keep+tweak behavior folds in here: when the gesture
 * carries a `keep` / `tweak` / `feedbackNote` signal it is logged as attributed
 * direction `feedback` (`source: "regenerate"`) so it still feeds the next explore
 * (SC-07); a plain regenerate stays memory-neutral.
 *
 * Degrades gracefully with no key / no image model / capability failure — it
 * collects skip reasons, still appends a cloned-token version + re-renders the
 * deterministic board, flags dry-run, and never throws (SC-11).
 */
export async function runReviseDirection(opts: {
  cwd: string;
  directionId: string;
  /** Explicit source foundation; omitted selects the current head once. */
  versionId?: string;
  /** One-shot crop/image reference, never added to the direction's moodboard. */
  referencePath?: string;
  /** Internal validated edit seam; all edits still use this generation/append path. */
  editedContent?: DirectionContent;
  /** One-shot art direction appended to the tile prompt for this pass only. */
  tweak?: string;
  /** Roles whose CURRENT head-version value is held verbatim across this
   * regenerate (lock-and-rotate). Unlocked roles are re-extracted from the tile. */
  lockedRoles?: PaletteRole[];
  /** Explicit locked hexes (e.g. a rerolled palette pushed in as locks). Seed
   * both the soft image guidance and the extraction locks; merged per-role with
   * the head's current values for `lockedRoles`. */
  lockedColors?: { role?: PaletteRole; hex: string }[];
  /** One-shot GENERIC feedback note steering THIS pass's graphics (not persisted
   * to the version; appended to prompts like `tweak`). */
  feedbackNote?: string;
  /** Optional named aspects to keep (the former refine `--keep`) — recorded as
   * provenance on the new version + folded into direction feedback. */
  keep?: string[];
}): Promise<RegenerateVisualsResult> {
  const cwd = path.resolve(opts.cwd);

  // Load `.env*` first so a key in `.env.local` is honored (mirrors explore).
  loadEnvFiles(cwd);

  const config = await loadConfig(opts.cwd);
  const rel = (abs: string): string =>
    path.relative(cwd, abs).split(path.sep).join("/");
  const filesWritten: string[] = [];
  const imageSkips: string[] = [];
  const dryRun = !hasApiKey();
  const root = directionsRoot(opts.cwd, config);
  const resolvedDirection = await resolveDirection(opts.cwd, config, opts.directionId);
  // A draft has no version to regenerate — teach the fix instead of crashing.
  assertDirectionHasVersions(opts.directionId, resolvedDirection.record.head);

  // Read the HEAD version — readHead throws a CommandError naming the direction
  // when absent. Prior versions are never read/written here (append-only).
  const foundation = await resolveFoundation({ cwd, config, directionId: opts.directionId,
    versionId: opts.versionId ?? resolvedDirection.record.head! });
  const head = foundation.content;
  const sourceContent = opts.editedContent ?? head;

  const core = createDirectionCore(cwd, config);

  // Elevate the direction's moodboard/kept-crop images as generation references,
  // routed by intent so ONLY `inspire` refs reach the image model (biased
  // regeneration); an `extract` crop is excluded (never a direct image source).
  // Every asset on this record already belongs to THIS direction (scope is
  // location) — no sibling filter needed.
  const imageRefs = await core.imageAssetPaths(opts.directionId);
  const references: ReferenceItem[] = imageRefs.slice(0, MAX_CONTEXT_REFERENCES);
  const resolved: RunReference[] = references.map((r) => ({
    path: path.resolve(cwd, r.path),
    intent: r.intent ?? "inspire",
    note: r.note,
  }));
  const { inspire } = splitByIntent(resolved);
  const refAbs = inspire.map((r) => r.path);
  if (opts.referencePath) {
    const reference = path.resolve(cwd, opts.referencePath);
    await assertFoundationPath(cwd, reference);
    refAbs.unshift(reference);
  }

  // This direction's memory → assembled context (single precedence chokepoint).
  // Words only — a discard thumbnail is NEVER a reference image.
  const memory = await core.memoryEntries(opts.directionId);

  // The locked-color set (lock-and-rotate): roles held verbatim at their head
  // value + explicit locked hexes. The plain hexes feed the SOFT image guidance;
  // the role-aware `PaletteLock[]` are honored verbatim as extraction locks after
  // the tile renders (SC-06). Empty when nothing is locked.

  // One-shot art direction for THIS pass only (never persisted). The one-shot
  // `tweak` and the GENERIC `feedbackNote` are the same kind of this-pass steer,
  // so they combine into one instruction the writer appends to the image prompts.
  const artDirection = [opts.tweak, opts.feedbackNote]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s && s.length > 0)
    .join(" ");
  const keep = (opts.keep ?? [])
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  // A keep / tweak / generic-feedback signal is the refine-replacement gesture.
  const gesture = artDirection.length > 0 || keep.length > 0;

  // Frozen provenance for the NEW version — symmetric with explore's chokepoints:
  // the rendered brief projection + the assembled context block (never `brief.md`
  // off disk). The one-shot steer is recorded in the snapshot for provenance
  // without being baked into the stored prompts.
  const briefText = await core.getRenderedBrief(opts.directionId);
  const brand = createBrandCore(cwd, config);
  const global = await brand.read();
  const assembled = assembleContext({
    brief: briefText,
    global,
    memory,
    references,
  });
  const contextBlock = renderContextBlock(assembled);
  const lockSet = buildLockedColorSet(sourceContent, opts.lockedRoles ?? [], [
    ...deriveLocksFromContext(contextBlock), ...(opts.lockedColors ?? []),
  ]);

  // Advisory detection pass — never edits the compiled block. Key-gates the
  // semantic adapter: no key ⇒ deps undefined ⇒ floor only.
  const detectInput: ContradictionInput = {
    liveInstruction: artDirection,
    liveInstructionId: `live:regenerate:${opts.directionId}:${head.id}`,
    hardRules: assembled.hardRules,
    guidelines: assembled.guidelines,
    memory,
  };
  const detectionDeps: ContradictionDeps | undefined = hasApiKey()
    ? {
        semantic: async (i) =>
          (
            await detectContradictionsLLM({
              model: config.models.text,
              liveInstruction: i.liveInstruction,
              hardRules: i.hardRules.map((r) => ({ id: r.id, text: r.text })),
              guidelines: i.guidelines.map((r) => ({ id: r.id, text: r.text })),
              memory: i.memory.map((m) => ({ id: m.id, kind: m.kind, body: m.body })),
            })
          ).contradictions,
      }
    : undefined;
  const contradictionReport = await detectContradictions(detectInput, detectionDeps);
  // SC-08: render hard-rule guard warnings to stdout. Guard: runs under
  // captureCommandOutput (MCP stdout channel), so console.warn is safe.
  for (const w of contradictionReport.warnings) console.warn(w.message);

  const snapshotContext = `## Source foundation\n\n${opts.directionId}@${head.id}\n\n` + (artDirection
    ? `## One-shot art direction (this pass only)\n\n${artDirection}\n\n${contextBlock}`
    : contextBlock);

  // Build the NEW version from a CLONE of the head's content — name/summary/
  // positioning/visualStyle/prompts/copy/rules/tokens carried verbatim
  // (regenerate never rewrites copy). Strip the head's own identity/provenance;
  // the writer + a fresh createdAt supply this version's.
  const {
    id: _id,
    createdAt: _createdAt,
    producedBy: _producedBy,
    briefSnapshot: _briefSnapshot,
    contextSnapshot: _contextSnapshot,
    ...content
  } = head;
  const version: DirectionVersion = {
    ...content,
    ...opts.editedContent,
    tokens: sourceContent.tokens ? cloneTokens(sourceContent.tokens) : undefined,
    id: "", // the writer mints a collision-safe versionId
    createdAt: new Date().toISOString(),
    producedBy: opts.editedContent ? `manual edit from ${head.id}` : describeProvenance(keep, artDirection),
    briefSnapshot: briefText,
    contextSnapshot: snapshotContext,
  };

  // Append `## Art-direction precedence` to contextSnapshot (SC-06 provenance).
  // The writer projects this exact frozen string to context-snapshot.md; the
  // `renderContextBlock` bytes are untouched and there is no parallel source.
  const precedence = renderArtDirectionPrecedence(assembled, {
    oneShot: artDirection || undefined,
  });
  const snapshotSeparator = version.contextSnapshot.endsWith("\n\n")
    ? ""
    : version.contextSnapshot.endsWith("\n")
      ? "\n"
      : "\n\n";
  const versionWithSnapshot: typeof version = {
    ...version,
    contextSnapshot: `${version.contextSnapshot}${snapshotSeparator}${precedence}`,
  };

  // Append the NEW version via the WS-01 writer — the SINGLE place token
  // extraction lives. It generates the tile, re-extracts the UNLOCKED
  // tokens (holding the role-aware locks verbatim — SC-06), writes prompts +
  // snapshots, and advances the index head. The one-shot art direction rides on
  // `oneShotArtDirection` so it steers THIS pass without being persisted into
  // direction-version.json (it IS written to the prompt .md files as provenance).
  const written = await writeDirectionVersion({
    cwd,
    directionsDir: root,
    directionId: opts.directionId,
    version: versionWithSnapshot,
    config,
    referenceImagePaths: refAbs,
    assembled,
    lockedColors: lockSet.hexes,
    extractionLocks: lockSet.locks,
    oneShotArtDirection: artDirection || undefined,
  });
  filesWritten.push(...written.filesWritten);
  imageSkips.push(...written.imageSkips);
  const versionId = written.versionId;
  const versionDir = path.join(
    root,
    opts.directionId,
    "versions",
    versionId,
  );

  // Deterministic style board (SVG + markdown) LAST — a model-free projection of
  // the NEW version's (re-extracted or cloned) tokens. Lands even keyless.
  let boardWritten = false;
  if (versionWithSnapshot.tokens) {
    await ensureDir(versionDir);
    const boardMdPath = path.join(versionDir, "style-board.md");
    await writeTextFile(boardMdPath, renderStyleBoardMarkdown(versionWithSnapshot));
    filesWritten.push(rel(boardMdPath));
    const boardSvgPath = path.join(versionDir, "style-board.svg");
    await writeTextFile(boardSvgPath, renderStyleBoardSvg(versionWithSnapshot));
    filesWritten.push(rel(boardSvgPath));
    boardWritten = true;
  }

  // Refine-replacement provenance: a keep/tweak/feedback gesture is logged as
  // attributed feedback on THIS direction so it feeds the next regenerate —
  // porting refine's memory logging. A plain regenerate stays memory-neutral.
  if (gesture) {
    const keepPart = keep.length > 0 ? ` keep [${keep.join(", ")}];` : "";
    const tweakPart = artDirection.length > 0 ? ` tweak: ${artDirection}` : "";
    await core.appendFeedback(opts.directionId, {
      body: `Regenerated ${opts.directionId}:${keepPart}${tweakPart}`.trim(),
      author: "cli",
      source: "regenerate",
    });
  }

  logSummary(opts.directionId, versionId, filesWritten, imageSkips, dryRun);

  return {
    versionId,
    directionId: opts.directionId,
    filesWritten,
    imageSkips,
    dryRun,
    boardWritten,
    contradictionReport,
  };
}

/** Existing public spelling delegates to the same foundation-only revision path. */
export const runRegenerateVisuals = runReviseDirection;

/** A concise provenance string for the new version from the regenerate gesture. */
function describeProvenance(keep: string[], artDirection: string): string {
  const parts: string[] = [];
  if (keep.length > 0) parts.push(`keep ${keep.join(", ")}`);
  if (artDirection.length > 0) parts.push(`tweak: ${artDirection}`);
  return parts.length > 0 ? `regenerate (${parts.join("; ")})` : "regenerate";
}

function logSummary(
  directionId: string,
  versionId: string,
  filesWritten: string[],
  imageSkips: string[],
  dryRun: boolean,
): void {
  console.log(
    `\nRegenerated ${directionId}: appended version ${versionId} (${filesWritten.length} file(s) written).`,
  );
  if (dryRun) {
    console.log(`Ran without OPENAI_API_KEY — no images written (dry-run).`);
  }
  for (const skip of imageSkips) {
    console.warn(`Warning: image skipped: ${skip}`);
  }
}

/**
 * Build the locked-color set for this regenerate. `lockedRoles` hold each role's
 * CURRENT head-version value verbatim; explicit `lockedColors` are layered on top
 * (a per-role explicit hex — e.g. a rerolled palette pushed in — overrides the
 * current value for that role; role-less hexes are appended). Returns the
 * `PaletteLock[]` (role-aware, verbatim extraction locks — SC-06) plus the plain
 * hex list for the soft image guidance. Pure; empty when nothing is locked.
 */
function buildLockedColorSet(
  direction: DirectionContent,
  lockedRoles: PaletteRole[],
  lockedColors: { role?: PaletteRole; hex: string }[],
): { locks: PaletteLock[]; hexes: string[] } {
  const byRole = new Map<PaletteRole, PaletteLock>();
  const roleless: PaletteLock[] = [];
  const palette = direction.tokens?.palette ?? [];

  for (const role of lockedRoles) {
    const token = palette.find((t) => t.role === role);
    if (token) byRole.set(role, { role, hex: token.hex });
  }
  for (const lc of lockedColors) {
    const hex = lc.hex.trim();
    if (hex.length === 0) continue;
    if (lc.role) byRole.set(lc.role, { role: lc.role, hex });
    else roleless.push({ hex });
  }

  const locks = [...byRole.values(), ...roleless];
  return { locks, hexes: locks.map((l) => l.hex) };
}
