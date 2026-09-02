import type { KeyartConfig } from "../types.js";
import { CommandError } from "../errors.js";
import { VersionConflictError } from "../store/versioned-store.js";
import { createBrandCore, type BrandCore } from "./core.js";
import { createDirectionCore, type DirectionCore } from "../direction/core.js";
import type { RuleSeverity, DirectiveChannel, DirectivePolarity } from "./schema.js";

export interface PromoteEntryToGlobalInput {
  directionId: string;
  /** The SOURCE memory entry being promoted (retired after the global write succeeds). */
  entry: {
    id: string;
    body: string;
    channel?: DirectiveChannel;
    polarity?: DirectivePolarity;
  };
  severity?: RuleSeverity; // default "guideline" (via promoteLearning)
  author: string;
  source: string;
  /** Preflight guard for the source-retire write (unless force). */
  expectedMemoryVersion?: number;
  /** Preflight guard for the global write (unless force). */
  expectedGlobalVersion?: number;
  force?: boolean;
}

export interface PromoteEntryToGlobalResult {
  ruleId: string;
  memoryVersion: number;
  globalVersion: number;
}

/**
 * Thrown when the global rule write succeeds but the source-entry retire
 * subsequently fails on a version conflict (the residual race — two stores,
 * no cross-store transaction). Honest by construction: NEVER claims rollback
 * or atomicity. `committed: "global"` means exactly that — the rule is live
 * and the source is NOT retired; the caller must refresh the memory version
 * and explicitly retry the retire.
 */
export class PromotePartialError extends CommandError {
  readonly committed = "global" as const;
  readonly ruleId: string;
  readonly globalVersion: number;
  readonly expectedMemoryVersion?: number;
  readonly actualMemoryVersion: number;
  readonly retryable = true as const;

  constructor(params: {
    ruleId: string;
    globalVersion: number;
    expectedMemoryVersion?: number;
    actualMemoryVersion: number;
  }) {
    super(
      `Promote partially committed: global rule ${params.ruleId} was written, but retiring ` +
        `the source memory entry failed (version conflict — expected ${params.expectedMemoryVersion}, ` +
        `found ${params.actualMemoryVersion}). The global rule is NOT rolled back. Refresh the memory ` +
        `version and retry the retire.`,
    );
    this.name = "PromotePartialError";
    this.ruleId = params.ruleId;
    this.globalVersion = params.globalVersion;
    this.expectedMemoryVersion = params.expectedMemoryVersion;
    this.actualMemoryVersion = params.actualMemoryVersion;
  }
}

export interface PromoteEntryToGlobalDeps {
  brandCore: BrandCore;
  directionCore: DirectionCore;
}
export interface PromoteEntryToGlobalCwdDeps {
  cwd: string;
  config: KeyartConfig;
}

/**
 * The promote-to-global seam: `promoteLearning`s the source entry's
 * text/channel/polarity/severity into a new global rule, THEN retires the
 * source memory entry. Two stores, no cross-store transaction — preflights
 * BOTH versions (unless forced) before any write, so a stale caller is
 * rejected before either store is touched; a residual race on the SECOND
 * write surfaces an explicit `PromotePartialError` rather than a false
 * rollback claim.
 */
export async function promoteEntryToGlobal(
  deps: PromoteEntryToGlobalDeps | PromoteEntryToGlobalCwdDeps,
  input: PromoteEntryToGlobalInput,
): Promise<PromoteEntryToGlobalResult> {
  const { brandCore, directionCore } =
    "brandCore" in deps
      ? deps
      : {
          brandCore: createBrandCore(deps.cwd, deps.config),
          directionCore: createDirectionCore(deps.cwd, deps.config),
        };

  const { directionId, entry, author, source, severity, force } = input;

  if (!force) {
    const [globalCurrent, memoryCurrent] = await Promise.all([
      brandCore.read(),
      directionCore.readMemory(directionId),
    ]);
    if (
      input.expectedGlobalVersion !== undefined &&
      input.expectedGlobalVersion !== globalCurrent.version
    ) {
      throw new VersionConflictError(
        "global brand",
        input.expectedGlobalVersion,
        globalCurrent.version,
      );
    }
    if (
      input.expectedMemoryVersion !== undefined &&
      input.expectedMemoryVersion !== memoryCurrent.version
    ) {
      throw new VersionConflictError(
        `direction memory (${directionId})`,
        input.expectedMemoryVersion,
        memoryCurrent.version,
      );
    }
  }

  // Global write first — a promoted signal must never exist un-audited at the source.
  const brand = await brandCore.promoteLearning(
    {
      fromDirectionId: directionId,
      text: entry.body,
      severity,
      channel: entry.channel,
      polarity: entry.polarity,
      author,
    },
    { expectedVersion: input.expectedGlobalVersion, force },
  );
  const ruleId = brand.rules[brand.rules.length - 1].id;

  // Source retire second — ALWAYS retires the source so nothing double-counts.
  try {
    const memory = await directionCore.retireMemoryEntry(
      directionId,
      {
        entryId: entry.id,
        author,
        source,
        reason: `Promoted to global rule ${ruleId}.`,
      },
      { expectedVersion: input.expectedMemoryVersion, force },
    );
    return { ruleId, memoryVersion: memory.version, globalVersion: brand.version };
  } catch (err) {
    if (err instanceof VersionConflictError) {
      throw new PromotePartialError({
        ruleId,
        globalVersion: brand.version,
        expectedMemoryVersion: input.expectedMemoryVersion,
        actualMemoryVersion: err.actualVersion,
      });
    }
    throw err;
  }
}
