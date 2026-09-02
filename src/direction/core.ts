import path from "node:path";
import { createCollectionStore } from "../store/create-store.js";
import type { CollectionStore } from "../store/versioned-store.js";
import { directionsRoot, storeDriver } from "../config.js";
import { writeTextFile } from "../fs.js";
import { CommandError } from "../errors.js";
import type { KeyartConfig } from "../types.js";
import {
  DirectionRecordSchema,
  DirectionMemorySchema,
  parseDirectionRecord,
  parseDirectionMemory,
  parseBrandBrief,
  DIRECTION_SLUG_RE,
  type DirectionRecord,
  type DirectionMemory,
  type BrandBrief,
  type BrandBriefPatch,
  type AssetRef,
  type MemoryEntry,
  type MemoryKind,
  type DirectionStatus,
  type ReferenceIntent,
  isAssetRetired,
} from "./schema.js";
import type { DirectiveChannel, DirectivePolarity } from "../brand/schema.js";
import { renderBrief } from "./render-brief.js";
import { isRetired } from "./reconcile.js";
import { planEdit } from "./lifecycle.js";
import {
  detectContradictions,
  type ContradictionDeps,
  type ContradictionReport,
} from "../brand/conflict-guard.js";
import { createBrandCore } from "../brand/core.js";

export interface CreateDirectionInput {
  id: string; // kebab-case; validated against DIRECTION_SLUG_RE
  name: string;
  brief?: Partial<BrandBrief>;
  assets?: AssetRef[];
  status?: DirectionStatus; // default "active"
}

/** Input for appending a memory entry — the directionId is the method's first arg. */
export interface AppendEntryInput {
  body: string;
  author: string;
  source: string;
  date?: string; // defaults to now (ISO)
  /** Optional stored thumbnail path; set on element-feedback discards. */
  asset?: string;
  /** Optional directive classification (semantically for `decision` entries). */
  channel?: DirectiveChannel;
  polarity?: DirectivePolarity;
}

/**
 * A direction's image asset exposed as reference material. Declared locally
 * (rather than importing `ReferenceItem` from `src/brand/assemble-context.ts`)
 * to keep the direction layer independent of the brand layer. Mirrors how
 * `assemble-context.ts` declares its own local `ContextMemoryEntry`.
 */
export interface DirectionImageRef {
  path: string;
  note?: string;
  /** How the reference is used. Absent on disk ⇒ resolved to `"inspire"` here
   * so callers always receive a concrete intent. `imageAssetPaths` never emits
   * `undefined`. */
  intent?: ReferenceIntent;
}

/** Input for recording an attributed reference-upload note on a direction. */
export interface RecordReferenceNoteInput {
  path: string;
  author: string;
  source: string;
  note?: string;
  date?: string; // defaults to now (ISO)
}

/** Input for recording an eyedropper-picked color as a direction-scoped lock. */
export interface RecordColorLockInput {
  hex: string; // "#rrggbb" (validated/normalized by the caller)
  author: string;
  source: string;
  note?: string; // optional human label, e.g. "brand blue from hero"
  date?: string;
}

export interface RetireMemoryEntryInput {
  entryId: string;
  author: string;
  source: string;
  reason?: string; // recorded into the audit entry body
  supersededBy?: string; // set on a supersede (the winning entry's id)
  date?: string;
}

export interface RetireAssetInput {
  path: string; // identifies the AssetRef to retire (idempotent by path)
  author: string;
  source: string;
  reason?: string; // recorded into the attributed audit `learning` entry body
  date?: string;
}

/** Input for `editMemoryEntry` — EDIT = supersede. Only `body`/`channel`/`polarity` are patchable. */
export interface EditMemoryEntryInput {
  entryId: string;
  body?: string;
  channel?: DirectiveChannel;
  polarity?: DirectivePolarity;
  author: string;
  source: string;
  date?: string;
}

/** Input for `deleteMemoryEntry` — a thin alias over `retireMemoryEntry` (delete = complete non-destructive retire). */
export interface DeleteMemoryEntryInput {
  entryId: string;
  author: string;
  source: string;
  reason?: string;
  date?: string;
}

export interface DirectionCore {
  list(): Promise<DirectionRecord[]>; // sorted by id
  get(id: string): Promise<DirectionRecord>; // throws CommandError when missing
  exists(id: string): Promise<boolean>;
  create(input: CreateDirectionInput): Promise<DirectionRecord>; // throws when id exists / invalid slug
  update(
    id: string,
    mutate: (current: DirectionRecord) => DirectionRecord,
    opts?: { expectedVersion?: number; force?: boolean },
  ): Promise<DirectionRecord>;
  /**
   * Registers an {@link AssetRef} on a direction, version-safely. Idempotent by
   * `path`: re-registering a file already present (same `path`) is a no-op that
   * still returns the current record. Throws `CommandError` (via `update`→`get`)
   * when the direction is missing, writing nothing.
   */
  addAsset(
    id: string,
    asset: AssetRef,
    opts?: { force?: boolean },
  ): Promise<DirectionRecord>;
  transition(
    id: string,
    verb: "reject" | "park" | "revive" | "approve" | "archive",
    opts?: { force?: boolean },
  ): Promise<DirectionRecord>;
  /**
   * Appends `versionId` to `versions` and advances `head` to it — the atomic,
   * version-checked fold of the old `appendVersionToIndex`. The record owns
   * `versions`/`head` directly (there is no separate index file).
   */
  appendVersion(
    id: string,
    versionId: string,
    opts?: { expectedVersion?: number; force?: boolean },
  ): Promise<DirectionRecord>;
  /** The current head version id, or `null` for a draft. Throws `CommandError` when missing. */
  head(id: string): Promise<string | null>;
  /**
   * Returns the direction's `image`-kind assets as `{ path, note, intent }` —
   * the subset eligible to be elevated into the assembled context as reference
   * material. Every asset on this record belongs to THIS direction by
   * construction (scope is location) — no scope filter. Retired kept crops are
   * excluded. Reads through `core.get`, so it preserves store/version
   * discipline and throws `CommandError` for a missing direction (writing
   * nothing).
   */
  imageAssetPaths(id: string): Promise<DirectionImageRef[]>;
  /**
   * Non-destructively marks a kept-crop AssetRef retired (adds `retiredAt` on the
   * matching AssetRef, identified by `path`) AND appends an attributed `learning`
   * audit entry describing the retirement. The asset's `path`/`kind`/`note`/
   * `intent` are NEVER changed (append-only invariant). Idempotent: an
   * already-retired asset is a no-op that still returns the current record and
   * appends NO second audit entry. Touches TWO stores — direction.yaml (the
   * marker, via `core.update`) then memory.yaml (the audit, via
   * `appendLearning`). Throws `CommandError` for a missing direction (via
   * `get`) or a missing asset (no `path` match), writing nothing.
   */
  retireAsset(
    id: string,
    input: RetireAssetInput,
    opts?: { expectedVersion?: number; force?: boolean },
  ): Promise<DirectionRecord>;

  // --- Brief (the direction's descriptive source of truth) ---
  /** The structured brief off the versioned record. Throws `CommandError` when missing. */
  getBrief(id: string): Promise<BrandBrief>;
  /**
   * The single projection chokepoint: `renderBrief(await getBrief(id))`. Every
   * reader (generation snapshots, studio preview) routes through this so the
   * markdown a reader sees is always the deterministic projection of the record.
   */
  getRenderedBrief(id: string): Promise<string>;
  /**
   * Replaces named brief fields on the versioned record (optimistic —
   * `VersionConflictError`/409 on a stale `expectedVersion` unless `force`), then
   * rewrites the `brief.md` projection. SHALLOW merge: a provided key REPLACES
   * that key's value (arrays are replaced wholesale — callers send the full
   * desired array); absent keys are untouched. Throws `CommandError` for a
   * missing direction (via `update`→`get`), writing nothing.
   */
  setBriefFields(
    id: string,
    patch: BrandBriefPatch,
    opts?: { expectedVersion?: number; force?: boolean },
  ): Promise<DirectionRecord>;
  /** Semantic twin of {@link setBriefFields}. */
  patchBrief(
    id: string,
    patch: BrandBriefPatch,
    opts?: { expectedVersion?: number; force?: boolean },
  ): Promise<DirectionRecord>;
  /**
   * Records an attributed `learning` memory entry describing an uploaded
   * reference image, so a moodboard is durable, attributed memory rather than
   * inert `direction.yaml` metadata — it then feeds the next explore's
   * assembled context via existing memory rendering. There is NO separate
   * `reference` memory kind; this delegates to `appendLearning` so it flows
   * through the single attributed write path (never raw `fs`/`yaml`). Throws
   * `CommandError` for a missing direction via `appendLearning`, writing nothing.
   */
  recordReferenceNote(
    id: string,
    input: RecordReferenceNoteInput,
    opts?: { force?: boolean },
  ): Promise<DirectionMemory>;
  /**
   * Records an eyedropper-picked color as an attributed **lock** — a
   * `decision` memory entry whose body carries the EXACT hex (`Color locked:
   * #rrggbb`). The hex in the body is deliberate: it is how the lock reaches
   * the palette engine — `renderContextBlock` renders it into the memory
   * section and `deriveLocksFromContext` greps it into a `PaletteLock` via the
   * existing context path (no new color plumbing). Delegates to
   * `appendDecision` (the single attributed write path) — never raw
   * `fs`/`yaml`. Throws `CommandError` for a missing direction (via
   * `appendDecision` → `get`), writing nothing. Mirrors {@link recordReferenceNote}.
   */
  recordColorLock(
    id: string,
    input: RecordColorLockInput,
    opts?: { force?: boolean },
  ): Promise<DirectionMemory>;

  // --- Memory (isolation-enforced by location) ---
  readMemory(id: string): Promise<DirectionMemory>; // returns empty memory doc when none yet
  appendFeedback(
    id: string,
    entry: AppendEntryInput,
    opts?: { force?: boolean },
  ): Promise<DirectionMemory>;
  appendLearning(
    id: string,
    entry: AppendEntryInput,
    opts?: { expectedVersion?: number; force?: boolean },
  ): Promise<DirectionMemory>;
  appendDecision(
    id: string,
    entry: AppendEntryInput,
    opts?: { force?: boolean },
  ): Promise<DirectionMemory>;
  /**
   * Read view for ONE direction's memory. Excludes retired entries by default
   * (`includeRetired: true` for history). Isolation is structural — this only
   * ever reads `<id>/memory.yaml`; a sibling direction's entries can never
   * appear here.
   */
  memoryEntries(
    id: string,
    opts?: { includeRetired?: boolean },
  ): Promise<MemoryEntry[]>;
  /**
   * Non-destructively marks a memory entry retired (adds `retiredAt` + optional
   * `supersededBy` marker) AND appends an attributed `learning` audit entry — all in
   * ONE versioned write. The original entry's body/attribution/kind are never changed
   * (append-only invariant). Idempotent: already-retired entries are a no-op.
   */
  retireMemoryEntry(
    id: string,
    input: RetireMemoryEntryInput,
    opts?: { expectedVersion?: number; force?: boolean },
  ): Promise<DirectionMemory>;
  /**
   * Supersede the loser entry with the winner's id: sets both `retiredAt` and
   * `supersededBy` on the loser. Delegates to `retireMemoryEntry` with
   * `supersededBy` required.
   */
  supersedeMemoryEntry(
    id: string,
    input: RetireMemoryEntryInput & { supersededBy: string },
    opts?: { expectedVersion?: number; force?: boolean },
  ): Promise<DirectionMemory>;
  /**
   * EDIT = supersede, as ONE atomic versioned write: mints the corrected entry
   * (carrying the source's `kind`/`channel`/`polarity`, with the patch
   * overriding only `body`/`channel`/`polarity`), marks the original
   * `retiredAt` + `supersededBy: <newId>` (never mutating its body in place),
   * and appends both the corrected entry and an attributed `learning` audit —
   * all in a single `memoryStore.write` (version +1). Throws `CommandError`
   * (via `planEdit`) when the source is missing or already retired.
   */
  editMemoryEntry(
    id: string,
    input: EditMemoryEntryInput,
    opts?: { expectedVersion?: number; force?: boolean },
  ): Promise<DirectionMemory>;
  /**
   * DELETE = the existing non-destructive retire, as a thin standalone alias
   * over `retireMemoryEntry` (so the CLI/serve surface has an obvious verb).
   * Idempotent on an already-retired entry; adds no new behavior.
   */
  deleteMemoryEntry(
    id: string,
    input: DeleteMemoryEntryInput,
    opts?: { expectedVersion?: number; force?: boolean },
  ): Promise<DirectionMemory>;
  /**
   * List contradictions for ONE direction's memory against the global brand
   * layer. Always deterministic (live-vs-rule floor); `deps.semantic` enables
   * LLM cases. `live` sets a synthetic live instruction for detection (default:
   * empty). Never reads a sibling direction.
   */
  listContradictions(
    id: string,
    deps?: ContradictionDeps,
    live?: { id: string; text: string },
  ): Promise<ContradictionReport>;
}

/**
 * Pure lifecycle transition for a direction.
 *
 * - `reject`  : any state → "rejected" (never throws)
 * - `approve` : any state → "approved" (never throws)
 * - `park`    : "active" | "rejected" → "parked" (throws from "parked"/"approved")
 * - `revive`  : "parked" | "rejected" | "archived" → "active" (throws from "active"/"approved")
 * - `archive` : any state → "archived" (throws from "archived") — non-destructive:
 *   the record and its whole tree stay on disk; reversible via `revive`.
 */
export function transitionDirectionStatus(
  current: DirectionStatus,
  verb: "reject" | "park" | "revive" | "approve" | "archive",
): DirectionStatus {
  switch (verb) {
    case "reject":
      return "rejected";
    case "approve":
      return "approved";
    case "archive":
      if (current === "archived") {
        throw new CommandError(`Direction is already archived.`);
      }
      return "archived";
    case "park":
      if (current === "parked") {
        throw new CommandError(`Direction is already parked.`);
      }
      if (current === "approved") {
        throw new CommandError(`Cannot park an approved direction.`);
      }
      return "parked";
    case "revive":
      if (current === "active") {
        throw new CommandError(
          `Direction is already active — nothing to revive.`,
        );
      }
      if (current === "approved") {
        throw new CommandError(
          `Cannot revive an approved direction — it is already the approved direction's source.`,
        );
      }
      return "active";
    default: {
      const _exhaustive: never = verb;
      throw new CommandError(
        `Unknown direction transition: ${String(_exhaustive)}`,
      );
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Generates an id that is unique within a single memory doc. */
function makeEntryId(kind: MemoryKind): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${kind}-${ts}-${rand}`;
}

export function createDirectionCore(
  cwd: string,
  config: KeyartConfig,
): DirectionCore {
  const driver = storeDriver(config);
  const dir = directionsRoot(cwd, config);

  const directionStore: CollectionStore<DirectionRecord> = createCollectionStore({
    driver,
    dir,
    fileName: "direction.yaml",
    parse: parseDirectionRecord,
  });
  const memoryStore: CollectionStore<DirectionMemory> = createCollectionStore({
    driver,
    dir,
    fileName: "memory.yaml",
    parse: parseDirectionMemory,
  });

  const core: DirectionCore = {
    async list() {
      const keys = await directionStore.listKeys();
      const docs = await Promise.all(keys.map((key) => directionStore.read(key)));
      return docs
        .filter((doc): doc is DirectionRecord => doc !== null)
        .sort((a, b) => a.id.localeCompare(b.id));
    },

    async get(id) {
      const doc = await directionStore.read(id);
      if (doc === null) {
        throw new CommandError(
          `Direction not found: ${id}. Run \`keyart direction list\` to see available directions.`,
        );
      }
      return doc;
    },

    exists(id) {
      return directionStore.has(id);
    },

    async create(input) {
      if (!DIRECTION_SLUG_RE.test(input.id)) {
        throw new CommandError(
          `Invalid direction id: "${input.id}". Direction ids must be kebab-case (lower-case letters, digits, and single hyphens).`,
        );
      }
      if (await directionStore.has(input.id)) {
        throw new CommandError(`Direction "${input.id}" already exists.`);
      }

      const now = nowIso();
      const record = parseDirectionRecord({
        id: input.id,
        name: input.name,
        status: input.status ?? "active",
        brief: input.brief ?? {},
        assets: input.assets ?? [],
        versions: [],
        head: null,
        version: 0,
        createdAt: now,
        updatedAt: now,
      });

      const written = await directionStore.write(input.id, record);

      // Write the initial brief.md projection so a fresh direction's brief.md is
      // the deterministic projection from birth (never a hand-authored file).
      await writeBriefProjection(input.id, written.brief);

      // Initialize an empty memory doc so the direction's memory exists from birth.
      const memory = parseDirectionMemory({
        directionId: input.id,
        entries: [],
        version: 0,
        createdAt: now,
        updatedAt: now,
      });
      await memoryStore.write(input.id, memory);

      return written;
    },

    async update(id, mutate, opts) {
      const current = await core.get(id);
      const next: DirectionRecord = {
        ...mutate(current),
        updatedAt: nowIso(),
      };
      const parsed = parseDirectionRecord(next);
      return directionStore.write(id, parsed, {
        expectedVersion: opts?.expectedVersion ?? current.version,
        force: opts?.force,
      });
    },

    async addAsset(id, asset, opts) {
      return core.update(
        id,
        (c) =>
          c.assets.some((a) => a.path === asset.path)
            ? c // already registered — idempotent no-op
            : { ...c, assets: [...c.assets, asset] },
        opts,
      );
    },

    async transition(id, verb, opts) {
      const current = await core.get(id);
      const next = transitionDirectionStatus(current.status, verb);
      return core.update(id, (c) => ({ ...c, status: next }), opts);
    },

    async appendVersion(id, versionId, opts) {
      return core.update(
        id,
        (c) => ({
          ...c,
          versions: [...c.versions, versionId],
          head: versionId,
        }),
        opts,
      );
    },

    async head(id) {
      return (await core.get(id)).head;
    },

    async imageAssetPaths(id) {
      const rec = await core.get(id);
      return rec.assets
        .filter((a) => a.kind === "image")
        .filter((a) => !isAssetRetired(a)) // retired kept crops never reach the image model
        .map((a) => ({
          path: a.path,
          note: a.note,
          intent: a.intent ?? "inspire",
        }));
    },

    async retireAsset(id, input, opts) {
      const rec = await core.get(id); // isolation anchor + missing-direction guard
      const target = rec.assets.find((a) => a.path === input.path);
      if (!target) {
        throw new CommandError(
          `Asset "${input.path}" not found on direction "${id}".`,
        );
      }
      // Idempotent: already retired → return current record, NO marker write, NO audit.
      if (isAssetRetired(target)) {
        return rec;
      }
      const now = nowIso();
      const retiredAt = input.date ?? now;
      // 1) Asset marker on direction.yaml (versioned) — map assets, mark the match, copy the rest.
      const updated = await core.update(
        id,
        (c) => ({
          ...c,
          assets: c.assets.map((a) =>
            a.path === input.path ? { ...a, retiredAt } : a,
          ),
        }),
        opts, // expectedVersion / force flow to the direction.yaml write
      );
      // 2) Attributed audit learning on memory.yaml (mirrors retireMemoryEntry's trail).
      //    Its own versioned write; the audit is not gated by the direction opts.expectedVersion.
      await core.appendLearning(id, {
        body: input.reason ?? `Retired asset ${input.path}.`,
        author: input.author,
        source: input.source,
        date: now,
      });
      return updated;
    },

    async getBrief(id) {
      return (await core.get(id)).brief;
    },

    async getRenderedBrief(id) {
      return renderBrief(await core.getBrief(id));
    },

    async setBriefFields(id, patch, opts) {
      const next = await core.update(
        id,
        (c) => ({
          ...c,
          // Shallow merge: a provided key REPLACES that key (arrays wholesale);
          // absent keys are untouched. Re-parse to normalize/validate.
          brief: parseBrandBrief({ ...c.brief, ...patch }),
        }),
        opts,
      );
      // Chokepoint: rewrite the brief.md projection on every brief write.
      await writeBriefProjection(id, next.brief);
      return next;
    },

    // Alias/semantic twin — the same versioned write + projection rewrite.
    patchBrief(id, patch, opts) {
      return core.setBriefFields(id, patch, opts);
    },

    recordReferenceNote(id, input, opts) {
      const body =
        input.note && input.note.length > 0
          ? `Reference image added: ${input.path} — ${input.note}`
          : `Reference image added: ${input.path}`;
      return core.appendLearning(
        id,
        {
          body,
          author: input.author,
          source: input.source,
          date: input.date,
        },
        opts,
      );
    },

    recordColorLock(id, input, opts) {
      const label =
        input.note && input.note.length > 0 ? ` (${input.note})` : "";
      return core.appendDecision(
        id,
        {
          body: `Color locked: ${input.hex}${label}`,
          author: input.author,
          source: input.source,
          date: input.date,
        },
        opts,
      );
    },

    async readMemory(id) {
      const doc = await memoryStore.read(id);
      if (doc === null) {
        const now = nowIso();
        return {
          directionId: id,
          entries: [],
          version: 0,
          createdAt: now,
          updatedAt: now,
        };
      }
      return doc;
    },

    appendFeedback(id, entry, opts) {
      return appendEntry(id, "feedback", entry, opts);
    },
    appendLearning(id, entry, opts) {
      return appendEntry(id, "learning", entry, opts);
    },
    appendDecision(id, entry, opts) {
      return appendEntry(id, "decision", entry, opts);
    },

    async memoryEntries(id, opts) {
      const mem = await core.readMemory(id);
      return opts?.includeRetired
        ? mem.entries
        : mem.entries.filter((e) => !isRetired(e));
    },

    async retireMemoryEntry(id, input, opts) {
      await core.get(id);
      const mem = await core.readMemory(id);
      const target = mem.entries.find((e) => e.id === input.entryId);
      if (!target) {
        throw new CommandError(
          `Memory entry "${input.entryId}" not found on direction "${id}".`,
        );
      }
      // Idempotent: already retired → return current memory unchanged.
      if (isRetired(target)) {
        return mem;
      }
      const now = nowIso();
      const retiredAt = input.date ?? now;
      // Map entries: the target gets `retiredAt` (+ `supersededBy`) added; others unchanged.
      const markedEntry: MemoryEntry = {
        ...target,
        retiredAt,
        ...(input.supersededBy ? { supersededBy: input.supersededBy } : {}),
      };
      // Append fresh attributed audit learning entry in the same write.
      const auditEntry: MemoryEntry = {
        id: makeEntryId("learning"),
        kind: "learning",
        body: input.reason ?? `Retired memory entry ${input.entryId}.`,
        author: input.author,
        source: input.source,
        date: now,
      };
      const nextEntries = mem.entries.map((e) =>
        e.id === input.entryId ? markedEntry : e,
      );
      nextEntries.push(auditEntry);
      const next = parseDirectionMemory({
        ...mem,
        directionId: id,
        entries: nextEntries,
        updatedAt: now,
      });
      return memoryStore.write(id, next, {
        expectedVersion: opts?.expectedVersion ?? mem.version,
        force: opts?.force,
      });
    },

    supersedeMemoryEntry(id, input, opts) {
      return core.retireMemoryEntry(id, input, opts);
    },

    async editMemoryEntry(id, input, opts) {
      await core.get(id);
      const mem = await core.readMemory(id);
      const source = mem.entries.find((e) => e.id === input.entryId);
      if (!source) {
        throw new CommandError(
          `Memory entry "${input.entryId}" not found on direction "${id}".`,
        );
      }
      const plan = planEdit(source, {
        body: input.body,
        channel: input.channel,
        polarity: input.polarity,
      });

      const now = nowIso();
      const newId = makeEntryId(plan.newEntry.kind);
      const correctedEntry: MemoryEntry = {
        id: newId,
        kind: plan.newEntry.kind,
        body: plan.newEntry.body,
        author: input.author,
        source: input.source,
        date: input.date ?? now,
        ...(plan.newEntry.channel ? { channel: plan.newEntry.channel } : {}),
        ...(plan.newEntry.polarity ? { polarity: plan.newEntry.polarity } : {}),
      };
      const auditEntry: MemoryEntry = {
        id: makeEntryId("learning"),
        kind: "learning",
        body: plan.audit.body,
        author: input.author,
        source: input.source,
        date: now,
      };

      const nextEntries = mem.entries.map((e) =>
        e.id === source.id
          ? { ...e, retiredAt: now, supersededBy: newId }
          : e,
      );
      nextEntries.push(correctedEntry, auditEntry);

      const next = parseDirectionMemory({
        ...mem,
        directionId: id,
        entries: nextEntries,
        updatedAt: now,
      });
      return memoryStore.write(id, next, {
        expectedVersion: opts?.expectedVersion ?? mem.version,
        force: opts?.force,
      });
    },

    deleteMemoryEntry(id, input, opts) {
      return core.retireMemoryEntry(
        id,
        {
          entryId: input.entryId,
          author: input.author,
          source: input.source,
          reason: input.reason ?? `Deleted (retire): entry ${input.entryId}.`,
          date: input.date,
        },
        opts,
      );
    },

    async listContradictions(id, deps, live) {
      await core.get(id);
      const directionMemory = await core.memoryEntries(id);
      const brandCore = createBrandCore(cwd, config);
      const globalBrand = await brandCore.read();
      const hardRules = globalBrand.rules.filter((r) => r.severity === "hard");
      const guidelines = globalBrand.rules.filter((r) => r.severity !== "hard");
      return detectContradictions(
        {
          memory: directionMemory,
          hardRules,
          guidelines,
          liveInstruction: live?.text ?? "",
          liveInstructionId: live?.id ?? "live:reconciliation:list",
        },
        deps,
      );
    },
  };

  /**
   * Writes the deterministic `brief.md` projection for a direction. Resolved
   * from `directionsRoot(cwd,config)/<id>/brief.md` (the same `dir` the store
   * uses). The projection is always regenerated from the record — never
   * hand-authored.
   */
  async function writeBriefProjection(
    id: string,
    brief: BrandBrief,
  ): Promise<void> {
    await writeTextFile(path.join(dir, id, "brief.md"), renderBrief(brief));
  }

  async function appendEntry(
    id: string,
    kind: MemoryKind,
    entry: AppendEntryInput,
    opts?: { expectedVersion?: number; force?: boolean },
  ): Promise<DirectionMemory> {
    // 1. Assert the direction exists — memory is always anchored to a real target.
    await core.get(id);

    // 2. Read current memory (empty doc when absent).
    const mem = await core.readMemory(id);

    // 3. Build the attributed entry.
    const now = nowIso();
    const newEntry: MemoryEntry = {
      id: makeEntryId(kind),
      kind,
      body: entry.body,
      author: entry.author,
      source: entry.source,
      date: entry.date ?? now,
      // Include `asset` only when present so entries without it serialize
      // byte-identically (backward compatible with legacy memory.yaml).
      ...(entry.asset ? { asset: entry.asset } : {}),
      ...(entry.channel ? { channel: entry.channel } : {}),
      ...(entry.polarity ? { polarity: entry.polarity } : {}),
    };

    // 4. Append, re-anchoring directionId to the target id.
    const next = parseDirectionMemory({
      ...mem,
      directionId: id,
      entries: [...mem.entries, newEntry],
      updatedAt: now,
    });

    // 5. Optimistic versioned write (expectedVersion from opts when set, else current).
    return memoryStore.write(id, next, {
      expectedVersion: opts?.expectedVersion ?? mem.version,
      force: opts?.force,
    });
  }

  return core;
}
