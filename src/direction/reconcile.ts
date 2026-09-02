import type {
  Contradiction,
  ContradictionRef,
  ContradictionReport,
  ReconciliationAction,
} from "../brand/conflict-guard.js";
import type { MemoryEntry } from "./schema.js";
import type { RuleSeverity } from "../brand/schema.js";
import { CommandError } from "../errors.js";

/** Import the single four-action union; do not redeclare it. */
export type ReconcileAction = ReconciliationAction;

/** An entry is retired iff either marker is present (supersede sets both). */
export function isRetired(
  entry: Pick<MemoryEntry, "retiredAt" | "supersededBy">,
): boolean {
  return entry.retiredAt !== undefined || entry.supersededBy !== undefined;
}

/** A declarative, pure write plan the core executes (all writes versioned + append-only). */
export interface ReconcilePlan {
  action: ReconcileAction;
  /** The stale entry to mark retired (retire/supersede only). Its body/attribution are NEVER changed. */
  retireEntryId?: string;
  /** For supersede: the id of the winning entry recorded as `supersededBy` on the retired entry. */
  supersededByEntryId?: string;
  /** A global rule to add via brandCore.promoteLearning (promote only). */
  promote?: { text: string; severity: RuleSeverity };
  /** An attributed audit entry appended to direction memory (ALWAYS — the append-only record of the action). */
  audit: { kind: "learning"; body: string };
}

export interface PlanReconciliationInput {
  contradiction: Contradiction;
  action: ReconcileAction;
  /** For supersede/promote: which side wins. Defaults to `subject` (the newer/live side). */
  winner?: "subject" | "conflictsWith";
  /** promote severity (default "guideline"). */
  severity?: RuleSeverity;
}

/** The ONE transport-neutral contract imported by server-api, commands, and MCP. */
export interface ReconciliationListResponse {
  directionId: string;
  report: ContradictionReport;
  memoryVersion: number;
  globalVersion: number;
}
export interface ReconciliationResolveRequest {
  contradiction: Contradiction;
  action: ReconciliationAction;
  winner: "subject" | "conflictsWith";
  severity?: RuleSeverity;
  /** Required for every action unless force=true. */
  expectedMemoryVersion?: number;
  /** Additionally required for promote unless force=true. */
  expectedGlobalVersion?: number;
  force?: boolean;
}
export interface ReconciliationResolveResponse {
  directionId: string;
  contradictionId: string;
  action: ReconciliationAction;
  memoryVersion: number;
  /** Resulting global version; unchanged for direction-only actions. */
  globalVersion: number;
}

export function planReconciliation(input: PlanReconciliationInput): ReconcilePlan {
  const { contradiction, action, winner: winnerSide = "subject", severity } = input;

  const winnerRef: ContradictionRef =
    winnerSide === "subject" ? contradiction.subject : contradiction.conflictsWith;
  const loserRef: ContradictionRef =
    winnerSide === "subject" ? contradiction.conflictsWith : contradiction.subject;

  switch (action) {
    case "keep": {
      return {
        action: "keep",
        audit: {
          kind: "learning",
          body: `Reconciled (keep): kept both "${winnerRef.text}" and "${loserRef.text}" — no retirement applied.`,
        },
      };
    }

    case "retire": {
      if (loserRef.source === "hard-rule") {
        throw new CommandError(
          `Cannot retire a hard rule: "${loserRef.text}". Hard rules are never auto-overridden.`,
        );
      }
      if (loserRef.source === "guideline") {
        throw new CommandError(
          `Cannot retire a guideline: "${loserRef.text}". Only memory entries (feedback/learning/decision) are retirable.`,
        );
      }
      if (loserRef.source !== "memory") {
        throw new CommandError(
          `Cannot retire a non-memory entry (source: "${loserRef.source}"). Only memory entries are retirable.`,
        );
      }
      return {
        action: "retire",
        retireEntryId: loserRef.id,
        audit: {
          kind: "learning",
          body: `Reconciled (retire): retired memory entry ${loserRef.id} — "${loserRef.text}" (conflicted with "${winnerRef.text}").`,
        },
      };
    }

    case "supersede": {
      if (loserRef.source === "hard-rule") {
        throw new CommandError(
          `Cannot supersede a hard rule: "${loserRef.text}". Hard rules are never auto-overridden.`,
        );
      }
      if (loserRef.source === "guideline") {
        throw new CommandError(
          `Cannot supersede a guideline: "${loserRef.text}". Only memory entries are supersedable.`,
        );
      }
      if (loserRef.source !== "memory") {
        throw new CommandError(
          `Cannot supersede a non-memory entry (source: "${loserRef.source}").`,
        );
      }
      if (winnerRef.source !== "memory") {
        throw new CommandError(
          `Cannot supersede with a non-memory winner (source: "${winnerRef.source}"). ` +
            `The superseding entry must be a persisted memory entry with a stable id.`,
        );
      }
      return {
        action: "supersede",
        retireEntryId: loserRef.id,
        supersededByEntryId: winnerRef.id,
        audit: {
          kind: "learning",
          body: `Reconciled (supersede): retired memory entry ${loserRef.id} — "${loserRef.text}" superseded by ${winnerRef.id} — "${winnerRef.text}".`,
        },
      };
    }

    case "promote": {
      if (winnerRef.source !== "memory") {
        throw new CommandError(
          `Cannot promote a non-memory winner (source: "${winnerRef.source}"). ` +
            `Only persisted memory entries can be promoted to global rules.`,
        );
      }
      return {
        action: "promote",
        promote: {
          text: winnerRef.text,
          severity: severity ?? "guideline",
        },
        audit: {
          kind: "learning",
          body: `Promotion requested: memory entry ${winnerRef.id} — "${winnerRef.text}" proposed as a global rule (severity: ${severity ?? "guideline"}).`,
        },
      };
    }

    default: {
      const _exhaustive: never = action;
      throw new CommandError(`Unknown reconciliation action: ${String(_exhaustive)}`);
    }
  }
}
