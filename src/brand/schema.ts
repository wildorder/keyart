import { z } from "zod";

export const RuleSeveritySchema = z.enum(["hard", "guideline"]);
export type RuleSeverity = z.infer<typeof RuleSeveritySchema>;

/**
 * Whether a directive is a VISUAL steer (reaches the image model), a COPY steer
 * (voice/wording only — never an image prompt), or BOTH. Optional on the record;
 * absent ⇒ resolved by classify-directive's defaults (hard rules + decisions ⇒
 * visual; plain learnings ⇒ copy). Additive + back-compat.
 */
export const DirectiveChannelSchema = z.enum(["visual", "copy", "both"]);
export type DirectiveChannel = z.infer<typeof DirectiveChannelSchema>;

/**
 * Which way a directive points: PREFER (do this) or AVOID (never do this).
 * Optional; absent ⇒ resolved by classify-directive's wording heuristic
 * (leading never/no/avoid/don't ⇒ avoid; otherwise prefer). Additive + back-compat.
 */
export const DirectivePolaritySchema = z.enum(["prefer", "avoid"]);
export type DirectivePolarity = z.infer<typeof DirectivePolaritySchema>;

/** A deliberately-authored global rule. Attribution required, mirroring memory entries. */
export const GlobalRuleSchema = z.object({
  id: z.string(),
  severity: RuleSeveritySchema,
  text: z.string(),
  author: z.string(),
  source: z.string(), // "cli" | "mcp" | "promote:<conceptId>" etc.
  date: z.string(), // ISO 8601
  /** Optional visual/copy channel (additive; absent ⇒ classifier default). */
  channel: DirectiveChannelSchema.optional(),
  /** Optional prefer/avoid polarity (additive; absent ⇒ classifier heuristic). */
  polarity: DirectivePolaritySchema.optional(),
  /**
   * NON-DESTRUCTIVE retire marker (mirrors MemoryEntry.retiredAt / AssetRef.retiredAt).
   * ISO 8601 timestamp at which this rule was retired. Absent ⇒ live. A retired
   * rule NEVER assembles (assemble-context drops it before the hard/guideline
   * split) so it reaches neither the MUST tier nor the text lane. Optional +
   * back-compat: existing brand.yaml rules parse + serialize unchanged. The write
   * verb that SETS it is `removeRule` (WS-03); true deletion is out of scope.
   */
  retiredAt: z.string().optional(), // ISO 8601
});
export type GlobalRule = z.infer<typeof GlobalRuleSchema>;

/** The single approved pointer — the rebrand switch. null until the first approve. */
export const ApprovedPointerSchema = z.object({
  directionId: z.string(),
  versionId: z.string(),
  approvedAt: z.string(), // ISO 8601 — when this pointer was set
});
export type ApprovedPointer = z.infer<typeof ApprovedPointerSchema>;

export const GlobalBrandSchema = z.object({
  approvedPointer: ApprovedPointerSchema.nullable().default(null),
  rules: z.array(GlobalRuleSchema).default([]),
  version: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GlobalBrand = z.infer<typeof GlobalBrandSchema>;

export const parseGlobalBrand = (raw: unknown): GlobalBrand =>
  GlobalBrandSchema.parse(raw);
