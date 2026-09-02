import path from "node:path";
import { readdir } from "node:fs/promises";
import { ensureDir, pathExists, readTextFile, writeJsonFile } from "../fs.js";
import { CommandError } from "../errors.js";
import {
  parseAssetVersion,
  parseExtractedAssetIndex,
  isExtractedAssetRetired,
  type AssetVersion,
  type ExtractedAsset,
  type ExtractedAssetIndex,
} from "./schema.js";

/**
 * The on-disk extracted-asset store: assets live under a direction's own tree at
 * `<directionDir>/extracted-assets/<assetId>/`, each carrying a tiny `asset.json`
 * index and an ordered `versions/<versionId>/` tree (`asset-version.json` +
 * the sibling artifacts WS-02 writes: `asset-prompt.md`, `asset.png`).
 *
 * Deliberately NOT behind the `VersionedStore` port — the direction-store
 * precedent: an append-only version tree with per-version folders and binary
 * blobs is not a single optimistic-concurrency document; collision-safe
 * minting + append-only writes are the concurrency discipline.
 *
 * Every exported function takes `directionDir` as its first parameter and
 * touches nothing outside `extractedAssetsRoot(directionDir)` — this is the
 * per-direction isolation invariant at the signature level. This store never
 * imports `config.ts`/`resolve.ts`; callers resolve the direction, the store is
 * a dumb tree. Reads never mutate, never backfill, never create; a `CommandError`
 * is thrown only when a NAMED asset/version is genuinely absent or malformed.
 */

const INDEX_FILE = "asset.json";
const VERSION_FILE = "asset-version.json";

/** Absolute root of a direction's extracted-asset tree: `<directionDir>/extracted-assets`. */
export function extractedAssetsRoot(directionDir: string): string {
  return path.join(directionDir, "extracted-assets");
}

/** Absolute path to one asset's own dir: `extracted-assets/<assetId>`. */
function assetDirOf(directionDir: string, assetId: string): string {
  return path.join(extractedAssetsRoot(directionDir), assetId);
}

/** Absolute path to an asset's `versions/` dir. */
function versionsDirOf(directionDir: string, assetId: string): string {
  return path.join(assetDirOf(directionDir, assetId), "versions");
}

/** kebab-case slug for an asset id, falling back to a stable base. */
function slugify(base: string): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "asset";
}

/**
 * Mint a collision-safe assetId: slugify `name`, then disambiguate with a
 * numeric suffix (`-2`, `-3`, …) against `existing` ids so a same-name
 * extract never clobbers a sibling. PURE + synchronous (mirrors
 * mintDirectionId's loop, but over a caller-supplied list instead of fs
 * probes — callers pass `await listAssetIds(...)`).
 */
export function mintAssetId(name: string, existing: string[]): string {
  const slug = slugify(name);
  const taken = new Set(existing);
  let id = slug;
  let n = 2;
  while (taken.has(id)) {
    id = `${slug}-${n}`;
    n += 1;
  }
  return id;
}

/**
 * Mint a timestamp version label (ISO 8601 with `:`/`.` → `-`), disambiguated
 * with a numeric suffix on a same-millisecond collision against `existing`
 * version ids (mirrors mintVersionId). PURE + synchronous.
 */
export function mintAssetVersionId(existing: string[]): string {
  const base = new Date().toISOString().replace(/[:.]/g, "-");
  const taken = new Set(existing);
  let id = base;
  let n = 2;
  while (taken.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

/** Sorted asset folder names under the direction's tree; `[]` when the tree is absent. */
export async function listAssetIds(directionDir: string): Promise<string[]> {
  try {
    const entries = await readdir(extractedAssetsRoot(directionDir), {
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Read an asset's index (`asset.json`), Zod-validated. Throws CommandError
 * naming the asset when absent, unreadable, or malformed.
 */
export async function readAssetIndex(
  directionDir: string,
  assetId: string,
): Promise<ExtractedAssetIndex> {
  const indexPath = path.join(assetDirOf(directionDir, assetId), INDEX_FILE);
  if (!(await pathExists(indexPath))) {
    throw new CommandError(`Extracted asset not found: ${assetId}`);
  }
  try {
    return parseExtractedAssetIndex(JSON.parse(await readTextFile(indexPath)));
  } catch {
    throw new CommandError(
      `Extracted-asset index is unreadable: ${assetId} (${INDEX_FILE}).`,
    );
  }
}

/** Write an asset's index (used by retire; append goes through appendVersionToIndex). */
export async function writeAssetIndex(
  directionDir: string,
  index: ExtractedAssetIndex,
): Promise<void> {
  const dir = assetDirOf(directionDir, index.id);
  await ensureDir(dir);
  await writeJsonFile(path.join(dir, INDEX_FILE), index);
}

/**
 * Read one version (`versions/<versionId>/asset-version.json`), Zod-validated.
 * Throws CommandError naming asset + version when absent or malformed.
 */
export async function readAssetVersion(
  directionDir: string,
  assetId: string,
  versionId: string,
): Promise<AssetVersion> {
  const versionPath = path.join(
    versionsDirOf(directionDir, assetId),
    versionId,
    VERSION_FILE,
  );
  if (!(await pathExists(versionPath))) {
    throw new CommandError(`Asset version not found: ${assetId}@${versionId}`);
  }
  try {
    return parseAssetVersion(JSON.parse(await readTextFile(versionPath)));
  } catch {
    throw new CommandError(
      `Asset version is unreadable: ${assetId}@${versionId} (${VERSION_FILE}).`,
    );
  }
}

/** Read the head version (index.head → readAssetVersion). */
export async function readAssetHead(
  directionDir: string,
  assetId: string,
): Promise<AssetVersion> {
  const index = await readAssetIndex(directionDir, assetId);
  return readAssetVersion(directionDir, assetId, index.head);
}

/**
 * Hydrate the full record — { id, name, directionId, versions: [...] } —
 * reading each version file in index order (last = head).
 */
export async function readExtractedAsset(
  directionDir: string,
  assetId: string,
): Promise<ExtractedAsset> {
  const index = await readAssetIndex(directionDir, assetId);
  const versions: AssetVersion[] = [];
  for (const versionId of index.versions) {
    versions.push(await readAssetVersion(directionDir, assetId, versionId));
  }
  return {
    id: index.id,
    name: index.name,
    directionId: index.directionId,
    versions,
  };
}

/**
 * Append one version: write `versions/<version.id>/asset-version.json` AND
 * advance the index — creating the index on v1 (from `meta`), appending +
 * head-advancing thereafter. APPEND-ONLY + IMMUTABILITY GUARD: an
 * already-existing `version.id` is REJECTED with a loud CommandError BEFORE
 * any byte is written — an existing version folder is never rewritten or
 * deleted (v2 leaves v1 byte-untouched); `meta` is only consulted at creation
 * (an existing index's name/directionId/retiredAt/slotId are preserved
 * verbatim — `slotId` joins that list so `asset regenerate` on a fill never
 * drops the surface-manifest linkage).
 *
 * Division of labor with WS-02: this store owns the two JSON records
 * (`asset.json`, `asset-version.json`); the WS-02 pipeline writes the sibling
 * artifacts (`asset-prompt.md`, `asset.png`) into the same version folder and
 * lists them in `version.files`. The store neither writes nor validates
 * those blobs.
 *
 * Returns the updated index.
 */
export async function appendVersionToIndex(
  directionDir: string,
  assetId: string,
  meta: { name: string; directionId: string; slotId?: string },
  version: AssetVersion,
): Promise<ExtractedAssetIndex> {
  const versionDir = path.join(versionsDirOf(directionDir, assetId), version.id);
  const versionFile = path.join(versionDir, VERSION_FILE);
  if (await pathExists(versionFile)) {
    throw new CommandError(
      `Asset "${assetId}" already has a version "${version.id}" — versions are immutable ` +
        `and never rewritten. Mint a fresh version id and retry.`,
    );
  }
  await ensureDir(versionDir);
  await writeJsonFile(versionFile, version);

  const indexPath = path.join(assetDirOf(directionDir, assetId), INDEX_FILE);
  let index: ExtractedAssetIndex;
  if (await pathExists(indexPath)) {
    index = parseExtractedAssetIndex(JSON.parse(await readTextFile(indexPath)));
    index = { ...index, versions: [...index.versions, version.id], head: version.id };
  } else {
    index = {
      id: assetId,
      name: meta.name,
      directionId: meta.directionId,
      versions: [version.id],
      head: version.id,
      ...(meta.slotId ? { slotId: meta.slotId } : {}),
    };
  }
  await writeAssetIndex(directionDir, index);
  return index;
}

/**
 * Link an EXISTING asset to a surface slot (surface-manifest WS-03): set the
 * additive `slotId` on its index. Non-destructive to everything else;
 * overwrites a previous linkage deliberately (relinking is an explicit act).
 * Throws CommandError (via readAssetIndex) when the asset is absent.
 */
export async function setExtractedAssetSlotId(
  directionDir: string,
  assetId: string,
  slotId: string,
): Promise<ExtractedAssetIndex> {
  const index = await readAssetIndex(directionDir, assetId);
  const linked = { ...index, slotId };
  await writeAssetIndex(directionDir, linked);
  return linked;
}

/**
 * Retire an asset: set the NON-DESTRUCTIVE `retiredAt` marker on its index
 * (the AssetRef.retiredAt idiom). Nothing on disk is deleted — the full
 * version tree and PNGs remain; downstream reads (shelf/pack/dashboard)
 * filter on isExtractedAssetRetired. IDEMPOTENT: retiring an already-retired
 * asset is a no-op that preserves the ORIGINAL retiredAt and returns the
 * index unchanged. Throws CommandError (via readAssetIndex) when the asset
 * is genuinely absent.
 */
export async function retireExtractedAsset(
  directionDir: string,
  assetId: string,
  when?: string,
): Promise<ExtractedAssetIndex> {
  const index = await readAssetIndex(directionDir, assetId);
  if (isExtractedAssetRetired(index)) return index; // idempotent — keep the first timestamp
  const retired = { ...index, retiredAt: when ?? new Date().toISOString() };
  await writeAssetIndex(directionDir, retired);
  return retired;
}
