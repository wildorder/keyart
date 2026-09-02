import path from "node:path";
import { readdir } from "node:fs/promises";
import YAML from "yaml";
import { pathExists, readTextFile, ensureDir, writeJsonFile } from "../fs.js";
import { CommandError } from "../errors.js";
import { directionsRoot } from "../config.js";
import type { KeyartConfig, Direction, DirectionVersion } from "../types.js";
import { parseDirectionRecord, type DirectionRecord } from "./schema.js";

/**
 * The on-disk direction store: directions live flat under
 * `directionsRoot(cwd,config)/<directionId>/`, each carrying a versioned
 * `direction.yaml` record (identity, brief, assets, `versions[]`, `head`) and
 * an ordered `versions/<versionId>/` tree (`direction-version.json` + the
 * human-readable projections written by `write-direction-version.ts`).
 *
 * Everything here is pure/fs-only (no model calls, no store abstraction — the
 * record is read directly, mirroring `FileStore`'s own read path) and never
 * throws on a missing OPTIONAL file — the read helpers throw a `CommandError`
 * only when a NAMED direction/version is genuinely absent (a caller error),
 * while `listDirectionIds` on an absent root returns `[]`.
 */

const RECORD_FILE = "direction.yaml";
const VERSION_FILE = "direction-version.json";

/** kebab-case slug for a direction id, falling back to a stable base. */
function slugify(base: string): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "direction";
}

/**
 * Mint a collision-safe directionId directly under `directionsRootDir`:
 * slugify `base`, then disambiguate with a numeric suffix (`-2`, `-3`, …)
 * against existing direction folders so a fresh explore never overwrites a
 * sibling.
 */
export async function mintDirectionId(
  directionsRootDir: string,
  base: string,
): Promise<string> {
  const slug = slugify(base);
  let id = slug;
  let n = 2;
  while (await pathExists(path.join(directionsRootDir, id))) {
    id = `${slug}-${n}`;
    n += 1;
  }
  return id;
}

/**
 * Mint a timestamp versionId under `versionsDir` (ISO 8601 with `:`/`.` → `-`),
 * disambiguated with a numeric suffix on a same-millisecond collision. Never
 * reuses an existing version folder.
 */
export async function mintVersionId(versionsDir: string): Promise<string> {
  const base = new Date().toISOString().replace(/[:.]/g, "-");
  let id = base;
  let n = 2;
  while (await pathExists(path.join(versionsDir, id))) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

/** Sorted direction folder names under `directionsRootDir`; `[]` when absent. */
export async function listDirectionIds(
  directionsRootDir: string,
): Promise<string[]> {
  try {
    const entries = await readdir(directionsRootDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read a direction's persisted record directly off disk — pure fs + YAML,
 * mirroring `FileStore`'s own read path (no store instantiation needed for a
 * plain read). Throws a `CommandError` naming the direction when the record is
 * absent or unparseable.
 */
async function readRecord(
  directionsRootDir: string,
  directionId: string,
): Promise<DirectionRecord> {
  const recordPath = path.join(directionsRootDir, directionId, RECORD_FILE);
  if (!(await pathExists(recordPath))) {
    throw new CommandError(`Direction not found: ${directionId}`);
  }
  let raw: unknown;
  try {
    raw = YAML.parse(await readTextFile(recordPath));
  } catch {
    throw new CommandError(
      `Direction record is unreadable: ${directionId} (${RECORD_FILE}).`,
    );
  }
  return parseDirectionRecord(raw);
}

function versionsDirOf(directionsRootDir: string, directionId: string): string {
  return path.join(directionsRootDir, directionId, "versions");
}

/**
 * Read one version (`versions/<versionId>/direction-version.json`). Throws a
 * `CommandError` naming the direction + version when absent or unparseable.
 */
export async function readVersion(
  directionsRootDir: string,
  directionId: string,
  versionId: string,
): Promise<DirectionVersion> {
  const versionPath = path.join(
    versionsDirOf(directionsRootDir, directionId),
    versionId,
    VERSION_FILE,
  );
  if (!(await pathExists(versionPath))) {
    throw new CommandError(`Version not found: ${directionId}@${versionId}`);
  }
  try {
    return JSON.parse(await readTextFile(versionPath)) as DirectionVersion;
  } catch {
    throw new CommandError(
      `Version is unreadable: ${directionId}@${versionId} (${VERSION_FILE}).`,
    );
  }
}

/**
 * Read the head version of a direction. Throws a `CommandError` naming the
 * direction when it is a draft (`head === null`) — a draft has no version to
 * read yet. Use {@link readHeadOrNull} to handle a draft without throwing.
 */
export async function readHead(
  directionsRootDir: string,
  directionId: string,
): Promise<DirectionVersion> {
  const record = await readRecord(directionsRootDir, directionId);
  if (record.head === null) {
    throw new CommandError(
      `Direction "${directionId}" is a draft (no versions yet) — nothing to read.`,
    );
  }
  return readVersion(directionsRootDir, directionId, record.head);
}

/** Like {@link readHead}, but resolves to `null` on a draft instead of throwing. */
export async function readHeadOrNull(
  directionsRootDir: string,
  directionId: string,
): Promise<DirectionVersion | null> {
  const record = await readRecord(directionsRootDir, directionId);
  if (record.head === null) return null;
  return readVersion(directionsRootDir, directionId, record.head);
}

/**
 * Hydrate a full `Direction` — `{ id, versions: [...] }` — by reading each
 * version file in the record's `versions` order.
 */
export async function readDirection(
  directionsRootDir: string,
  directionId: string,
): Promise<Direction> {
  const record = await readRecord(directionsRootDir, directionId);
  const versions: DirectionVersion[] = [];
  for (const versionId of record.versions) {
    versions.push(await readVersion(directionsRootDir, directionId, versionId));
  }
  return { id: record.id, versions };
}

export interface ResolvedDirection {
  id: string;
  record: DirectionRecord;
  dir: string; // absolute brand/directions/<id>
  briefPath: string; // absolute <dir>/brief.md
  versionsDir: string; // absolute <dir>/versions
  assetsDir: string; // absolute <dir>/assets
  extractedAssetsDir: string; // absolute <dir>/extracted-assets
}

/**
 * Resolves a direction id to a {@link ResolvedDirection}. NEVER auto-creates —
 * an unknown id throws a `CommandError` listing every available id and naming
 * `keyart direction new`.
 */
export async function resolveDirection(
  cwd: string,
  config: KeyartConfig,
  id: string,
): Promise<ResolvedDirection> {
  const root = directionsRoot(cwd, config);

  let record: DirectionRecord;
  try {
    record = await readRecord(root, id);
  } catch (err) {
    if (err instanceof CommandError) {
      const ids = await listDirectionIds(root);
      const available = ids.length > 0 ? ids.join(", ") : "(none yet)";
      throw new CommandError(
        `Direction not found: ${id}. Available directions: ${available}. ` +
          `Run \`keyart direction new\` to create one.`,
      );
    }
    throw err;
  }

  const dir = path.join(root, id);
  return {
    id,
    record,
    dir,
    briefPath: path.join(dir, "brief.md"),
    versionsDir: path.join(dir, "versions"),
    assetsDir: path.join(dir, "assets"),
    extractedAssetsDir: path.join(dir, "extracted-assets"),
  };
}

/**
 * Writes a version file to the specified version directory. This is a low-level
 * write path (no core) used by tests to pre-seed version content before
 * `appendVersion` registers it on the record.
 *
 * Does NOT bump the direction record's version; it only writes the version file.
 */
export async function writeVersion(
  versionDir: string,
  directionId: string,
  versionId: string,
  version: DirectionVersion,
): Promise<void> {
  const versionPath = path.join(versionDir, VERSION_FILE);
  await ensureDir(versionDir);
  await writeJsonFile(versionPath, version);
}
