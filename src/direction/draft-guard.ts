import { CommandError } from "../errors.js";

/**
 * The single teaching draft refusal. Every caller-direction-targeted command
 * that needs a version (regenerate, approve, asset extract, asset pack with an
 * explicit --direction) routes a draft through this, so the refusal always
 * names the fix instead of crashing or fabricating a version. Pure, no I/O —
 * this is the single source of the draft-refusal wording.
 */
export function assertDirectionHasVersions(
  directionId: string,
  head: string | null,
): asserts head is string {
  if (head === null) {
    throw new CommandError(
      `Direction "${directionId}" has no versions yet — run \`keyart explore ${directionId}\` to generate v1 first.`,
    );
  }
}
