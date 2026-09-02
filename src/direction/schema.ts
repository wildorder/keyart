import { z } from "zod";
import { DirectiveChannelSchema, DirectivePolaritySchema } from "../brand/schema.js";
import { CommandError } from "../errors.js";

/** Direction ids are kebab-case slugs (lower-case alphanumerics joined by single hyphens). */
export const DIRECTION_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const DirectionStatusSchema = z.enum([
  "active",
  "parked",
  "rejected",
  "approved",
  "archived",
]);
export type DirectionStatus = z.infer<typeof DirectionStatusSchema>;

/**
 * How a reference image is used when it feeds generation:
 * - `inspire` — fed to the reference-capable image model as a generation
 *   reference (moodboard, as today).
 * - `extract` — vision-analyzed into dominant colors + type intent that seed/lock
 *   the palette engine; NEVER a direct image-edit source (no derivative output).
 * Absent `intent` is treated as `"inspire"` everywhere (resolved at read time —
 * never backfilled on disk).
 */
export const ReferenceIntentSchema = z.enum(["inspire", "extract"]);
export type ReferenceIntent = z.infer<typeof ReferenceIntentSchema>;

/** A reference to a binary asset — PATHS ONLY. This program never fetches/generates assets. */
export const AssetRefSchema = z.object({
  kind: z.enum(["image", "font", "color", "other"]),
  path: z.string(), // repo-relative, forward slashes
  note: z.string().optional(),
  // Optional so pre-existing direction.yaml files parse unchanged; absent ⇒ "inspire".
  intent: ReferenceIntentSchema.optional(),
  /**
   * NON-DESTRUCTIVE retire marker for a KEPT CROP (mirrors MemoryEntry.retiredAt).
   * ISO 8601 timestamp at which this asset was retired. Absent ⇒ live. A retired
   * kept crop is NEVER an image ref (imageAssetPaths filters it) and can never
   * re-enter generation. The write verb that SETS it is `DirectionCore.retireAsset`.
   */
  retiredAt: z.string().optional(), // ISO 8601
});
export type AssetRef = z.infer<typeof AssetRefSchema>;

/** One audience segment — who + optional context/need. */
export const AudienceSchema = z.object({
  who: z.string(),
  context: z.string().optional(),
  need: z.string().optional(),
});
export type Audience = z.infer<typeof AudienceSchema>;

/**
 * The direction's durable, authored intent — comprehensive but MOSTLY OPTIONAL,
 * with rich free-text WITHIN fields and a real `otherNotes` escape hatch.
 * SOFT intent only: colorIntent/typeIntent are words ("warm, earthy"), never
 * hexes or font families (those route to memory locks / live in tokens — the
 * brief is never a rival color source of truth).
 */
export const BrandBriefSchema = z
  .object({
    // identity
    aliases: z.array(z.string()).default([]),
    neverCallIt: z.array(z.string()).default([]),
    oneLiner: z.string().optional(),
    // strategy
    audiences: z.array(AudienceSchema).default([]),
    problem: z.string().optional(),
    positioning: z.string().optional(),
    differentiateFrom: z.array(z.string()).default([]),
    // personality
    tone: z.array(z.string()).default([]),
    values: z.array(z.string()).default([]),
    voice: z.string().optional(),
    // aesthetic INTENT (soft — the seed, never the spec)
    colorIntent: z.string().optional(),
    typeIntent: z.string().optional(),
    moodImagery: z.string().optional(),
    mascot: z.string().optional(),
    // grounding
    inspirations: z.array(z.string()).default([]),
    constraints: z.array(z.string()).default([]),
    surfaces: z.array(z.string()).default([]),
    // escape hatch
    otherNotes: z.string().optional(),
  })
  .default({});
export type BrandBrief = z.infer<typeof BrandBriefSchema>;
/** A partial patch applied over the current brief. */
export type BrandBriefPatch = Partial<BrandBrief>;
export const parseBrandBrief = (raw: unknown): BrandBrief =>
  BrandBriefSchema.parse(raw);

export const MemoryKindSchema = z.enum(["feedback", "learning", "decision"]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

/** A single attributed memory entry. Attribution (author/source/date) is REQUIRED. */
export const MemoryEntrySchema = z.object({
  id: z.string(), // stable id (e.g. timestamp-based)
  kind: MemoryKindSchema,
  body: z.string(),
  author: z.string(), // who recorded it (e.g. "tim", "agent")
  source: z.string(), // where it came from (e.g. "cli", "mcp", "audit")
  date: z.string(), // ISO 8601
  /**
   * Optional repo-relative (forward-slash) path to a stored thumbnail. Present on
   * element-feedback DISCARD entries (a cropped region the user rejected).
   * Deliberately NOT an `AssetRef` — a discard thumbnail must never become a
   * positive `inspire`/`extract` reference.
   */
  asset: z.string().optional(),
  /**
   * Optional VISUAL/COPY channel + PREFER/AVOID polarity. Semantically meaningful
   * on `decision` entries (the memory the compiler routes into image prompts);
   * schema-optional on ALL kinds for a uniform shape. Absent ⇒ resolved by
   * classify-directive. Additive + back-compat.
   */
  channel: DirectiveChannelSchema.optional(),
  polarity: DirectivePolaritySchema.optional(),
  /**
   * NON-DESTRUCTIVE retire marker (append-only invariant preserved — the entry is
   * NEVER deleted). `retiredAt` is the ISO timestamp it was retired; `supersededBy`
   * optionally names the entry id that replaced it. Both optional + back-compat.
   */
  supersededBy: z.string().optional(),
  retiredAt: z.string().optional(), // ISO 8601
});
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;

/**
 * True iff a kept-crop AssetRef has been retired (non-destructive marker present).
 * PURE, synchronous, no I/O. Accepts the minimal structural shape so callers can
 * pass an AssetRef or any `{ retiredAt? }`. Mirrors `isRetired` in
 * direction/reconcile.ts (memory entries), which also checks `supersededBy` — assets
 * have no supersede relationship, so this checks the single marker only.
 */
export function isAssetRetired(ref: { retiredAt?: string }): boolean {
  return typeof ref.retiredAt === "string" && ref.retiredAt.length > 0;
}

/**
 * One persisted record per direction — the aggregate root. Folds together what
 * used to be a `ConceptRecord` (identity, status, embedded brief, moodboard
 * assets) and the tiny per-direction `DirectionIndex` (`versions[]`/`head`).
 *
 * `head` is `null` exactly when `versions` is empty — a direction that has been
 * described but not yet generated is a legal DRAFT. The invariant is enforced by
 * the `superRefine` below and is NEVER silently repaired: a violation always
 * throws a `z.ZodError` from `DirectionRecordSchema.parse`. Every read path goes
 * through {@link parseDirectionRecord} instead, which converts that into the
 * house teaching `CommandError`.
 */
export const DirectionRecordSchema = z
  .object({
    id: z.string().regex(DIRECTION_SLUG_RE),
    name: z.string(),
    status: DirectionStatusSchema,
    // The structured, versioned brief — the direction's descriptive source of
    // truth. `.default({})` so records written before this field parse to an
    // empty brief (unknown keys are dropped by Zod, never throwing).
    brief: BrandBriefSchema,
    assets: z.array(AssetRefSchema).default([]), // moodboard + kept crops
    versions: z.array(z.string()).default([]), // ordered version ids; [] ⇒ draft
    head: z.string().nullable().default(null), // null ⇒ draft
    version: z.number().int().nonnegative(), // optimistic concurrency
    createdAt: z.string(), // ISO 8601
    updatedAt: z.string(), // ISO 8601
  })
  .superRefine((record, ctx) => {
    if (record.versions.length === 0) {
      if (record.head !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["head"],
          message: `head must be null when versions is empty (draft), got "${record.head}".`,
        });
      }
      return;
    }
    const expectedHead = record.versions[record.versions.length - 1];
    if (record.head !== expectedHead) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["head"],
        message: `head ("${record.head}") must equal the last entry of versions ("${expectedHead}").`,
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["versions"],
        message: `versions' last entry ("${expectedHead}") must equal head ("${record.head}").`,
      });
    }
  });
export type DirectionRecord = z.infer<typeof DirectionRecordSchema>;

export const DirectionMemorySchema = z.object({
  directionId: z.string(), // ISOLATION ANCHOR: memory always names its direction
  entries: z.array(MemoryEntrySchema).default([]),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DirectionMemory = z.infer<typeof DirectionMemorySchema>;

/** Renders a ZodError as one `- <path>: <message>` line per issue — the
 *  `loadConfig`/`surface/schema.ts` issue-formatting idiom, so every reader
 *  surfaces identical teaching text. */
function formatTeachingIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const at = issue.path.length ? issue.path.join(".") : "(root)";
      return `- ${at}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * Validates a `DirectionRecord`, rethrowing a `z.ZodError` as the house teaching
 * `CommandError`. The `parseOrTeach` idiom (`src/surface/store.ts`): every read
 * path goes through this, never through the bare schema, so a caller always sees
 * the teaching message while the schema stays a pure Zod value.
 */
export const parseDirectionRecord = (raw: unknown): DirectionRecord => {
  try {
    return DirectionRecordSchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new CommandError(formatTeachingIssues(err));
    }
    throw err;
  }
};

/** Same `parseOrTeach` idiom as {@link parseDirectionRecord}, for memory docs. */
export const parseDirectionMemory = (raw: unknown): DirectionMemory => {
  try {
    return DirectionMemorySchema.parse(raw);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new CommandError(formatTeachingIssues(err));
    }
    throw err;
  }
};
