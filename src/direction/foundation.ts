import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { directionsRoot } from "../config.js";
import { CommandError } from "../errors.js";
import type { DirectionTokens, DirectionVersion, KeyartConfig } from "../types.js";
import { DIRECTION_SLUG_RE } from "./schema.js";
import { readVersion, resolveDirection } from "./store.js";

export interface FoundationContext {
  readonly directionId: string;
  readonly versionId: string;
  readonly briefSnapshot: string;
  readonly content: DirectionVersion;
  readonly tokens: DirectionTokens | undefined;
  readonly versionDir: string;
  /** Absolute selected tile, or null when this foundation has no image. */
  readonly tilePath: string | null;
  readonly imageReady: boolean;
}

export function assertFoundationId(id: string, kind: "direction" | "version"): void {
  const valid = kind === "direction" ? DIRECTION_SLUG_RE.test(id) : /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id);
  if (!valid) throw new CommandError(`Invalid ${kind} id: ${id}. Use an existing ${kind} id, not a path.`);
}

/** Reject symlinks/junctions escaping the selected owner as well as ../ paths. */
export async function assertFoundationPath(parent: string, child: string): Promise<void> {
  const [base, target] = await Promise.all([realpath(parent), realpath(child)]);
  const relative = path.relative(base, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new CommandError("Foundation path escapes its owning direction.");
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** A foundation resolves only frozen version facts; never mutable brief/head or sibling imagery. */
export async function resolveFoundation(opts: {
  cwd: string;
  config: KeyartConfig;
  directionId: string;
  versionId: string;
}): Promise<FoundationContext> {
  assertFoundationId(opts.directionId, "direction");
  if (!opts.versionId) throw new CommandError("Select an explicit foundation version with --version. Drafts need Generate v1 first.");
  assertFoundationId(opts.versionId, "version");
  const direction = await resolveDirection(opts.cwd, opts.config, opts.directionId);
  await assertFoundationPath(directionsRoot(opts.cwd, opts.config), direction.dir);
  if (direction.record.id !== opts.directionId) {
    throw new CommandError("Foundation direction identity does not match its requested owner.");
  }
  if (!direction.record.versions.includes(opts.versionId)) {
    throw new CommandError(`Foundation ${opts.directionId}@${opts.versionId} is not in this direction's history. Drafts need Generate v1 first.`);
  }
  const versionDir = path.join(direction.versionsDir, opts.versionId);
  await assertFoundationPath(direction.dir, versionDir);
  await assertFoundationPath(versionDir, path.join(versionDir, "direction-version.json"));
  const content = await readVersion(directionsRoot(opts.cwd, opts.config), opts.directionId, opts.versionId);
  if (!content || content.id !== opts.versionId || typeof content.briefSnapshot !== "string" ||
      typeof content.contextSnapshot !== "string" || typeof content.name !== "string" ||
      typeof content.summary !== "string" || !content.character || typeof content.character !== "object" ||
      !content.usage || !Array.isArray(content.usage.rules) || !Array.isArray(content.usage.antiRules)) {
    throw new CommandError(`Unsupported foundation record: ${opts.directionId}@${opts.versionId}. Migrate the saved version before using it.`);
  }
  let tilePath: string | null = path.join(versionDir, "style-tile.png");
  try {
    if (!(await stat(tilePath)).isFile()) tilePath = null;
    if (tilePath) await assertFoundationPath(versionDir, tilePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    tilePath = null;
  }
  return freeze({ directionId: opts.directionId, versionId: opts.versionId,
    briefSnapshot: content.briefSnapshot, content, tokens: content.tokens,
    versionDir, tilePath, imageReady: tilePath !== null });
}
