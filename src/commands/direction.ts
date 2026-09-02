import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CommandError } from "../errors.js";
import { loadConfig, directionsRoot, globalBrandPath } from "../config.js";
import {
  createDirectionCore,
  type AppendEntryInput,
} from "../direction/core.js";
import {
  sanitizeBriefText,
  proposeBriefPatch,
  type BriefMapProposal,
} from "../direction/brief-map.js";
import {
  mintDirectionId,
  resolveDirection,
  listDirectionIds,
  type ResolvedDirection,
} from "../direction/store.js";
import {
  isAssetRetired,
  DIRECTION_SLUG_RE,
  BrandBriefSchema,
  type AssetRef,
  type DirectionRecord,
  type DirectionStatus,
  type MemoryKind,
  type MemoryEntry,
  type BrandBrief,
  type BrandBriefPatch,
} from "../direction/schema.js";
import {
  ensureDir,
  pathExists,
  copyFileSafe,
  readTextFile,
  writeTextFile,
} from "../fs.js";
import { createBrandCore } from "../brand/core.js";
import type {
  RuleSeverity,
  GlobalRule,
  DirectiveChannel,
  DirectivePolarity,
} from "../brand/schema.js";
import {
  planReconciliation,
  type ReconcileAction,
  type ReconciliationResolveResponse,
} from "../direction/reconcile.js";
import type {
  ContradictionReport,
  Contradiction,
} from "../brand/conflict-guard.js";
import { VersionConflictError } from "../store/versioned-store.js";
import { promoteEntryToGlobal } from "../brand/promote-to-global.js";
import {
  createAuthoredDirection,
  type CreateDirectionResult,
} from "../explore/create-direction.js";

export type { CreateDirectionResult };

/** Draft-aware summary of one direction, shared by `new`/`list`/`show`. */
export interface DirectionSummary {
  id: string;
  name: string;
  status: DirectionRecord["status"];
  isDraft: boolean;
  head: string | null;
  versionCount: number;
}

function summarize(record: DirectionRecord): DirectionSummary {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    isDraft: record.head === null,
    head: record.head,
    versionCount: record.versions.length,
  };
}

function summaryLine(s: DirectionSummary): string {
  const state = s.isDraft
    ? "draft — no versions yet"
    : `head ${s.head} (${s.versionCount} version${s.versionCount === 1 ? "" : "s"})`;
  return `${s.id}  "${s.name}"  [${s.status}]  ${state}`;
}

/**
 * `direction new <name> [--describe "<text>"]` — keyless: mints a draft
 * direction (record + brief.md projection + empty memory.yaml, NO version
 * folder) through the landed DirectionCore.create path. A --describe seed goes
 * through `sanitizeBriefText`, so no hex and no catalog font family ever
 * reaches a brief field.
 */
export async function runDirectionNew(opts: {
  cwd: string;
  name?: string;
  describe?: string;
}): Promise<{
  directionId: string;
  name: string;
  version: number;
  isDraft: boolean;
}> {
  const name = opts.name?.trim();
  if (!name) {
    throw new CommandError(
      'Usage: keyart direction new <name> [--describe "<text>"]',
    );
  }

  const config = await loadConfig(opts.cwd);
  const id = await mintDirectionId(directionsRoot(opts.cwd, config), name);

  const described = opts.describe ? sanitizeBriefText(opts.describe) : "";
  const brief = described ? { otherNotes: described } : {};

  const created = await createDirectionCore(opts.cwd, config).create({
    id,
    name,
    brief,
  });

  console.log(
    `Created draft direction "${id}" (no versions yet). Next: keyart explore ${id}`,
  );

  return {
    directionId: id,
    name,
    version: created.version,
    isDraft: created.head === null,
  };
}

/** Draft-aware `direction list`: one summary per direction. */
export async function runDirectionList(opts: {
  cwd: string;
}): Promise<{ directions: DirectionSummary[] }> {
  const config = await loadConfig(opts.cwd);
  const records = await createDirectionCore(opts.cwd, config).list();
  const directions = records.map(summarize);
  for (const s of directions) console.log(summaryLine(s));
  if (directions.length === 0) {
    console.log(
      "No directions yet. Run `keyart direction new <name>` to create one.",
    );
  }
  return { directions };
}

/** Draft-aware `direction show <id>`: the same summary for one direction. */
export async function runDirectionShow(opts: {
  cwd: string;
  directionId?: string;
}): Promise<DirectionSummary> {
  if (!opts.directionId?.trim()) {
    throw new CommandError("Usage: keyart direction show <directionId>");
  }
  const config = await loadConfig(opts.cwd);
  const resolved = await resolveDirection(opts.cwd, config, opts.directionId);
  const summary = summarize(resolved.record);
  console.log(summaryLine(summary));
  return summary;
}

export interface CreateDirectionCommandResult extends CreateDirectionResult {}

const USAGE =
  "Usage: keyart direction create '<json>' --from <directionId>";

export async function runCreateDirection(opts: {
  cwd: string;
  verb: string;
  /** The EXISTING direction whose brief seeds the new one. */
  seedDirectionId?: string;
  json?: string;
}): Promise<CreateDirectionResult> {
  if (opts.verb !== "create") {
    throw new CommandError(
      `Unknown direction verb "${opts.verb}". Supported: ${DIRECTION_VERBS.join(", ")}.`,
    );
  }

  if (!opts.seedDirectionId?.trim()) {
    throw new CommandError(USAGE);
  }

  if (!opts.json?.trim()) {
    throw new CommandError(USAGE);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.json);
  } catch (err) {
    throw new CommandError(
      `Could not parse the direction JSON: ${(err as Error).message}. Pass a single-quoted JSON object as the last argument.`,
    );
  }

  const result = await createAuthoredDirection({
    cwd: opts.cwd,
    directionId: opts.seedDirectionId,
    content: parsed,
  });

  console.log(
    `Created direction "${result.directionId}" (v1) seeded from "${result.seedDirection}".`,
  );
  console.log(`To approve: keyart approve ${result.directionId}`);

  return result;
}

/** One created fork's identity + draft facts (mirrors the draft summary shape). */
export interface ForkSummary {
  directionId: string;
  name: string;
  version: number; // 1 for a fresh draft (store persists (current ?? 0) + 1)
  isDraft: boolean; // always true — a fork has no versions
}

export interface RunDirectionForkResult {
  sourceId: string;
  forks: ForkSummary[];
}

const FORK_USAGE =
  "Usage: keyart direction fork <id> [--name <name>] [--count N] [--with-memory]";

/** cwd-relative, forward-slash path — the convention every AssetRef.path uses. */
function relForward(cwd: string, abs: string): string {
  return path.relative(cwd, abs).split(path.sep).join("/");
}

/**
 * Copy one fork's moodboard files with collision-safe destination names:
 * iterating the source refs in array order, the destination basename is
 * `<basename>` when unused in THIS fork, else `<stem>-2<ext>`, `<stem>-3<ext>`,
 * … — so two valid refs sharing a basename land as two distinct files and the
 * fork's assets[] holds as many distinct paths as there are non-retired source
 * refs whose files exist on disk. Retired refs and missing files are skipped.
 */
async function copyMoodboardAssets(
  cwd: string,
  source: ResolvedDirection,
  forkAssetsDir: string,
): Promise<AssetRef[]> {
  await ensureDir(forkAssetsDir);
  const claimed = new Set<string>();
  const out: AssetRef[] = [];
  for (const ref of source.record.assets) {
    if (isAssetRetired(ref)) continue;
    const srcAbs = path.resolve(cwd, ref.path);
    if (!(await pathExists(srcAbs))) continue;

    const base = path.basename(ref.path);
    const ext = path.extname(base);
    const stem = base.slice(0, base.length - ext.length);
    let candidate = base;
    for (let n = 2; claimed.has(candidate); n += 1) {
      candidate = `${stem}-${n}${ext}`;
    }
    claimed.add(candidate);

    const destAbs = path.join(forkAssetsDir, candidate);
    await copyFileSafe(srcAbs, destAbs);
    out.push({
      kind: ref.kind,
      path: relForward(cwd, destAbs),
      ...(ref.note ? { note: ref.note } : {}),
      ...(ref.intent ? { intent: ref.intent } : {}),
    });
  }
  return out;
}

/**
 * `direction fork <sourceId> [--name <name>] [--count N] [--with-memory]`.
 * Keyless: copies the source's brief verbatim and its moodboard files
 * (collision-safe) into N new DRAFTS, copies memory only under withMemory (as
 * fresh attributed appends naming the fork source — never an id-preserving
 * clone), always writes exactly one `decision` fork-provenance entry per fork,
 * and never touches the source record. Versions and extracted assets are NEVER
 * copied — a fork is a new exploration, not a duplicate of a render.
 */
export async function runDirectionFork(opts: {
  cwd: string;
  sourceId: string;
  name?: string;
  count?: number; // default 1
  withMemory?: boolean; // default false
}): Promise<RunDirectionForkResult> {
  const config = await loadConfig(opts.cwd);

  const count = opts.count ?? 1;
  if (!Number.isInteger(count) || count < 1) {
    throw new CommandError(FORK_USAGE);
  }

  const source = await resolveDirection(opts.cwd, config, opts.sourceId);
  const core = createDirectionCore(opts.cwd, config);
  const root = directionsRoot(opts.cwd, config);
  const baseName = opts.name?.trim() || source.record.name;

  // Read the source's active memory once, up front (retired entries are never
  // resurrected into a fork — memoryEntries already excludes them).
  const sourceEntries = opts.withMemory
    ? await core.memoryEntries(opts.sourceId)
    : [];

  const forks: ForkSummary[] = [];
  // Sequential so each mint sees the prior fork's folder and disambiguates.
  for (let i = 0; i < count; i += 1) {
    const forkId = await mintDirectionId(root, baseName);
    const forkAssetsDir = path.join(root, forkId, "assets");
    const newAssets = await copyMoodboardAssets(opts.cwd, source, forkAssetsDir);

    const created = await core.create({
      id: forkId,
      name: baseName,
      brief: source.record.brief,
      assets: newAssets,
    });

    for (const entry of sourceEntries) {
      const input: AppendEntryInput = {
        body: entry.body,
        author: entry.author,
        source: `fork:${opts.sourceId}`,
        ...(entry.channel ? { channel: entry.channel } : {}),
        ...(entry.polarity ? { polarity: entry.polarity } : {}),
      };
      if (entry.kind === "feedback") await core.appendFeedback(forkId, input);
      else if (entry.kind === "learning") await core.appendLearning(forkId, input);
      else await core.appendDecision(forkId, input);
    }

    // The single unconditional fork-provenance entry — a fork is never
    // anonymous. Appended LAST, so a flag-off fork's log is exactly [provenance].
    await core.appendDecision(forkId, {
      body: `Forked from direction "${opts.sourceId}".`,
      author: "fork",
      source: `fork:${opts.sourceId}`,
    });

    console.log(
      `Forked "${opts.sourceId}" → draft "${forkId}". Next: keyart explore ${forkId}`,
    );
    forks.push({
      directionId: forkId,
      name: baseName,
      version: created.version,
      isDraft: created.head === null,
    });
  }

  console.log(
    `Fork complete: ${forks.length} draft${forks.length === 1 ? "" : "s"} from "${opts.sourceId}".`,
  );
  return { sourceId: opts.sourceId, forks };
}

// ---------------------------------------------------------------------------
// The folded direction verb family (relocated from the deleted concept.ts)
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "../../templates");

/**
 * The verbs `runDirection` itself dispatches: the nine relocated members plus
 * the WS-05 additions `status` and `archive`. `show`, `fork`, and `create`
 * are roster members routed to their own handlers by the CLI dispatch.
 */
const RUN_DIRECTION_VERBS = [
  "new",
  "list",
  "reject",
  "park",
  "revive",
  "feedback",
  "memory",
  "brief",
  "reconcile",
  "status",
  "archive",
] as const;
type DirectionVerb = (typeof RUN_DIRECTION_VERBS)[number];

/**
 * The COMPLETE fourteen-verb `direction` family (SC-08) — derived once from the
 * relocated verb roster ∪ the added verbs, never restated from prose. This is
 * the single source every usage/error string and the roster test read.
 */
export const DIRECTION_VERBS = [
  ...RUN_DIRECTION_VERBS,
  "show",
  "fork",
  "create",
] as const;

/** Read-only `direction status` projection (WS-05). */
export interface DirectionStatusProjection {
  id: string;
  status: DirectionStatus;
  isDraft: boolean;
  head: string | null;
  versionCount: number;
}

/**
 * Resolve the direction a command should target when the caller omitted an
 * explicit id. NO implicit "default" direction. Order: the approved pointer's
 * direction (a stale pointer is a teaching error, never a silent fallthrough);
 * else the single existing direction; else a teaching CommandError listing the
 * available ids (or naming `keyart direction new` when none exist).
 */
export async function resolveTargetDirectionId(cwd: string): Promise<string> {
  const config = await loadConfig(cwd);
  const pointer = (await createBrandCore(cwd, config).read()).approvedPointer;
  if (pointer) {
    try {
      await resolveDirection(cwd, config, pointer.directionId);
    } catch {
      throw new CommandError(
        `The approved pointer names direction "${pointer.directionId}", which no longer exists on disk. ` +
          `Approve an existing direction (\`keyart approve <directionId>\`) or pass an explicit direction id.`,
      );
    }
    return pointer.directionId;
  }
  const ids = await listDirectionIds(directionsRoot(cwd, config));
  if (ids.length === 1) return ids[0];
  if (ids.length === 0) {
    throw new CommandError(
      "No directions exist yet. Run `keyart direction new <name>` to create one.",
    );
  }
  throw new CommandError(
    `No direction is approved and several exist — pass an explicit direction id. Available directions: ${ids.join(", ")}.`,
  );
}

/** Thrown when the memory audit was committed but the global promote write raced. */
export class ReconciliationPartialError extends CommandError {
  readonly payload: {
    code: "reconciliation_partial";
    action: "promote";
    committed: "memory";
    memoryVersion: number;
    expectedGlobalVersion: number;
    actualGlobalVersion: number;
    retryable: true;
  };
  constructor(
    memoryVersion: number,
    expectedGlobalVersion: number,
    actualGlobalVersion: number,
  ) {
    super(
      `Partial reconciliation: memory audit committed at v${memoryVersion}, but global version conflict ` +
        `(expected ${expectedGlobalVersion}, found ${actualGlobalVersion}). ` +
        `Refresh both versions and retry.`,
    );
    this.name = "ReconciliationPartialError";
    this.payload = {
      code: "reconciliation_partial",
      action: "promote",
      committed: "memory",
      memoryVersion,
      expectedGlobalVersion,
      actualGlobalVersion,
      retryable: true,
    };
  }
}

const BRIEF_SUBVERBS = ["show", "set", "patch", "map"] as const;
type BriefSubverb = (typeof BRIEF_SUBVERBS)[number];

const MEMORY_KINDS = ["feedback", "learning", "decision"] as const;
const RULE_SEVERITIES = ["hard", "guideline"] as const;
const DIRECTIVE_CHANNELS = ["visual", "copy", "both"] as const;
const DIRECTIVE_POLARITIES = ["prefer", "avoid"] as const;

/**
 * The `direction memory <edit|promote|delete>` sub-actions (WS-04). Distinct from
 * the top-level `RUN_DIRECTION_VERBS` — these are disambiguated off `rest[0]` when it
 * is one of these three words; a direction id in that slot means "read" instead
 * (see the `case "memory"` dispatch in {@link runDirection}).
 */
export const MEMORY_ACTIONS = ["edit", "promote", "delete"] as const;
export type MemoryAction = (typeof MEMORY_ACTIONS)[number];
/** Promote is up-only, direction→global — the direction rung is the only source; global is the only target. */
const PROMOTE_TARGETS = ["global"] as const;
type PromoteTarget = (typeof PROMOTE_TARGETS)[number];

/** The applied result of a `direction memory <edit|promote|delete>` write. */
export interface MemoryLifecycleResult {
  action: MemoryAction;
  directionId: string;
  entryId: string;
  to?: "global"; // promote only
  memoryVersion: number;
  globalVersion?: number; // promote --to global only
}

const NOTES_TRUNCATE = 40;

/**
 * The canonical whitelist of settable brief field names, derived from the schema
 * so it can never drift from {@link BrandBriefSchema}. This exported constant is
 * the single source of truth other workstreams (WS-03 LLM mapper, WS-05 studio)
 * import to validate a field before writing it. Includes `audiences` (a valid
 * PATCH target); `set` additionally refuses `audiences` because it is structured
 * (see {@link SETTABLE_BRIEF_FIELDS}).
 */
export const BRAND_BRIEF_FIELDS: readonly string[] = Object.keys(
  BrandBriefSchema.removeDefault().shape,
);

/**
 * Brief fields that `set` writes as a single scalar string.
 */
const SCALAR_BRIEF_FIELDS = [
  "oneLiner",
  "problem",
  "positioning",
  "voice",
  "colorIntent",
  "typeIntent",
  "moodImagery",
  "mascot",
  "otherNotes",
] as const;

/**
 * Brief fields that `set` writes as a REPLACEMENT array — a comma-separated value
 * split/trimmed into `string[]` (matching WS-01's wholesale-replace patch
 * semantics). `audiences` is deliberately absent: it is structured
 * (`{ who, context?, need? }[]`) and only writable via `patch`.
 */
const ARRAY_BRIEF_FIELDS = [
  "aliases",
  "neverCallIt",
  "differentiateFrom",
  "tone",
  "values",
  "inspirations",
  "constraints",
  "surfaces",
] as const;

/** Every field `set` accepts (scalar ∪ array; excludes structured `audiences`). */
const SETTABLE_BRIEF_FIELDS: readonly string[] = [
  ...SCALAR_BRIEF_FIELDS,
  ...ARRAY_BRIEF_FIELDS,
];

export interface DirectionCommandResult {
  verb: DirectionVerb;
  id?: string;
  directions?: DirectionRecord[]; // present only for `list`
  entryKind?: MemoryKind; // present only for `feedback`
  subverb?: BriefSubverb; // present only for `brief`
  brief?: BrandBrief; // present for `brief` (the written/read structured brief)
  renderedBrief?: string; // present for `brief show` (the markdown projection)
  proposal?: BriefMapProposal; // present only for `brief map` (the proposed, not-yet-applied diff)
  filesWritten: string[]; // cwd-relative, forward slashes
  contradictionReport?: ContradictionReport; // present for `reconcile` list
  reconcileResult?: ReconciliationResolveResponse; // present for `reconcile` resolve
  memoryEntries?: MemoryEntry[]; // present only for `memory` (READ)
  memoryAction?: MemoryAction; // present only for `memory` (WRITE: edit | promote | delete)
  memoryActionResult?: MemoryLifecycleResult; // present only for `memory` (WRITE)
  status?: DirectionStatusProjection; // present only for `status`
}

export interface RuleCommandResult {
  verb: "add" | "remove" | "edit";
  rule: GlobalRule; // the rule as it stands after the write (added / edited / retired)
  filesWritten: string[];
}

export interface PromoteCommandResult {
  fromDirectionId: string;
  rule: GlobalRule; // the promoted rule (source = promote:<id>)
  filesWritten: string[];
}

function relTo(cwd: string): (abs: string) => string {
  const resolved = path.resolve(cwd);
  return (abs: string): string =>
    path.relative(resolved, abs).split(path.sep).join("/");
}

export async function runDirection(opts: {
  cwd: string;
  verb: string;
  id?: string;
  name?: string;
  from?: string;
  note?: string;
  body?: string;
  kind?: string;
  author?: string;
  source?: string;
  force?: boolean;
  channel?: string;
  polarity?: string;
  // NEW for the `brief` verb (deterministic, keyless field writes):
  subverb?: string; // "show" | "set" | "patch" | "map"
  field?: string; // for `set`
  value?: string; // for `set` (raw string; array fields comma-split downstream)
  json?: string; // for `patch` (a BrandBriefPatch JSON string)
  freeform?: string; // for `map` (the natural-language ramble to propose from)
  apply?: boolean; // for `map` (write the proposal; without it, propose only)
  // NEW for the `reconcile` verb:
  contradictionId?: string;
  action?: string;
  winner?: string;
  severity?: string;
  expectedMemoryVersion?: number;
  expectedGlobalVersion?: number;
  // NEW for `direction memory <edit|promote|delete>` (WS-04): the disambiguated
  // memory sub-action, the target entry id, promote's rung target, and delete's
  // reason. `severity`/`expectedGlobalVersion`/`expectedMemoryVersion`/`force`/
  // `body`/`channel`/`polarity`/`author`/`source` above are reused as-is.
  memoryAction?: string; // "edit" | "promote" | "delete"
  entryId?: string;
  to?: string; // promote target: "global"
  reason?: string; // delete only
  // NEW for `direction list` (WS-05, R-7): reveal archived records.
  includeArchived?: boolean;
}): Promise<DirectionCommandResult> {
  const verb = opts.verb as DirectionVerb;
  if (!RUN_DIRECTION_VERBS.includes(verb)) {
    throw new CommandError(
      `Unknown direction verb: ${opts.verb}. Valid verbs: ${DIRECTION_VERBS.join(", ")}.`,
    );
  }

  // --- Arg-coupling validation ---
  if (verb !== "list" && !opts.id) {
    throw new CommandError(
      `direction ${verb} requires a direction id.\nUsage: keyart direction ${verb} <id>`,
    );
  }
  if (verb === "list" && opts.id) {
    throw new CommandError(
      "direction list takes no id argument.\nUsage: keyart direction list",
    );
  }
  if (opts.from !== undefined && verb !== "new") {
    throw new CommandError(
      "--from is only valid with: direction new <id> --from <directionId>, or direction create '<json>' --from <directionId>",
    );
  }
  if (opts.note !== undefined && verb !== "reject") {
    throw new CommandError(
      "--note is only valid with: direction reject <id> --note <text>",
    );
  }
  if (opts.body !== undefined && verb !== "feedback" && verb !== "memory") {
    throw new CommandError(
      "--body is only valid with: direction feedback <id> --body <text>, or direction memory edit <id> <entryId> --body <text>",
    );
  }
  if (opts.kind !== undefined && verb !== "feedback") {
    throw new CommandError(
      "--kind is only valid with: direction feedback <id> --body <text> --kind feedback|learning|decision",
    );
  }
  if (
    (opts.subverb !== undefined ||
      opts.field !== undefined ||
      opts.value !== undefined ||
      opts.json !== undefined ||
      opts.freeform !== undefined ||
      opts.apply === true) &&
    verb !== "brief"
  ) {
    throw new CommandError(
      "brief subverb/field/value/json/freeform/apply are only valid with: direction brief <show|set|patch|map> <id> …",
    );
  }
  if (
    (opts.channel !== undefined || opts.polarity !== undefined) &&
    verb !== "feedback" &&
    verb !== "memory"
  ) {
    throw new CommandError(
      "--channel/--polarity are only valid with: direction feedback <id> --body <text> [--channel visual|copy|both] [--polarity prefer|avoid], or direction memory edit <id> <entryId> [--channel …] [--polarity …]",
    );
  }
  if (opts.entryId !== undefined && verb !== "memory") {
    throw new CommandError(
      "An entryId is only valid with: direction memory edit|promote|delete <id> <entryId> …",
    );
  }
  if (opts.to !== undefined && verb !== "memory") {
    throw new CommandError(
      "--to is only valid with: direction memory promote <id> <entryId> --to global",
    );
  }
  if (opts.reason !== undefined && verb !== "memory") {
    throw new CommandError(
      "--reason is only valid with: direction memory delete <id> <entryId> --reason <text>",
    );
  }

  const config = await loadConfig(opts.cwd);
  const cwd = path.resolve(opts.cwd);
  const rel = relTo(cwd);
  const core = createDirectionCore(cwd, config);
  const author = opts.author ?? "cli";
  const source = opts.source ?? "cli";

  switch (verb) {
    case "new":
      return directionNewVerb({ cwd, config, id: opts.id!, name: opts.name, from: opts.from, rel });
    case "list":
      return directionListVerb({ cwd, config, includeArchived: opts.includeArchived });
    case "status": {
      // Read-only projection off the SAME record `direction show` reads; the
      // draft predicate is WS-15's (zero versions ⇔ head === null). Writes nothing.
      const resolved = await resolveDirection(cwd, config, opts.id!);
      const projection: DirectionStatusProjection = {
        id: resolved.record.id,
        status: resolved.record.status,
        isDraft: resolved.record.head === null,
        head: resolved.record.head,
        versionCount: resolved.record.versions.length,
      };
      console.log(
        `${projection.id}: ${projection.status}${projection.isDraft ? " (draft — no versions yet)" : ` (head ${projection.head}, ${projection.versionCount} version${projection.versionCount === 1 ? "" : "s"})`}`,
      );
      return { verb, id: opts.id, status: projection, filesWritten: [] };
    }
    case "archive": {
      // Non-destructive (R-5): the record and its whole tree stay on disk;
      // reversible via `revive`. Refuses the approved pointer's direction.
      const resolved = await resolveDirection(cwd, config, opts.id!);
      const pointer = (await createBrandCore(cwd, config).read()).approvedPointer;
      if (pointer?.directionId === opts.id) {
        throw new CommandError(
          `Direction "${opts.id}" is the approved direction — approve a different direction first, then archive this one.`,
        );
      }
      void resolved;
      await core.transition(opts.id!, "archive", { force: opts.force });
      const filesWritten = [
        rel(path.join(directionsRoot(cwd, config), opts.id!, "direction.yaml")),
      ];
      console.log(
        `Archived: direction ${opts.id} archived; nothing physically removed.`,
      );
      return { verb, id: opts.id, filesWritten };
    }
    case "reject":
    case "park":
    case "revive": {
      await core.transition(opts.id!, verb, { force: opts.force });
      const filesWritten = [rel(path.join(directionsRoot(cwd, config), opts.id!, "direction.yaml"))];
      if (verb === "reject" && opts.note !== undefined) {
        await core.appendDecision(
          opts.id!,
          { body: opts.note, author, source },
          { force: opts.force },
        );
        filesWritten.push(
          rel(path.join(directionsRoot(cwd, config), opts.id!, "memory.yaml")),
        );
      }
      const past =
        verb === "reject" ? "rejected" : verb === "park" ? "parked" : "active";
      console.log(
        `Direction "${opts.id}" is now ${past}.${opts.note ? ` Note: ${opts.note}` : ""}`,
      );
      return { verb, id: opts.id, filesWritten };
    }
    case "feedback": {
      if (opts.body === undefined) {
        throw new CommandError(
          `direction feedback requires a body.\nUsage: keyart direction feedback <id> "<body>" [--kind feedback|learning|decision]`,
        );
      }
      const kind = (opts.kind ?? "feedback") as MemoryKind;
      if (!MEMORY_KINDS.includes(kind)) {
        throw new CommandError(
          `Invalid memory kind: ${opts.kind}. Valid kinds: feedback, learning, decision.`,
        );
      }
      const channel = opts.channel as DirectiveChannel | undefined;
      if (channel !== undefined && !DIRECTIVE_CHANNELS.includes(channel)) {
        throw new CommandError(
          `Invalid channel: ${opts.channel}. Valid channels: visual, copy, both.`,
        );
      }
      const polarity = opts.polarity as DirectivePolarity | undefined;
      if (polarity !== undefined && !DIRECTIVE_POLARITIES.includes(polarity)) {
        throw new CommandError(
          `Invalid polarity: ${opts.polarity}. Valid polarities: prefer, avoid.`,
        );
      }
      const entry = {
        body: opts.body,
        author,
        source,
        ...(channel ? { channel } : {}),
        ...(polarity ? { polarity } : {}),
      };
      // Appending to a missing direction throws (isolation invariant) and writes nothing.
      if (kind === "feedback") {
        await core.appendFeedback(opts.id!, entry, { force: opts.force });
      } else if (kind === "learning") {
        await core.appendLearning(opts.id!, entry, { force: opts.force });
      } else {
        await core.appendDecision(opts.id!, entry, { force: opts.force });
      }
      const memPath = rel(
        path.join(directionsRoot(cwd, config), opts.id!, "memory.yaml"),
      );
      console.log(`Recorded ${kind} on direction "${opts.id}" (by ${author}).`);
      return {
        verb,
        id: opts.id,
        entryKind: kind,
        filesWritten: [memPath],
      };
    }
    case "memory": {
      // WRITE: `direction memory <edit|promote|delete> <id> <entryId> …` — the
      // disambiguation is resolved by the caller (CLI/MCP) into `memoryAction`;
      // the READ path below stays byte-identical when it is absent.
      if (opts.memoryAction !== undefined) {
        return directionMemoryLifecycle({ core, cwd, config, rel, author, source, opts });
      }
      // Reads exactly ONE direction — never a sibling (isolation invariant). Scope
      // is now structural (a direction's memory.yaml only ever holds its own
      // entries), so there is nothing left to filter.
      const entries = await core.memoryEntries(opts.id!);
      console.log(formatMemoryEntries(opts.id!, entries));
      return { verb, id: opts.id, memoryEntries: entries, filesWritten: [] };
    }
    case "brief":
      return directionBrief({ core, cwd, config, rel, author, source, opts });
    case "reconcile": {
      const directionId = opts.id!;
      const brandCore = createBrandCore(cwd, config);

      if (!opts.action) {
        // List-only: return the contradiction report + current versions.
        const [report, mem, global] = await Promise.all([
          core.listContradictions(directionId),
          core.readMemory(directionId),
          brandCore.read(),
        ]);
        console.log(
          `Contradictions for direction "${directionId}": ${report.items.length} item(s) (detector: ${report.detector}).`,
        );
        return { verb, id: directionId, contradictionReport: report, filesWritten: [] };
      }

      // Resolve: find the contradiction in the current report and run the orchestrator.
      const report = await core.listContradictions(directionId);
      const contradiction = report.items.find((c) => c.id === opts.contradictionId);
      if (!contradiction) {
        throw new CommandError(
          `Contradiction "${opts.contradictionId}" not found on direction "${directionId}". ` +
            `Run \`keyart direction reconcile ${directionId}\` to list current contradictions.`,
        );
      }
      const resolveResult = await runReconcileResolve({
        cwd,
        directionId,
        contradiction,
        action: opts.action as ReconcileAction,
        winner: (opts.winner as "subject" | "conflictsWith") ?? "subject",
        severity: opts.severity as RuleSeverity | undefined,
        expectedMemoryVersion: opts.expectedMemoryVersion,
        expectedGlobalVersion: opts.expectedGlobalVersion,
        force: opts.force,
        author,
        source,
      });
      const memPath = rel(
        path.join(directionsRoot(cwd, config), directionId, "memory.yaml"),
      );
      const filesWritten = [memPath];
      console.log(
        `Reconciled contradiction "${opts.contradictionId}" on direction "${directionId}" (action: ${opts.action}).`,
      );
      return { verb, id: directionId, reconcileResult: resolveResult, filesWritten };
    }
  }
}

/**
 * `direction memory <edit|promote|delete> <id> <entryId> …` — the post-hoc
 * memory-lifecycle write actions (WS-04). Orchestrates ONLY: reads the source
 * entry when needed and routes to the WS-02 core method (`editMemoryEntry` /
 * `deleteMemoryEntry`) or the WS-03 `promoteEntryToGlobal` seam (the only
 * promote rung left — direction→global) — it never reimplements lifecycle
 * logic. Keyless throughout (pure filesystem writes, no model call on any path).
 */
async function directionMemoryLifecycle(args: {
  core: ReturnType<typeof createDirectionCore>;
  cwd: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  rel: (abs: string) => string;
  author: string;
  source: string;
  opts: {
    id?: string;
    memoryAction?: string;
    entryId?: string;
    to?: string;
    reason?: string;
    body?: string;
    channel?: string;
    polarity?: string;
    severity?: string;
    expectedMemoryVersion?: number;
    expectedGlobalVersion?: number;
    force?: boolean;
  };
}): Promise<DirectionCommandResult> {
  const { core, cwd, config, rel, author, source, opts } = args;
  const id = opts.id!;

  if (!MEMORY_ACTIONS.includes(opts.memoryAction as MemoryAction)) {
    throw new CommandError(
      `Unknown memory action: ${opts.memoryAction}. Valid actions: edit, promote, delete.\n` +
        `Usage: keyart direction memory <edit|promote|delete> <id> <entryId> …`,
    );
  }
  const action = opts.memoryAction as MemoryAction;

  if (opts.entryId === undefined || opts.entryId === "") {
    throw new CommandError(
      `direction memory ${action} requires an entry id.\n` +
        `Usage: keyart direction memory ${action} ${id} <entryId> …`,
    );
  }
  const entryId = opts.entryId;

  // --- Arg-coupling validation (mirrors runDirection's top-level rigor). ---
  if (opts.to !== undefined && action !== "promote") {
    throw new CommandError(
      "--to is only valid with: direction memory promote <id> <entryId> --to global",
    );
  }
  if (action === "promote" && opts.to === undefined) {
    throw new CommandError(
      `direction memory promote requires --to global.\n` +
        `Usage: keyart direction memory promote ${id} ${entryId} --to global`,
    );
  }
  const to = opts.to as PromoteTarget | undefined;
  if (to !== undefined && !PROMOTE_TARGETS.includes(to)) {
    throw new CommandError(
      `Invalid --to: ${opts.to}. Valid promote targets: global.`,
    );
  }
  if (opts.body !== undefined && action !== "edit") {
    throw new CommandError(
      "--body is only valid with: direction memory edit <id> <entryId> --body <text>",
    );
  }
  if (action === "edit" && (opts.body === undefined || opts.body === "")) {
    throw new CommandError(
      `direction memory edit requires --body <text>.\n` +
        `Usage: keyart direction memory edit ${id} ${entryId} --body "<text>"`,
    );
  }
  if (opts.reason !== undefined && action !== "delete") {
    throw new CommandError(
      "--reason is only valid with: direction memory delete <id> <entryId> --reason <text>",
    );
  }
  if ((opts.channel !== undefined || opts.polarity !== undefined) && action !== "edit") {
    throw new CommandError(
      "--channel/--polarity are only valid with: direction memory edit <id> <entryId> [--channel visual|copy|both] [--polarity prefer|avoid]",
    );
  }
  const promotingToGlobal = action === "promote" && to === "global";
  if (opts.severity !== undefined && !promotingToGlobal) {
    throw new CommandError(
      "--severity is only valid with: direction memory promote <id> <entryId> --to global --severity hard|guideline",
    );
  }
  if (opts.expectedGlobalVersion !== undefined && !promotingToGlobal) {
    throw new CommandError(
      "--expected-global-version is only valid with: direction memory promote <id> <entryId> --to global",
    );
  }

  const channel = opts.channel as DirectiveChannel | undefined;
  if (channel !== undefined && !DIRECTIVE_CHANNELS.includes(channel)) {
    throw new CommandError(
      `Invalid channel: ${opts.channel}. Valid channels: visual, copy, both.`,
    );
  }
  const polarity = opts.polarity as DirectivePolarity | undefined;
  if (polarity !== undefined && !DIRECTIVE_POLARITIES.includes(polarity)) {
    throw new CommandError(
      `Invalid polarity: ${opts.polarity}. Valid polarities: prefer, avoid.`,
    );
  }
  const severity = opts.severity as RuleSeverity | undefined;
  if (severity !== undefined && !RULE_SEVERITIES.includes(severity)) {
    throw new CommandError(
      `Invalid severity: ${opts.severity}. Valid severities: hard, guideline.`,
    );
  }

  const memPath = rel(path.join(directionsRoot(cwd, config), id, "memory.yaml"));

  switch (action) {
    case "edit": {
      const mem = await core.editMemoryEntry(
        id,
        { entryId, body: opts.body, channel, polarity, author, source },
        { expectedVersion: opts.expectedMemoryVersion, force: opts.force },
      );
      console.log(`Edited memory entry "${entryId}" on direction "${id}" (superseded).`);
      return {
        verb: "memory",
        id,
        memoryAction: action,
        memoryActionResult: { action, directionId: id, entryId, memoryVersion: mem.version },
        filesWritten: [memPath],
      };
    }

    case "delete": {
      const mem = await core.deleteMemoryEntry(
        id,
        { entryId, reason: opts.reason, author, source },
        { expectedVersion: opts.expectedMemoryVersion, force: opts.force },
      );
      console.log(`Deleted (retired) memory entry "${entryId}" on direction "${id}".`);
      return {
        verb: "memory",
        id,
        memoryAction: action,
        memoryActionResult: { action, directionId: id, entryId, memoryVersion: mem.version },
        filesWritten: [memPath],
      };
    }

    case "promote": {
      // `--to global` is the only rung left (up-only, direction→global): WS-03's
      // `promoteEntryToGlobal` seam. This WS owns reading the source entry
      // (isolation: ONE direction, never a sibling) and rejecting a
      // missing/already-retired one; the seam owns the promote+retire ordering.
      const entries = await core.memoryEntries(id);
      const entry = entries.find((e) => e.id === entryId);
      if (!entry) {
        throw new CommandError(
          `Memory entry "${entryId}" not found or already retired on direction "${id}".`,
        );
      }
      const brandPath = rel(globalBrandPath(cwd, config));
      const result = await promoteEntryToGlobal(
        { cwd, config },
        {
          directionId: id,
          entry: { id: entry.id, body: entry.body, channel: entry.channel, polarity: entry.polarity },
          severity,
          author,
          source,
          expectedMemoryVersion: opts.expectedMemoryVersion,
          expectedGlobalVersion: opts.expectedGlobalVersion,
          force: opts.force,
        },
      );
      console.log(
        `Promoted memory entry "${entryId}" on direction "${id}" to a global rule (${result.ruleId}).`,
      );
      return {
        verb: "memory",
        id,
        memoryAction: action,
        memoryActionResult: {
          action,
          directionId: id,
          entryId,
          to: "global",
          memoryVersion: result.memoryVersion,
          globalVersion: result.globalVersion,
        },
        filesWritten: [memPath, brandPath],
      };
    }
  }
}

async function directionBrief(args: {
  core: ReturnType<typeof createDirectionCore>;
  cwd: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  rel: (abs: string) => string;
  author: string;
  source: string;
  opts: {
    id?: string;
    subverb?: string;
    field?: string;
    value?: string;
    json?: string;
    freeform?: string;
    apply?: boolean;
    force?: boolean;
  };
}): Promise<DirectionCommandResult> {
  const { core, cwd, config, rel, author, source, opts } = args;
  const id = opts.id!; // presence enforced by the caller's id-coupling check

  const subverb = opts.subverb;
  if (subverb === undefined) {
    throw new CommandError(
      `direction brief requires a subverb.\nUsage: keyart direction brief <show|set|patch> ${id} …`,
    );
  }
  if (!BRIEF_SUBVERBS.includes(subverb as BriefSubverb)) {
    throw new CommandError(
      `Unknown brief subverb: ${subverb}. Valid subverbs: show, set, patch.`,
    );
  }
  const sv: BriefSubverb = subverb as BriefSubverb;

  const directionDir = path.join(directionsRoot(cwd, config), id);
  const directionYaml = rel(path.join(directionDir, "direction.yaml"));
  const briefMd = rel(path.join(directionDir, "brief.md"));
  const memoryYaml = rel(path.join(directionDir, "memory.yaml"));

  if (sv === "map") {
    return directionBriefMap({
      core,
      id,
      model: config.models.text,
      author,
      source,
      freeform: opts.freeform,
      apply: opts.apply === true,
      force: opts.force,
      paths: { directionYaml, briefMd, memoryYaml },
    });
  }

  if (sv === "show") {
    // Read-only: dump the structured fields + the rendered markdown projection.
    const brief = await core.getBrief(id);
    const rendered = await core.getRenderedBrief(id);
    console.log(formatBriefFields(id, brief));
    console.log("");
    console.log(rendered);
    return {
      verb: "brief",
      id,
      subverb: sv,
      brief,
      renderedBrief: rendered,
      filesWritten: [],
    };
  }

  if (sv === "set") {
    const field = opts.field;
    if (field === undefined || field === "" || opts.value === undefined) {
      throw new CommandError(
        `direction brief set requires a field and a value.\nUsage: keyart direction brief set ${id} <field> <value…>`,
      );
    }
    const patch = buildSetPatch(field, opts.value);
    const next = await core.setBriefFields(id, patch, { force: opts.force });
    console.log(`Set ${field} on direction "${id}" (brief v${next.version}).`);
    return {
      verb: "brief",
      id,
      subverb: sv,
      brief: next.brief,
      filesWritten: [directionYaml, briefMd],
    };
  }

  // sv === "patch"
  const jsonStr = opts.json;
  if (jsonStr === undefined || jsonStr === "") {
    throw new CommandError(
      `direction brief patch requires a JSON patch.\nUsage: keyart direction brief patch ${id} '{"tone":["warm","confident"]}'`,
    );
  }
  const patch = parseBriefPatch(jsonStr);
  const next = await core.patchBrief(id, patch, { force: opts.force });
  console.log(`Patched brief on direction "${id}" (brief v${next.version}).`);
  return {
    verb: "brief",
    id,
    subverb: sv,
    brief: next.brief,
    filesWritten: [directionYaml, briefMd],
  };
}

/**
 * The OPTIONAL `brief map [--apply]` subverb — the ONE brief verb that CAN use
 * the model. It reads the current brief, calls the pure {@link proposeBriefPatch}
 * mapper, and then:
 * - WITHOUT `--apply`: prints the proposed field diff + hex-lock suggestions and
 *   writes NOTHING (the LLM proposes; the user disposes). A dry-run/no-key run
 *   prints a clear keyless message.
 * - WITH `--apply`: applies the (non-empty) field patch via `core.patchBrief`
 *   (WS-01 core) and routes EACH hex to `core.recordColorLock` — so a typed hex
 *   becomes a `decision` memory entry (`Color locked: #rrggbb`), NEVER a brief
 *   field (SC-06). Reports the files actually written.
 */
async function directionBriefMap(args: {
  core: ReturnType<typeof createDirectionCore>;
  id: string;
  model: string;
  author: string;
  source: string;
  freeform?: string;
  apply: boolean;
  force?: boolean;
  paths: { directionYaml: string; briefMd: string; memoryYaml: string };
}): Promise<DirectionCommandResult> {
  const { core, id, model, author, source, apply, force, paths } = args;

  const freeform = args.freeform;
  if (freeform === undefined || freeform.trim() === "") {
    throw new CommandError(
      `direction brief map requires freeform text.\nUsage: keyart direction brief map ${id} "<freeform…>" [--apply]`,
    );
  }

  const current = await core.getBrief(id);
  const proposal = await proposeBriefPatch({ model, freeform, current });

  if (!apply) {
    // Propose only — print the preview and write NOTHING.
    console.log(formatBriefMapProposal(id, current, proposal));
    return {
      verb: "brief",
      id,
      subverb: "map",
      brief: current,
      proposal,
      filesWritten: [],
    };
  }

  // --apply: write the field patch (WS-01 core) + route hexes to locks.
  const filesWritten: string[] = [];
  const patchKeys = Object.keys(proposal.patch);
  let brief = current;
  if (patchKeys.length > 0) {
    const next = await core.patchBrief(id, proposal.patch, { force });
    brief = next.brief;
    filesWritten.push(paths.directionYaml, paths.briefMd);
  }
  for (const lock of proposal.hexLocks) {
    await core.recordColorLock(
      id,
      { hex: lock.hex, author, source, note: lock.note },
      { force },
    );
  }
  if (proposal.hexLocks.length > 0) {
    filesWritten.push(paths.memoryYaml);
  }

  const parts: string[] = [];
  if (patchKeys.length > 0) {
    parts.push(`applied ${patchKeys.length} brief field(s)`);
  }
  if (proposal.hexLocks.length > 0) {
    parts.push(`locked ${proposal.hexLocks.length} color(s)`);
  }
  console.log(
    parts.length > 0
      ? `Brief map on direction "${id}": ${parts.join(", ")}.`
      : `Brief map on direction "${id}": nothing to apply.`,
  );

  return {
    verb: "brief",
    id,
    subverb: "map",
    brief,
    proposal,
    filesWritten,
  };
}

/** A readable preview of a proposed brief map: the keyless notice (when dry-run),
 * the proposed field diff (old → new per key), and the hex-lock suggestions. */
function formatBriefMapProposal(
  id: string,
  current: BrandBrief,
  proposal: BriefMapProposal,
): string {
  const lines = [`Proposed brief map for direction "${id}" (nothing written):`];

  if (proposal.dryRun) {
    lines.push(
      "  Ran without an OPENAI_API_KEY — no field mapping proposed.",
      "  Paste a hex to still get a lock suggestion; edit fields directly with",
      "  `direction brief set <id> <field> <value>` / `direction brief patch <id> '<json>'`.",
    );
  }

  const patchKeys = Object.keys(proposal.patch);
  if (patchKeys.length > 0) {
    lines.push("", "  Proposed field changes (soft intent — not yet applied):");
    for (const key of patchKeys) {
      const before = formatFieldValue((current as Record<string, unknown>)[key]);
      const after = formatFieldValue((proposal.patch as Record<string, unknown>)[key]);
      lines.push(`    ${key}: ${before} → ${after}`);
    }
  } else if (!proposal.dryRun) {
    lines.push("", "  No field changes proposed.");
  }

  if (proposal.hexLocks.length > 0) {
    lines.push(
      "",
      "  Hex → color-lock suggestions (locked in memory on --apply, NEVER a brief field):",
    );
    for (const lock of proposal.hexLocks) {
      lines.push(`    ${lock.hex}${lock.note ? ` (${lock.note})` : ""}`);
    }
  }

  if (proposal.notes) {
    lines.push("", `  Notes: ${proposal.notes}`);
  }

  lines.push("", "  Re-run with --apply to write these changes.");
  return lines.join("\n");
}

/**
 * Builds a one-key {@link BrandBriefPatch} from a `set` field/value pair. Scalar
 * fields keep the raw string; array fields comma-split (trim + drop empties) into
 * a REPLACEMENT array. Rejects `audiences` (structured — use `patch`) and any
 * unknown field, naming the valid settable fields.
 */
function buildSetPatch(field: string, value: string): BrandBriefPatch {
  if (field === "audiences") {
    throw new CommandError(
      `"audiences" is structured ({ who, context?, need? }[]) and cannot be set as a flat value. ` +
        `Use: direction brief patch <id> '{"audiences":[{"who":"solo founders","need":"credibility"}]}'.`,
    );
  }
  if ((ARRAY_BRIEF_FIELDS as readonly string[]).includes(field)) {
    const arr = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return { [field]: arr } as BrandBriefPatch;
  }
  if ((SCALAR_BRIEF_FIELDS as readonly string[]).includes(field)) {
    return { [field]: value } as BrandBriefPatch;
  }
  throw new CommandError(
    `Unknown brief field "${field}". Settable fields: ${SETTABLE_BRIEF_FIELDS.join(", ")}. ` +
      `(audiences is structured — write it with \`direction brief patch\`.)`,
  );
}

/**
 * Parses + validates a `patch` JSON string into a {@link BrandBriefPatch}: rejects
 * malformed JSON, a non-object payload, and any unknown key (naming the valid
 * fields). Value-type validation is left to `core.patchBrief` (which re-parses the
 * merged brief through the schema).
 */
function parseBriefPatch(json: string): BrandBriefPatch {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new CommandError(
      `Invalid JSON for direction brief patch: ${(err as Error).message}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CommandError(
      `direction brief patch expects a JSON object of brief fields. Valid fields: ${BRAND_BRIEF_FIELDS.join(", ")}.`,
    );
  }
  const unknown = Object.keys(raw).filter(
    (k) => !BRAND_BRIEF_FIELDS.includes(k),
  );
  if (unknown.length > 0) {
    throw new CommandError(
      `Unknown brief field(s): ${unknown.join(", ")}. Valid fields: ${BRAND_BRIEF_FIELDS.join(", ")}.`,
    );
  }
  return raw as BrandBriefPatch;
}

/** A readable, deterministic key/value dump of every structured brief field. */
function formatBriefFields(id: string, brief: BrandBrief): string {
  const lines = [`Structured brief for direction "${id}":`];
  for (const field of BRAND_BRIEF_FIELDS) {
    const val = (brief as Record<string, unknown>)[field];
    lines.push(`  ${field}: ${formatFieldValue(val)}`);
  }
  return lines.join("\n");
}

function formatFieldValue(val: unknown): string {
  if (val === undefined || val === null) return "—";
  if (Array.isArray(val)) {
    if (val.length === 0) return "—";
    return val
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join(", ");
  }
  if (typeof val === "string") return val.trim() === "" ? "—" : val;
  return JSON.stringify(val);
}

async function directionNewVerb(opts: {
  cwd: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  id: string;
  name?: string;
  from?: string;
  rel: (abs: string) => string;
}): Promise<DirectionCommandResult> {
  const { cwd, config, id, name, from, rel } = opts;

  if (!DIRECTION_SLUG_RE.test(id)) {
    throw new CommandError(
      `Invalid direction id "${id}". Direction ids must be kebab-case (lowercase letters, digits, single hyphens), e.g. "moody-editorial".`,
    );
  }

  // Seed the brief: fork from another direction's brief, or use the blank template.
  let briefContent: string;
  if (from !== undefined) {
    const source = await resolveDirection(cwd, config, from);
    briefContent = await readTextFile(source.briefPath);
  } else {
    briefContent = await fs.readFile(
      path.join(TEMPLATES_DIR, "brief.md"),
      "utf-8",
    );
  }

  // core.create writes direction.yaml + memory.yaml (and enforces slug + uniqueness).
  const core = createDirectionCore(cwd, config);
  await core.create({ id, name: name ?? id });

  const directionDir = path.join(directionsRoot(cwd, config), id);
  const briefPath = path.join(directionDir, "brief.md");
  await writeTextFile(briefPath, briefContent);
  await ensureDir(path.join(directionDir, "runs"));

  const directionYaml = rel(path.join(directionDir, "direction.yaml"));
  const memoryYaml = rel(path.join(directionDir, "memory.yaml"));
  const briefRel = rel(briefPath);

  console.log(`  ✓ ${directionYaml}`);
  console.log(`  ✓ ${memoryYaml}`);
  console.log(`  ✓ ${briefRel}`);
  console.log("");
  console.log(
    `Direction "${id}" created. Edit ${briefRel} to describe this direction.`,
  );

  return {
    verb: "new",
    id,
    filesWritten: [directionYaml, memoryYaml, briefRel],
  };
}

async function directionListVerb(opts: {
  cwd: string;
  config: Awaited<ReturnType<typeof loadConfig>>;
  includeArchived?: boolean;
}): Promise<DirectionCommandResult> {
  const { cwd, config, includeArchived } = opts;

  const core = createDirectionCore(cwd, config);
  // R-7: archived records hide by default — the same predicate shape
  // memoryEntries uses for retired entries.
  const directions = (await core.list()).filter(
    (record) => includeArchived === true || record.status !== "archived",
  );

  if (directions.length === 0) {
    console.log(
      "No directions yet. Run `keyart direction new <id>` to create one.",
    );
    return { verb: "list", directions, filesWritten: [] };
  }

  const notesFor = await Promise.all(
    directions.map(async (c) => {
      const entries = await core.memoryEntries(c.id);
      const last = entries[entries.length - 1];
      return last ? last.body : undefined;
    }),
  );

  const idWidth = Math.max("ID".length, ...directions.map((c) => c.id.length));
  const statusWidth = Math.max(
    "STATUS".length,
    ...directions.map((c) => c.status.length),
  );
  const verWidth = Math.max(
    "VER".length,
    ...directions.map((c) => String(c.version).length),
  );

  console.log(
    `${"ID".padEnd(idWidth)}  ${"STATUS".padEnd(statusWidth)}  ${"VER".padEnd(verWidth)}  NOTES`,
  );
  directions.forEach((c, i) => {
    console.log(
      `${c.id.padEnd(idWidth)}  ${c.status.padEnd(statusWidth)}  ${String(c.version).padEnd(verWidth)}  ${formatNotes(notesFor[i])}`,
    );
  });

  return { verb: "list", directions, filesWritten: [] };
}

function formatNotes(notes?: string): string {
  if (!notes) return "—";
  if (notes.length > NOTES_TRUNCATE) {
    return notes.slice(0, NOTES_TRUNCATE) + "…";
  }
  return notes;
}

function formatMemoryEntries(id: string, entries: MemoryEntry[]): string {
  if (entries.length === 0) {
    return `No memory entries for direction "${id}".`;
  }
  const count = entries.length;
  const lines = [
    `Memory for direction "${id}" (${count} entr${count === 1 ? "y" : "ies"}):`,
  ];
  for (const e of entries) {
    lines.push(`  ${e.kind}: ${formatNotes(e.body)}`);
  }
  return lines.join("\n");
}

export async function runRule(opts: {
  cwd: string;
  verb: string;
  text?: string;
  severity?: string;
  author?: string;
  source?: string;
  force?: boolean;
  channel?: string;
  polarity?: string;
  // NEW for `rule remove` / `rule edit` (WS-04): the rule addressed, its
  // replacement body (mapped onto the rule's `text` field), and the optimistic
  // concurrency guard. `severity`/`force`/`author`/`source` above are reused.
  ruleId?: string;
  body?: string;
  expectedVersion?: number;
}): Promise<RuleCommandResult> {
  const verb = opts.verb;
  if (verb !== "add" && verb !== "remove" && verb !== "edit") {
    throw new CommandError(
      `Unknown rule verb: ${opts.verb}. Valid verbs: add, remove, edit.`,
    );
  }

  const config = await loadConfig(opts.cwd);
  const cwd = path.resolve(opts.cwd);
  const rel = relTo(cwd);
  const brand = createBrandCore(cwd, config);
  const brandPath = rel(globalBrandPath(cwd, config));
  const author = opts.author ?? "cli";
  const source = opts.source ?? "cli";

  if (verb === "add") {
    const text = opts.text;
    if (text === undefined || text === "") {
      throw new CommandError(
        `rule add requires the rule text.\nUsage: keyart rule add "<text>" [--severity hard|guideline]`,
      );
    }
    const severity = (opts.severity ?? "guideline") as RuleSeverity;
    if (!RULE_SEVERITIES.includes(severity)) {
      throw new CommandError(
        `Invalid severity: ${opts.severity}. Valid severities: hard, guideline.`,
      );
    }
    const channel = opts.channel as DirectiveChannel | undefined;
    if (channel !== undefined && !DIRECTIVE_CHANNELS.includes(channel)) {
      throw new CommandError(
        `Invalid channel: ${opts.channel}. Valid channels: visual, copy, both.`,
      );
    }
    const polarity = opts.polarity as DirectivePolarity | undefined;
    if (polarity !== undefined && !DIRECTIVE_POLARITIES.includes(polarity)) {
      throw new CommandError(
        `Invalid polarity: ${opts.polarity}. Valid polarities: prefer, avoid.`,
      );
    }

    const next = await brand.addRule(
      { severity, text, author, source, channel, polarity },
      { force: opts.force },
    );
    const rule = next.rules[next.rules.length - 1];
    console.log(`Added ${severity} global rule: ${text}`);
    return { verb: "add", rule, filesWritten: [brandPath] };
  }

  if (opts.ruleId === undefined || opts.ruleId === "") {
    throw new CommandError(
      `rule ${verb} requires a rule id.\nUsage: keyart rule ${verb} <ruleId>${verb === "edit" ? ' --body "<text>" [--severity hard|guideline]' : ""} [--force] [--expected-version <n>]`,
    );
  }

  if (verb === "remove") {
    // The HARD-rule force gate lives in WS-03's `removeRule` (throws `CommandError`
    // without `force`); this WS just surfaces that error message.
    const next = await brand.removeRule(opts.ruleId, {
      force: opts.force,
      expectedVersion: opts.expectedVersion,
    });
    const rule = next.rules.find((r) => r.id === opts.ruleId)!;
    console.log(`Removed global rule "${opts.ruleId}" (retired).`);
    return { verb: "remove", rule, filesWritten: [brandPath] };
  }

  // verb === "edit"
  if (
    (opts.body === undefined || opts.body === "") &&
    opts.severity === undefined
  ) {
    throw new CommandError(
      `rule edit requires --body and/or --severity.\nUsage: keyart rule edit <ruleId> --body "<text>" [--severity hard|guideline]`,
    );
  }
  const severity = opts.severity as RuleSeverity | undefined;
  if (severity !== undefined && !RULE_SEVERITIES.includes(severity)) {
    throw new CommandError(
      `Invalid severity: ${opts.severity}. Valid severities: hard, guideline.`,
    );
  }
  // A `GlobalRule` carries `text`, not `body` — the CLI/MCP `--body` flag maps
  // onto the rule's `text` field. A hard-severity change is gated by WS-03's
  // `editRule`; this WS just surfaces that error.
  const next = await brand.editRule(
    opts.ruleId,
    { text: opts.body, severity },
    { force: opts.force, expectedVersion: opts.expectedVersion },
  );
  const rule = next.rules[next.rules.length - 1];
  console.log(`Edited global rule "${opts.ruleId}".`);
  return { verb: "edit", rule, filesWritten: [brandPath] };
}

export async function runPromote(opts: {
  cwd: string;
  directionId?: string;
  text?: string;
  entryId?: string;
  severity?: string;
  author?: string;
  force?: boolean;
}): Promise<PromoteCommandResult> {
  const directionId = opts.directionId;
  if (!directionId) {
    throw new CommandError(
      `promote requires a direction id.\nUsage: keyart promote <directionId> "<text>" | --entry <id>`,
    );
  }
  const severity = (opts.severity ?? "guideline") as RuleSeverity;
  if (!RULE_SEVERITIES.includes(severity)) {
    throw new CommandError(
      `Invalid severity: ${opts.severity}. Valid severities: hard, guideline.`,
    );
  }

  const config = await loadConfig(opts.cwd);
  const cwd = path.resolve(opts.cwd);
  const rel = relTo(cwd);
  const core = createDirectionCore(cwd, config);

  // Resolve the learning — from the positional text, or from a referenced entry.
  if (opts.text === undefined || opts.text === "") {
    if (opts.entryId === undefined) {
      throw new CommandError(
        `promote requires a learning to lift: provide a text argument or --entry <id>.`,
      );
    }
    // --entry: promote THROUGH promoteEntryToGlobal so the source entry is
    // RETIRED alongside the global append (SC-07, Replan #7) — never a bare
    // promoteLearning that leaves the source live.
    // Reads exactly ONE direction's memory — never a sibling (isolation preserved).
    const entries = await core.memoryEntries(directionId);
    const entry = entries.find((e) => e.id === opts.entryId);
    if (!entry) {
      throw new CommandError(
        `No memory entry "${opts.entryId}" found on direction "${directionId}".`,
      );
    }
    const promoted = await promoteEntryToGlobal(
      { cwd, config },
      {
        directionId,
        entry: {
          id: entry.id,
          body: entry.body,
          channel: entry.channel,
          polarity: entry.polarity,
        },
        severity,
        author: opts.author ?? "cli",
        source: "cli",
        force: opts.force,
      },
    );
    const global = await createBrandCore(cwd, config).read();
    const rule = global.rules.find((r) => r.id === promoted.ruleId)!;
    console.log(
      `Promoted memory entry "${opts.entryId}" from direction "${directionId}" to a ${severity} global rule (source entry retired).`,
    );
    return {
      fromDirectionId: directionId,
      rule,
      filesWritten: [
        rel(globalBrandPath(cwd, config)),
        rel(path.join(directionsRoot(cwd, config), directionId, "memory.yaml")),
      ],
    };
  }
  const text = opts.text;

  const brand = createBrandCore(cwd, config);
  const next = await brand.promoteLearning(
    {
      fromDirectionId: directionId,
      text,
      severity,
      author: opts.author ?? "cli",
    },
    { force: opts.force },
  );
  const rule = next.rules[next.rules.length - 1];

  const brandPath = rel(globalBrandPath(cwd, config));

  console.log(
    `Promoted a learning from direction "${directionId}" to a ${severity} global rule.`,
  );

  return { fromDirectionId: directionId, rule, filesWritten: [brandPath] };
}

// ---------------------------------------------------------------------------
// Reconciliation orchestrator (shared by CLI + serve HTTP)
// ---------------------------------------------------------------------------

export interface ReconcileOrchestrationInput {
  cwd: string;
  directionId: string;
  contradiction: Contradiction;
  action: ReconcileAction;
  winner: "subject" | "conflictsWith";
  severity?: RuleSeverity;
  expectedMemoryVersion?: number;
  expectedGlobalVersion?: number;
  force?: boolean;
  author?: string;
  source?: string;
}

/**
 * The single reconciliation orchestrator consumed by both the CLI `reconcile`
 * verb and the serve `POST /api/directions/:id/reconciliation/resolve` endpoint.
 *
 * Enforces: version preflight → plan → write (retire/supersede/keep are ONE
 * direction-only write; promote is memory-audit-first then global-second with an
 * explicit partial-failure response when the second write races).
 */
export async function runReconcileResolve(
  opts: ReconcileOrchestrationInput,
): Promise<ReconciliationResolveResponse> {
  const config = await loadConfig(opts.cwd);
  const cwd = path.resolve(opts.cwd);
  const directionCore = createDirectionCore(cwd, config);
  const brandCore = createBrandCore(cwd, config);
  const author = opts.author ?? "cli";
  const source = opts.source ?? "cli";

  // 1. Plan (may throw CommandError on hard-rule/guideline loser).
  const plan = planReconciliation({
    contradiction: opts.contradiction,
    action: opts.action,
    winner: opts.winner,
    severity: opts.severity,
  });

  // 2. Preflight version check (unless forced).
  if (!opts.force) {
    if (opts.expectedMemoryVersion === undefined) {
      throw new CommandError(
        `expectedMemoryVersion is required for all non-forced reconcile actions.`,
      );
    }
    const currentMem = await directionCore.readMemory(opts.directionId);
    if (currentMem.version !== opts.expectedMemoryVersion) {
      throw new VersionConflictError(
        `direction:${opts.directionId}:memory`,
        opts.expectedMemoryVersion,
        currentMem.version,
      );
    }
    if (opts.action === "promote") {
      if (opts.expectedGlobalVersion === undefined) {
        throw new CommandError(
          `expectedGlobalVersion is required for promote actions (non-forced).`,
        );
      }
      const currentGlobal = await brandCore.read();
      if (currentGlobal.version !== opts.expectedGlobalVersion) {
        throw new VersionConflictError(
          "global:brand",
          opts.expectedGlobalVersion,
          currentGlobal.version,
        );
      }
    }
  }

  // Read current global version once for non-promote direction-only actions.
  const globalBrand = await brandCore.read();
  let globalVersion = globalBrand.version;
  let memoryVersion: number;

  // 3. Execute the plan.
  switch (opts.action) {
    case "keep": {
      const mem = await directionCore.appendLearning(
        opts.directionId,
        { body: plan.audit.body, author, source },
        { expectedVersion: opts.expectedMemoryVersion, force: opts.force },
      );
      memoryVersion = mem.version;
      break;
    }
    case "retire": {
      const mem = await directionCore.retireMemoryEntry(
        opts.directionId,
        {
          entryId: plan.retireEntryId!,
          author,
          source,
          reason: plan.audit.body,
        },
        { expectedVersion: opts.expectedMemoryVersion, force: opts.force },
      );
      memoryVersion = mem.version;
      break;
    }
    case "supersede": {
      const mem = await directionCore.supersedeMemoryEntry(
        opts.directionId,
        {
          entryId: plan.retireEntryId!,
          supersededBy: plan.supersededByEntryId!,
          author,
          source,
          reason: plan.audit.body,
        },
        { expectedVersion: opts.expectedMemoryVersion, force: opts.force },
      );
      memoryVersion = mem.version;
      break;
    }
    case "promote": {
      // Write memory audit first; then global rule second.
      // An un-audited global rule is worse than an audit-only partial.
      const mem = await directionCore.appendLearning(
        opts.directionId,
        { body: plan.audit.body, author, source },
        { expectedVersion: opts.expectedMemoryVersion, force: opts.force },
      );
      memoryVersion = mem.version;
      try {
        const global = await brandCore.promoteLearning(
          {
            fromDirectionId: opts.directionId,
            text: plan.promote!.text,
            severity: plan.promote!.severity,
            author,
          },
          { expectedVersion: opts.expectedGlobalVersion, force: opts.force },
        );
        globalVersion = global.version;
      } catch (err) {
        if (err instanceof VersionConflictError) {
          throw new ReconciliationPartialError(
            memoryVersion,
            opts.expectedGlobalVersion ?? globalVersion,
            err.actualVersion,
          );
        }
        throw err;
      }
      break;
    }
    default: {
      const _exhaustive: never = opts.action;
      throw new CommandError(`Unknown reconciliation action: ${String(_exhaustive)}`);
    }
  }

  return {
    directionId: opts.directionId,
    contradictionId: opts.contradiction.id,
    action: opts.action,
    memoryVersion: memoryVersion!,
    globalVersion,
  };
}
