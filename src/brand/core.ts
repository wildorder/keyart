import { createSingleDocStore } from "../store/create-store.js";
import type { SingleDocStore } from "../store/versioned-store.js";
import { globalBrandPath, storeDriver } from "../config.js";
import type { KeyartConfig } from "../types.js";
import { CommandError } from "../errors.js";
import {
  GlobalBrandSchema,
  parseGlobalBrand,
  type GlobalBrand,
  type GlobalRule,
  type RuleSeverity,
  type DirectiveChannel,
  type DirectivePolarity,
} from "./schema.js";

export interface AddRuleInput {
  severity: RuleSeverity;
  text: string;
  author: string;
  source: string;
  date?: string;
  channel?: DirectiveChannel;
  polarity?: DirectivePolarity;
}

/**
 * Promote a concept learning to a global rule. The CALLER reads the concept
 * learning and passes the text + attribution; brandCore never reads concept
 * memory itself.
 */
export interface PromoteLearningInput {
  fromDirectionId: string; // recorded into the rule's `source` as `promote:<id>`
  text: string;
  severity?: RuleSeverity; // default "guideline"
  author: string;
  date?: string;
  /** Carried onto the rule so a promoted visual-avoid decision reaches the image lane. */
  channel?: DirectiveChannel;
  polarity?: DirectivePolarity;
}

/** Patch accepted by `editRule` — only `text`/`severity` are amendable. */
export interface EditRulePatch {
  text?: string;
  severity?: RuleSeverity;
}

export interface BrandCore {
  /** Returns the global brand doc, scaffolding an empty one in memory (NOT written) when absent. */
  read(): Promise<GlobalBrand>;
  setPointer(
    pointer: { directionId: string; versionId: string },
    opts?: { force?: boolean },
  ): Promise<GlobalBrand>;
  addRule(input: AddRuleInput, opts?: { force?: boolean }): Promise<GlobalBrand>;
  promoteLearning(
    input: PromoteLearningInput,
    opts?: { expectedVersion?: number; force?: boolean },
  ): Promise<GlobalBrand>;
  /**
   * Non-destructively RETIRES a global rule (sets `retiredAt`; nothing physically
   * removed). Undoes a promote / drops a stale rule. Idempotent when already
   * retired (no-op, no write). Throws `CommandError` for an unknown id, writing
   * nothing. A HARD rule requires `opts.force` (hard-rules-win).
   */
  removeRule(
    ruleId: string,
    opts?: { force?: boolean; expectedVersion?: number },
  ): Promise<GlobalBrand>;
  /**
   * Amends a rule NON-DESTRUCTIVELY (retire-and-replace): retires the old rule
   * and appends a replacement carrying the edited `text`/`severity` — never
   * mutates a rule in place, so edit=supersede holds on the global layer too.
   * Throws `CommandError` for an unknown or already-retired id. Editing a HARD
   * rule, or escalating a guideline to hard, requires `opts.force`.
   */
  editRule(
    ruleId: string,
    patch: EditRulePatch,
    opts?: { force?: boolean; expectedVersion?: number },
  ): Promise<GlobalBrand>;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Generates an id that is unique within a single brand doc. */
function makeRuleId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `rule-${ts}-${rand}`;
}

export function createBrandCore(
  cwd: string,
  config: KeyartConfig,
): BrandCore {
  const store: SingleDocStore<GlobalBrand> = createSingleDocStore({
    driver: storeDriver(config),
    filePath: globalBrandPath(cwd, config),
    parse: parseGlobalBrand,
  });

  const core: BrandCore = {
    async read() {
      const doc = await store.read();
      if (doc === null) {
        // Scaffold an empty brand in memory ONLY — reads never write. The
        // global doc is created exclusively by a deliberate write below.
        const now = nowIso();
        return {
          approvedPointer: null,
          rules: [],
          version: 0,
          createdAt: now,
          updatedAt: now,
        };
      }
      return doc;
    },

    async setPointer(pointer, opts) {
      const current = await core.read();
      const next: GlobalBrand = GlobalBrandSchema.parse({
        ...current,
        approvedPointer: { ...pointer, approvedAt: nowIso() },
        // `rules` preserved unchanged — global rules survive every repoint
        // (the rebrand-keeps-rules guarantee).
        updatedAt: nowIso(),
      });
      return store.write(next, {
        expectedVersion: current.version,
        force: opts?.force,
      });
    },

    async addRule(input, opts) {
      const current = await core.read();
      const now = nowIso();
      const rule: GlobalRule = {
        id: makeRuleId(),
        severity: input.severity,
        text: input.text,
        author: input.author,
        source: input.source,
        date: input.date ?? now,
        ...(input.channel ? { channel: input.channel } : {}),
        ...(input.polarity ? { polarity: input.polarity } : {}),
      };
      const next: GlobalBrand = GlobalBrandSchema.parse({
        ...current,
        rules: [...current.rules, rule],
        updatedAt: now,
      });
      return store.write(next, {
        expectedVersion: current.version,
        force: opts?.force,
      });
    },

    async promoteLearning(input, opts) {
      const current = await core.read();
      const now = nowIso();
      const rule: GlobalRule = {
        id: makeRuleId(),
        severity: input.severity ?? "guideline",
        text: input.text,
        author: input.author,
        source: `promote:${input.fromDirectionId}`,
        date: input.date ?? now,
        ...(input.channel ? { channel: input.channel } : {}),
        ...(input.polarity ? { polarity: input.polarity } : {}),
      };
      const next: GlobalBrand = GlobalBrandSchema.parse({
        ...current,
        rules: [...current.rules, rule],
        updatedAt: now,
      });
      return store.write(next, {
        expectedVersion: opts?.expectedVersion ?? current.version,
        force: opts?.force,
      });
    },

    async removeRule(ruleId, opts) {
      const current = await core.read();
      const rule = current.rules.find((r) => r.id === ruleId);
      if (!rule) {
        throw new CommandError(`Rule not found: ${ruleId}.`);
      }
      // Idempotent: already retired ⇒ no-op, no write, no version bump.
      if (rule.retiredAt !== undefined) {
        return current;
      }
      if (rule.severity === "hard" && !opts?.force) {
        throw new CommandError(
          `Refusing to remove a hard rule ${ruleId} without force. Hard rules win; removing one weakens a brand guardrail — pass force to confirm.`,
        );
      }
      const now = nowIso();
      const nextRules = current.rules.map((r) =>
        r.id === ruleId ? { ...r, retiredAt: now } : r,
      );
      const next: GlobalBrand = GlobalBrandSchema.parse({
        ...current,
        rules: nextRules,
        updatedAt: now,
      });
      return store.write(next, {
        expectedVersion: opts?.expectedVersion ?? current.version,
        force: opts?.force,
      });
    },

    async editRule(ruleId, patch, opts) {
      const current = await core.read();
      const rule = current.rules.find((r) => r.id === ruleId);
      if (!rule) {
        throw new CommandError(`Rule not found: ${ruleId}.`);
      }
      if (rule.retiredAt !== undefined) {
        throw new CommandError(
          `Cannot edit retired rule ${ruleId}. A retired rule is history — recreate instead.`,
        );
      }
      const escalating = rule.severity !== "hard" && patch.severity === "hard";
      if (rule.severity === "hard" && !opts?.force) {
        throw new CommandError(
          `Refusing to edit a hard rule ${ruleId} without force. Hard rules win; editing one changes a brand guardrail — pass force to confirm.`,
        );
      }
      if (escalating && !opts?.force) {
        throw new CommandError(
          `Refusing to escalate rule ${ruleId} to hard without force. Hard rules win; escalating a guideline is a deliberate act — pass force to confirm.`,
        );
      }
      const now = nowIso();
      const replacement: GlobalRule = {
        id: makeRuleId(),
        severity: patch.severity ?? rule.severity,
        text: patch.text ?? rule.text,
        author: rule.author,
        source: `edit:${rule.id}`,
        date: now,
        ...(rule.channel ? { channel: rule.channel } : {}),
        ...(rule.polarity ? { polarity: rule.polarity } : {}),
      };
      const nextRules = current.rules.map((r) =>
        r.id === ruleId ? { ...r, retiredAt: now } : r,
      );
      nextRules.push(replacement);
      const next: GlobalBrand = GlobalBrandSchema.parse({
        ...current,
        rules: nextRules,
        updatedAt: now,
      });
      return store.write(next, {
        expectedVersion: opts?.expectedVersion ?? current.version,
        force: opts?.force,
      });
    },
  };

  return core;
}
