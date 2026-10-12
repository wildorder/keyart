import { CommandError } from "../errors.js";

/**
 * The single teaching draft refusal. Every caller-direction-targeted command
 * that defaults to its head (regenerate, approve, asset pack with an
 * explicit --direction) routes a draft through this, so the refusal always
 * names the fix instead of crashing or fabricating a version. Pure, no I/O —
 * explicit foundation resolver handles Board/asset generation separately.
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
