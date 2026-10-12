import path from "node:path";
import fs from "node:fs/promises";
import { ensureDir, pathExists, readTextFile } from "../fs.js";
import { CommandError } from "../errors.js";
import { atomicWriteJson, withFileLock } from "../store/file-lock.js";
import { assertFoundationPath } from "../direction/foundation.js";
import { parseAssetVersion, parseExtractedAssetIndex, isExtractedAssetRetired, type AssetVersion, type ExtractedAsset, type ExtractedAssetIndex } from "./schema.js";

const INDEX_FILE = "asset.json";
const VERSION_FILE = "asset-version.json";
const ATTEMPT_FILE = "asset-attempt.json";
function safeId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new CommandError(`Invalid asset or revision id: ${id}. Use an id, not a path.`);
  return id;
}
export function extractedAssetsRoot(directionDir: string): string { return path.join(directionDir, "extracted-assets"); }
function assetDirOf(directionDir: string, assetId: string): string { return path.join(extractedAssetsRoot(directionDir), safeId(assetId)); }
export function assetVersionDir(directionDir: string, assetId: string, versionId: string): string {
  return path.join(assetDirOf(directionDir, assetId), "versions", safeId(versionId));
}
function indexPath(directionDir: string, assetId: string): string { return path.join(assetDirOf(directionDir, assetId), INDEX_FILE); }
async function contained(directionDir: string, file: string): Promise<void> {
  await ensureDir(directionDir);
  let existing = file;
  for (;;) {
    try { await fs.lstat(existing); break; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    const parent = path.dirname(existing);
    if (parent === existing) throw new CommandError("Asset path has no owning direction.");
    existing = parent;
  }
  await assertFoundationPath(directionDir, existing);
}
function slugify(base: string): string { return base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "asset"; }
export function mintAssetId(name: string, existing: string[]): string {
  const slug = slugify(name); let id = slug; let n = 2;
  while (existing.includes(id)) id = `${slug}-${n++}`;
  return id;
}
export function mintAssetVersionId(existing: string[]): string {
  const base = new Date().toISOString().replace(/[:.]/g, "-"); let id = base; let n = 2;
  while (existing.includes(id)) id = `${base}-${n++}`;
  return id;
}
export async function reserveAssetId(directionDir: string, name: string): Promise<string> {
  await contained(directionDir, extractedAssetsRoot(directionDir));
  await ensureDir(extractedAssetsRoot(directionDir));
  await assertFoundationPath(directionDir, extractedAssetsRoot(directionDir));
  const slug = slugify(name);
  for (let n = 1; ; n++) {
    const id = n === 1 ? slug : `${slug}-${n}`;
    try { await fs.mkdir(assetDirOf(directionDir, id)); return id; }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  }
}
export async function listAssetIds(directionDir: string): Promise<string[]> {
  let entries;
  try { entries = await fs.readdir(extractedAssetsRoot(directionDir), { withFileTypes: true }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; throw err; }
  const ids: string[] = [];
  for (const entry of entries) if (entry.isDirectory() && await pathExists(indexPath(directionDir, entry.name))) ids.push(entry.name);
  return ids.sort();
}
export async function readAssetIndex(directionDir: string, assetId: string): Promise<ExtractedAssetIndex> {
  const file = indexPath(directionDir, assetId);
  if (!(await pathExists(file))) throw new CommandError(`Asset not found: ${assetId}`);
  await assertFoundationPath(directionDir, file);
  try {
    const index = parseExtractedAssetIndex(JSON.parse(await readTextFile(file)));
    if (index.id !== assetId || index.directionId !== path.basename(directionDir)) throw new Error("identity mismatch");
    return index;
  } catch {
    throw new CommandError(`Unsupported or unreadable asset index: ${assetId}. Back up and convert this record to asset formatVersion 2 using the migration checklist; no files were changed.`);
  }
}
export async function writeAssetIndex(directionDir: string, index: ExtractedAssetIndex): Promise<void> {
  const parsed = parseExtractedAssetIndex(index);
  if (parsed.directionId !== path.basename(directionDir)) throw new CommandError("Asset belongs to a different direction.");
  await contained(directionDir, indexPath(directionDir, index.id));
  await withFileLock(indexPath(directionDir, index.id), async () => { await atomicWriteJson(indexPath(directionDir, index.id), parsed); });
}
export async function readAssetVersion(directionDir: string, assetId: string, versionId: string): Promise<AssetVersion> {
  const dir = assetVersionDir(directionDir, assetId, versionId);
  const final = path.join(dir, VERSION_FILE);
  const file = await pathExists(final) ? final : path.join(dir, ATTEMPT_FILE);
  if (!(await pathExists(file))) throw new CommandError(`Asset version not found: ${assetId}@${versionId}`);
  await assertFoundationPath(directionDir, file);
  try {
    const version = parseAssetVersion(JSON.parse(await readTextFile(file)));
    if (version.id !== versionId || version.foundation.directionId !== path.basename(directionDir) || (version.provenance.kind === "extracted" && version.provenance.source.directionId !== version.foundation.directionId)) throw new Error("identity mismatch");
    return version;
  } catch {
    throw new CommandError(`Unsupported or unreadable asset version: ${assetId}@${versionId}. Back up and convert to asset formatVersion 2 using the migration checklist; no files were changed.`);
  }
}
export async function readAssetHead(directionDir: string, assetId: string): Promise<AssetVersion> {
  const index = await readAssetIndex(directionDir, assetId);
  if (!index.head) throw new CommandError(`Asset ${assetId} has no completed render yet. Select an attempt revision to revise it.`);
  return readAssetVersion(directionDir, assetId, index.head);
}
export async function readAssetLatestAttempt(directionDir: string, assetId: string): Promise<AssetVersion> {
  const index = await readAssetIndex(directionDir, assetId);
  const id = index.versions.at(-1);
  if (!id) throw new CommandError(`Asset ${assetId} has no attempts yet.`);
  return readAssetVersion(directionDir, assetId, id);
}
export async function readExtractedAsset(directionDir: string, assetId: string): Promise<ExtractedAsset> {
  const index = await readAssetIndex(directionDir, assetId);
  return { id: index.id, name: index.name, directionId: index.directionId,
    versions: await Promise.all(index.versions.map((id) => readAssetVersion(directionDir, assetId, id))) };
}
type AssetMeta = { name: string; directionId: string; slotId?: string };
function initialIndex(assetId: string, meta: AssetMeta): ExtractedAssetIndex {
  return { formatVersion: 2, id: assetId, name: meta.name, directionId: meta.directionId, versions: [], head: "", ...(meta.slotId ? { slotId: meta.slotId } : {}) };
}
async function currentIndex(directionDir: string, assetId: string, meta: AssetMeta): Promise<ExtractedAssetIndex> {
  const index = await pathExists(indexPath(directionDir, assetId)) ? await readAssetIndex(directionDir, assetId) : initialIndex(assetId, meta);
  if (index.directionId !== meta.directionId || meta.directionId !== path.basename(directionDir)) throw new CommandError("Asset belongs to a different direction.");
  if (isExtractedAssetRetired(index)) throw new CommandError(`Asset ${assetId} is retired; create a new asset instead.`);
  return index;
}
/** Publish inspectable pending metadata before a model call; output folders never collide. */
export async function reserveAssetVersion(directionDir: string, assetId: string, meta: AssetMeta, attempt: Omit<AssetVersion, "id">): Promise<AssetVersion> {
  await contained(directionDir, indexPath(directionDir, assetId));
  await contained(directionDir, path.join(assetDirOf(directionDir, assetId), "versions"));
  return withFileLock(indexPath(directionDir, assetId), async () => {
    const index = await currentIndex(directionDir, assetId, meta);
    let id = mintAssetVersionId(index.versions);
    const occupied = [...index.versions];
    while (await pathExists(assetVersionDir(directionDir, assetId, id))) { occupied.push(id); id = mintAssetVersionId(occupied); }
    const version = parseAssetVersion({ ...attempt, id, status: "pending" });
    if (version.foundation.directionId !== meta.directionId) throw new CommandError("Asset foundation belongs to a different direction.");
    await ensureDir(assetVersionDir(directionDir, assetId, id));
    await atomicWriteJson(path.join(assetVersionDir(directionDir, assetId, id), ATTEMPT_FILE), version);
    await atomicWriteJson(indexPath(directionDir, assetId), { ...index, versions: [...index.versions, id] });
    return version;
  });
}
/** Terminal records are immutable. Only completed renders advance the successful head. */
export async function appendVersionToIndex(directionDir: string, assetId: string, meta: AssetMeta, version: AssetVersion): Promise<ExtractedAssetIndex> {
  const parsed = parseAssetVersion(version);
  await contained(directionDir, indexPath(directionDir, assetId));
  await contained(directionDir, assetVersionDir(directionDir, assetId, version.id));
  return withFileLock(indexPath(directionDir, assetId), async () => {
    const index = await currentIndex(directionDir, assetId, meta);
    if (parsed.foundation.directionId !== meta.directionId) throw new CommandError("Asset foundation belongs to a different direction.");
    const file = path.join(assetVersionDir(directionDir, assetId, version.id), VERSION_FILE);
    if (await pathExists(file)) throw new CommandError(`Asset "${assetId}" already has version "${version.id}" — versions are immutable.`);
    const attemptFile = path.join(assetVersionDir(directionDir, assetId, version.id), ATTEMPT_FILE);
    if (await pathExists(attemptFile)) {
      const attempt = parseAssetVersion(JSON.parse(await readTextFile(attemptFile)));
      for (const key of ["foundation", "conditioning", "description", "producedBy", "contextSnapshot", "sourceRevisionId"] as const) {
        if (JSON.stringify(attempt[key]) !== JSON.stringify(parsed[key])) throw new CommandError(`Reserved asset ${version.id} ${key} cannot change during generation.`);
      }
      const stableOrigin = (v: AssetVersion) => v.provenance.kind === "generated" ? v.provenance : { kind: v.provenance.kind, source: v.provenance.source, cropBox: v.provenance.cropBox };
      if (JSON.stringify(stableOrigin(attempt)) !== JSON.stringify(stableOrigin(parsed))) throw new CommandError("Reserved asset provenance cannot change during generation.");
      if (parsed.provenance.kind === "extracted" && parsed.provenance.cropPath) {
        const suffix = path.join("extracted-assets", assetId, "versions", version.id, "source-crop.png").split(path.sep).join("/");
        if (!parsed.provenance.cropPath.replace(/\\/g, "/").endsWith(`/${suffix}`) || !parsed.files.includes("source-crop.png")) throw new CommandError("Stored crop provenance must name this asset revision's own copied crop.");
        await assertFoundationPath(directionDir, path.join(path.dirname(file), "source-crop.png"));
      }
      if (parsed.status === "completed" && (!parsed.files.includes("asset.png") || !(await pathExists(path.join(path.dirname(file), "asset.png"))))) {
        throw new CommandError("A completed asset must have its own generated image.");
      }
    }
    await atomicWriteJson(file, parsed);
    const updated = { ...index, versions: index.versions.includes(version.id) ? index.versions : [...index.versions, version.id], head: version.status === "completed" ? version.id : index.head };
    await atomicWriteJson(indexPath(directionDir, assetId), updated);
    return updated;
  });
}
export async function setExtractedAssetSlotId(directionDir: string, assetId: string, slotId: string): Promise<ExtractedAssetIndex> {
  await contained(directionDir, indexPath(directionDir, assetId));
  return withFileLock(indexPath(directionDir, assetId), async () => {
    const linked = { ...await readAssetIndex(directionDir, assetId), slotId };
    await atomicWriteJson(indexPath(directionDir, assetId), linked); return linked;
  });
}
export async function retireExtractedAsset(directionDir: string, assetId: string, when?: string): Promise<ExtractedAssetIndex> {
  await contained(directionDir, indexPath(directionDir, assetId));
  return withFileLock(indexPath(directionDir, assetId), async () => {
    const index = await readAssetIndex(directionDir, assetId);
    if (isExtractedAssetRetired(index)) return index;
    const retired = { ...index, retiredAt: when ?? new Date().toISOString() };
    await atomicWriteJson(indexPath(directionDir, assetId), retired); return retired;
  });
}
