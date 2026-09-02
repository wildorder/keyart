import type { MemoryEntry, MemoryKind } from "./schema.js";
import type {
  RuleSeverity,
  DirectiveChannel,
  DirectivePolarity,
} from "../brand/schema.js";
import { isRetired } from "./reconcile.js";
import { CommandError } from "../errors.js";

/** The edit/promote/delete twin of `reconcile.ts`'s `planReconciliation` — pure, no I/O. */

export interface EditPlan {
  /** The original entry, to be superseded. */
  supersedeEntryId: string;
  newEntry: {
    kind: MemoryKind;
    body: string;
    channel?: DirectiveChannel;
    polarity?: DirectivePolarity;
  };
  audit: { kind: "learning"; body: string };
}

/**
 * EDIT = supersede. Carries the source entry's `kind`/`channel`/`polarity`
 * onto the corrected entry; the patch overrides only `body`/`channel`/
 * `polarity` (kind is never changed by an edit). Throws `CommandError` if the
 * source is already retired.
 */
export function planEdit(
  entry: MemoryEntry,
  patch: { body?: string; channel?: DirectiveChannel; polarity?: DirectivePolarity },
): EditPlan {
  if (isRetired(entry)) {
    throw new CommandError(
      `Cannot edit memory entry ${entry.id}: it is already retired/superseded. Recreate it instead.`,
    );
  }
  return {
    supersedeEntryId: entry.id,
    newEntry: {
      kind: entry.kind,
      body: patch.body ?? entry.body,
      channel: patch.channel ?? entry.channel,
      polarity: patch.polarity ?? entry.polarity,
    },
    audit: {
      kind: "learning",
      body: `Edited (supersede): entry ${entry.id} superseded by a corrected version.`,
    },
  };
}

/** Promote is up-only and single-destination: a direction entry may only be lifted to global. */
export type PromoteTarget = "global";

export interface PromotePlan {
  target: PromoteTarget;
  /** The source entry — ALWAYS retired (no double-count). */
  retireSourceEntryId: string;
  globalRule: {
    text: string;
    severity: RuleSeverity;
    channel?: DirectiveChannel;
    polarity?: DirectivePolarity;
  };
  audit: { kind: "learning"; body: string };
}

/**
 * PROMOTE = up-ladder ONLY, direction→global (the only rung left after the
 * concept layer's removal — there is no demote path). Throws `CommandError` on
 * an already-retired source.
 */
export function planPromote(
  entry: MemoryEntry,
  opts: { target: PromoteTarget; severity?: RuleSeverity },
): PromotePlan {
  if (isRetired(entry)) {
    throw new CommandError(
      `Cannot promote memory entry ${entry.id}: it is already retired.`,
    );
  }

  switch (opts.target) {
    case "global": {
      return {
        target: "global",
        retireSourceEntryId: entry.id,
        globalRule: {
          text: entry.body,
          severity: opts.severity ?? "guideline",
          channel: entry.channel,
          polarity: entry.polarity,
        },
        audit: {
          kind: "learning",
          body: `Promoted (→global): entry ${entry.id} lifted to a global rule; source retired.`,
        },
      };
    }

    default: {
      const _exhaustive: never = opts.target;
      throw new CommandError(`Unknown promote target: ${String(_exhaustive)}`);
    }
  }
}

export interface DeletePlan {
  retireEntryId: string;
  audit: { kind: "learning"; body: string };
}

/** DELETE = the existing non-destructive retire. Throws `CommandError` if already retired. */
export function planDelete(entry: MemoryEntry): DeletePlan {
  if (isRetired(entry)) {
    throw new CommandError(
      `Cannot delete memory entry ${entry.id}: it is already retired.`,
    );
  }
  return {
    retireEntryId: entry.id,
    audit: {
      kind: "learning",
      body: `Deleted (retire): entry ${entry.id} retired; nothing physically removed.`,
    },
  };
}
