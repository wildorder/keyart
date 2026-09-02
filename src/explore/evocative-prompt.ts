import type { DirectionContent } from "../types.js";
import { composeContentLock } from "./token-intent.js";
import { composeArtDirection } from "./compose-art-direction.js";
import type { AssembledContext } from "../brand/assemble-context.js";

/**
 * Compose the creative prompt for the EVOCATIVE moodboard/style-board image — a
 * best-effort mood/texture/UI-vignette board, distinct from the deterministic
 * SVG/markdown board. Pure and deterministic so regenerate (and, if ever
 * enabled, explore) share ONE implementation.
 *
 * Structure, in order:
 *   1. a moodboard creative description derived from the direction's name/summary;
 *   2. the authoritative CONTENT LOCK (current name/summary/positioning/character/
 *      usage rules + headline/subhead/CTA) so the moodboard reflects the direction's
 *      CURRENT editable fields, overriding any stale copy;
 *   3. the art-direction compiler tail (MUST → live one-shot → PREFER → AVOID →
 *      soft color guidance) — exactly one `composeArtDirection` call.
 *
 * The `tweak` (one-shot) is threaded through the compiler as `opts.oneShot` so
 * the directive precedence ladder is assembled exactly once. Empty assembled +
 * no tweak + no locks ⇒ the compiler returns "" ⇒ the board is byte-identical
 * to the pre-WS-03 no-negatives/no-locks board (SC-11). Never throws.
 */
export function composeEvocativeBoardPrompt(
  direction: DirectionContent,
  assembled: AssembledContext,
  tweak?: string,
  lockedColors?: string[],
): string {
  const creative = `A cohesive moodboard / style board for "${direction.name}": ${direction.summary}. Evocative imagery, textures, and UI vignettes capturing the mood.`;
  const parts: string[] = [creative];
  parts.push(composeContentLock(direction));
  const artTail = composeArtDirection(assembled, {
    oneShot: tweak,
    lockedColors,
  });
  if (artTail) parts.push(artTail);
  return parts.join("\n\n");
}
