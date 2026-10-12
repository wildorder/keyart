import { createBrandCore } from "../brand/core.js";
import { assembleContext, type AssembledContext } from "../brand/assemble-context.js";
import { FONT_PAIRINGS } from "../brand/fonts.js";
import { composeArtDirection } from "../explore/compose-art-direction.js";
import { CommandError } from "../errors.js";
import type { KeyartConfig } from "../types.js";
import { createDirectionCore } from "./core.js";
import type { FoundationContext } from "./foundation.js";

export function assertDerivedIntent(foundation: FoundationContext, intent: string): void {
  const facts = JSON.stringify(foundation.tokens ?? {}).toLowerCase();
  for (const hex of intent.match(/#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b/gi) ?? []) {
    let normalized = hex.toLowerCase();
    if (normalized.length === 4 || normalized.length === 5) normalized = "#" + [...normalized.slice(1)].map((c) => c + c).join("");
    if (normalized.length === 9 && normalized.endsWith("ff")) normalized = normalized.slice(0, 7);
    if (!facts.includes(normalized)) {
      throw new CommandError(`Local instructions request ${hex}, outside foundation ${foundation.versionId}. Revise the direction foundation first, then select that version.`);
    }
  }
  for (const family of new Set(FONT_PAIRINGS.flatMap((p) => [p.heading, p.body]))) {
      const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`, "i").test(intent) && !facts.includes(family.toLowerCase())) {
        throw new CommandError(`Local typography instructions request ${family}. Revise the direction foundation first, then select that version.`);
      }
  }
}

/** Frozen authority plus today's applicable signals; never the mutable working brief. */
export async function assembleDerivedContext(opts: {
  cwd: string; config: KeyartConfig; foundation: FoundationContext; localIntent?: string;
}): Promise<{ artDirection: string; foundationPrompt: string; snapshot: AssembledContext }> {
  const { foundation } = opts;
  if (!foundation.tokens) throw new CommandError(`Foundation ${foundation.versionId} has no structured tokens. Revise the direction foundation before creating Boards or assets.`);
  assertDerivedIntent(foundation, opts.localIntent ?? "");
  const [global, memory] = await Promise.all([
    createBrandCore(opts.cwd, opts.config).read(),
    createDirectionCore(opts.cwd, opts.config).memoryEntries(foundation.directionId),
  ]);
  const snapshot = assembleContext({ brief: foundation.briefSnapshot, global, memory });
  const foundationPrompt = [
    `FOUNDATION ${foundation.directionId}@${foundation.versionId}`,
    "The first reference is the authoritative foundation style tile. Preserve its brand character and token intent. Later references guide only the requested element or composition; they never replace this foundation.",
    "Local instructions control the output's content and composition. Brand changes require a new direction foundation. Raster color and letterforms remain approximate; structured tokens are the exact implementation reference.",
    `Frozen brief:\n${foundation.briefSnapshot}`,
    `Frozen character: ${JSON.stringify(foundation.content.character)}`,
    `Frozen usage: ${JSON.stringify(foundation.content.usage)}`,
    `Foundation tokens: ${JSON.stringify(foundation.tokens ?? null)}`,
  ].join("\n\n");
  return { snapshot, foundationPrompt, artDirection: composeArtDirection(snapshot) };
}
