import type { AssembledContext } from "../brand/assemble-context.js";
import { classifyDirective, fromRule } from "../brand/classify-directive.js";
import {
  composeLockedColorsGuidance,
  composeNegativesBlock,
} from "./token-intent.js";

export interface ComposeArtDirectionOptions {
  /**
   * LIVE one-shot art direction for THIS pass only (a `--tweak` / `feedbackNote`).
   * Rung 2 of the ladder — between MUST and PREFER. Never persisted into direction
   * content or memory; prompt files and contextSnapshot retain it as generation
   * provenance. Absent/blank ⇒ omitted.
   */
  oneShot?: string;
  /**
   * The user's LOCKED colors (hex). Soft guidance, no fonts. Absorbed from
   * composeLockedColorsGuidance. Absent/empty ⇒ omitted.
   */
  lockedColors?: string[];
}

/**
 * The SHARED art-direction compiler — the visual sibling of `renderContextBlock`.
 * Projects the assembled context's `visualDirectives` (+ a live one-shot + soft
 * locked-color guidance) into ONE precedence-ordered image-prompt tail.
 * WS-03 invokes it once per generated prompt: style tile and homepage on explore;
 * those two plus the distinct evocative board on regenerate.
 * Pure + deterministic — no I/O.
 *
 * Precedence ladder (SC-06), each present tier LABELED:
 *   MUST  ▸  live one-shot  ▸  PREFER (do)  ▸  AVOID  ▸  soft color guidance
 * (the ladder's "brief" rung lives in the text lane / content lock, not here.)
 *
 * BYTE-IDENTICAL no-directive contract (SC-11): when there are no visual
 * directives, no one-shot, and no locked colors, this returns `""` — so a
 * caller that does `base + (tail ? "\n\n" + tail : "")` produces output
 * byte-identical to today's `composeLockedColorsGuidance`/`composeNegativesBlock`
 * = null path.
 *
 * Color guidance goes LAST so the assembled prompt reads:
 *   base → content lock → MUST → one-shot → PREFER → AVOID → color
 */
export function composeArtDirection(
  assembled: AssembledContext,
  opts: ComposeArtDirectionOptions = {},
): string {
  const { must, prefer, avoid } = assembled.visualDirectives;
  const parts: string[] = [];

  // MUST: non-negotiable visual hard rules
  if (must.length > 0) {
    parts.push(
      ["MUST (non-negotiable — always obey):", ...must.map((m) => `- ${m}`)].join("\n"),
    );
  }

  // LIVE ONE-SHOT: this-pass-only art direction (never persisted)
  const one = opts.oneShot?.trim();
  if (one) {
    parts.push(`Additional art direction (this pass only): ${one}`);
  }

  // PREFER: positive visual directives (guidelines + direction decisions)
  if (prefer.length > 0) {
    parts.push(
      ["PREFER (do):", ...prefer.map((p) => `- ${p}`)].join("\n"),
    );
  }

  // AVOID: negative visual directives — re-uses composeNegativesBlock verbatim
  // so the discard-only case is byte-identical to the old composeNegativesBlock path.
  const avoidBlock = composeNegativesBlock(avoid);
  if (avoidBlock) parts.push(avoidBlock);

  // SOFT COLOR GUIDANCE: re-uses composeLockedColorsGuidance verbatim so its
  // exact string is preserved byte-for-byte.
  const guidance = composeLockedColorsGuidance(opts.lockedColors ?? []);
  if (guidance) parts.push(guidance);

  return parts.join("\n\n");
}

/**
 * Deterministic snapshot renderer for the `## Art-direction precedence` section.
 * Lists all six SC-06 rungs with their effective entries (or `(none)` when empty),
 * in stable input order. WS-03 appends this to `DirectionVersion.contextSnapshot`
 * before calling `writeDirectionVersion`; that writer projects the frozen string
 * to `context-snapshot.md`.
 *
 * This is PROVENANCE only — it must not call `composeArtDirection`, must not
 * replace or alter `renderContextBlock`, and must not make a model call.
 */
export function renderArtDirectionPrecedence(
  assembled: AssembledContext,
  opts: Pick<ComposeArtDirectionOptions, "oneShot"> = {},
): string {
  const lines: string[] = ["## Art-direction precedence"];

  // Rung 1: MUST — global hard rules
  lines.push("\n### 1. MUST — global hard rules");
  const hardVisual = assembled.hardRules.filter(
    (r) => classifyDirective(fromRule(r)).channel !== "copy",
  );
  if (hardVisual.length > 0) {
    for (const r of hardVisual) lines.push(`- ${r.text}`);
  } else {
    lines.push("(none)");
  }

  // Rung 2: LIVE — this-pass one-shot
  lines.push("\n### 2. LIVE — this-pass one-shot");
  const oneShot = opts.oneShot?.trim();
  if (oneShot) {
    lines.push(`- ${oneShot}`);
  } else {
    lines.push("(none)");
  }

  // Rung 3: PREFER/AVOID — global guidelines
  lines.push("\n### 3. PREFER/AVOID — global guidelines");
  const guidePrefer: string[] = [];
  const guideAvoid: string[] = [];
  for (const r of assembled.guidelines) {
    const cls = classifyDirective(fromRule(r));
    if (cls.channel === "copy") continue;
    if (cls.polarity === "prefer") guidePrefer.push(r.text);
    else guideAvoid.push(r.text);
  }
  if (guidePrefer.length === 0 && guideAvoid.length === 0) {
    lines.push("(none)");
  } else {
    if (guidePrefer.length > 0) {
      lines.push("PREFER:");
      for (const t of guidePrefer) lines.push(`- ${t}`);
    }
    if (guideAvoid.length > 0) {
      lines.push("AVOID:");
      for (const t of guideAvoid) lines.push(`- ${t}`);
    }
  }

  // Rung 4: PREFER/AVOID — direction decisions (non-discard direction memory)
  lines.push("\n### 4. PREFER/AVOID — direction decisions");
  const directionPrefer: string[] = [];
  const directionAvoid: string[] = [];
  for (const entry of assembled.memory) {
    if (entry.supersededBy || entry.retiredAt) continue;
    const isDiscard =
      entry.kind === "feedback" &&
      typeof entry.asset === "string" &&
      entry.asset.length > 0;
    if (isDiscard) continue;
    const cls = classifyDirective({
      origin: "memory",
      text: entry.body,
      kind: entry.kind,
      channel: entry.channel,
      polarity: entry.polarity,
    });
    if (cls.channel === "copy") continue;
    if (cls.polarity === "prefer") directionPrefer.push(entry.body);
    else directionAvoid.push(entry.body);
  }
  if (directionPrefer.length === 0 && directionAvoid.length === 0) {
    lines.push("(none)");
  } else {
    if (directionPrefer.length > 0) {
      lines.push("PREFER:");
      for (const t of directionPrefer) lines.push(`- ${t}`);
    }
    if (directionAvoid.length > 0) {
      lines.push("AVOID:");
      for (const t of directionAvoid) lines.push(`- ${t}`);
    }
  }

  // Rung 5: AVOID — discard feedback
  lines.push("\n### 5. AVOID — discard feedback");
  const discards = assembled.memory.filter(
    (e) =>
      e.kind === "feedback" &&
      typeof e.asset === "string" &&
      e.asset.length > 0 &&
      !e.supersededBy &&
      !e.retiredAt,
  );
  if (discards.length > 0) {
    for (const e of discards) lines.push(`- ${e.body}`);
  } else {
    lines.push("(none)");
  }

  // Rung 6: BRIEF — direction content/brief
  lines.push("\n### 6. BRIEF — direction content/brief");
  if (assembled.brief.trim().length > 0) {
    lines.push(assembled.brief.trim());
  } else {
    lines.push("(none)");
  }

  return lines.join("\n");
}
