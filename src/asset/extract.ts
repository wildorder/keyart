import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig } from "../config.js";
import { loadEnvFiles } from "../env.js";
import { hasApiKey, generateImage } from "../openai.js";
import { resolveDirection } from "../direction/store.js";
import { resolveFoundation, assertFoundationPath, type FoundationContext } from "../direction/foundation.js";
import { assembleDerivedContext } from "../direction/derived-context.js";
import { createDirectionCore } from "../direction/core.js";
import { resolveBoardImage } from "../board/board-store.js";
import { composeExtractPrompt } from "./compose-extract-prompt.js";
import { pathExists, writeTextFile } from "../fs.js";
import { CommandError } from "../errors.js";
import { AssetFoundationRequiredError } from "./foundation-required.js";
import { extractedAssetsRoot, reserveAssetId, reserveAssetVersion, readAssetIndex, readAssetVersion, appendVersionToIndex, assetVersionDir } from "./asset-store.js";
import type { AssetSourceImage, AssetProvenance, AssetVersion, CropBox } from "./schema.js";
import type { KeyartConfig } from "../types.js";

export interface AssetGenerateOptions {
  cwd: string; directionId: string; versionId?: string; describe: string; name?: string; slotId?: string;
}
export interface AssetExtractOptions extends AssetGenerateOptions {
  image?: AssetSourceImage; boardId?: string; revisionId?: string; cropPath?: string; cropBox?: CropBox;
}
export interface AssetExtractResult {
  assetId: string; versionId: string; filesWritten: string[]; dryRun: boolean; imageSkips: string[]; status: AssetVersion["status"];
}
export interface AssetRegenerateOptions {
  cwd: string; directionId: string; assetId: string; tweak: string; revisionId?: string; versionId?: string; remember?: boolean; author?: string;
}
const relTo = (cwd: string, file: string): string => path.relative(cwd, file).split(path.sep).join("/");

async function resolveCrop(cwd: string, cropPath?: string): Promise<string | undefined> {
  if (!cropPath) return undefined;
  const file = path.resolve(cwd, cropPath);
  if (!(await pathExists(file))) throw new CommandError(`Crop reference image not found: ${cropPath}`);
  await assertFoundationPath(cwd, file);
  if (!(await fs.stat(file)).isFile()) throw new CommandError("Crop must be an image file.");
  return file;
}

async function produce(opts: {
  cwd: string; config: KeyartConfig; directionDir: string; foundation: FoundationContext;
  assetId: string; name: string; description: string; provenance: AssetProvenance;
  sourceImage?: string | null; sourceRevisionId?: string; previousImage?: string;
  crop?: string; tweak?: string; slotId?: string;
}): Promise<AssetExtractResult> {
  const { cwd, foundation, provenance } = opts;
  const context = await assembleDerivedContext({ cwd, config: opts.config, foundation, localIntent: `${opts.description}\n${opts.tweak ?? ""}` });
  const extraction = provenance.kind === "extracted";
  const localPrompt = extraction
    ? composeExtractPrompt({ description: opts.description, artDirection: context.artDirection, tweak: opts.tweak })
    : ["Generate usable standalone artwork for this request. Choose a background and composition appropriate to its intended use; transparency is not required.", opts.description,
      opts.tweak ? `Adjustment: ${opts.tweak}` : "", context.artDirection].filter(Boolean).join("\n\n");
  const prompt = `${context.foundationPrompt}\n\n${localPrompt}`;
  const dryRun = !hasApiKey();
  const imageSkips: string[] = [];
  const meta = { name: opts.name, directionId: foundation.directionId, slotId: opts.slotId };
  const attempt = await reserveAssetVersion(opts.directionDir, opts.assetId, meta, {
    formatVersion: 2, conditioning: "foundation", createdAt: new Date().toISOString(), description: opts.description,
    foundation: { directionId: foundation.directionId, versionId: foundation.versionId }, provenance,
    status: "pending", contextSnapshot: JSON.stringify(context.snapshot), files: ["asset-prompt.md", "context-snapshot.json"],
    ...(opts.tweak ? { producedBy: opts.tweak } : {}),
    ...(opts.sourceRevisionId ? { sourceRevisionId: opts.sourceRevisionId } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  });
  const dir = assetVersionDir(opts.directionDir, opts.assetId, attempt.id);
  await writeTextFile(path.join(dir, "asset-prompt.md"), prompt + "\n");
  await writeTextFile(path.join(dir, "context-snapshot.json"), attempt.contextSnapshot + "\n");
  let finalProvenance = provenance;
  let cropReference: string | undefined;
  const files = [...attempt.files];
  if (opts.crop && extraction) {
    const crop = path.join(dir, "source-crop.png");
    await fs.copyFile(opts.crop, crop);
    cropReference = crop;
    files.push("source-crop.png");
    finalProvenance = { ...provenance, cropPath: relTo(cwd, crop) };
  }
  const refs = [foundation.tilePath, opts.previousImage, opts.sourceImage, cropReference].filter((p): p is string => Boolean(p));
  const referenceImagePaths = [...new Set(refs)];
  let status: AssetVersion["status"] = "pending";
  if (!foundation.imageReady) imageSkips.push(`Foundation ${foundation.versionId} has no style tile; this attempt remains pending. Generate that foundation's image first.`);
  if (extraction && !opts.sourceImage && !opts.crop && !opts.previousImage) imageSkips.push("The selected extraction source has no completed image; this attempt remains pending.");
  const sourceReady = !extraction || Boolean(opts.sourceImage || opts.crop || opts.previousImage);
  if (!dryRun && opts.config.models.image && foundation.imageReady && sourceReady) {
    try {
      const generated = await generateImage({ model: opts.config.models.image, prompt, outPath: path.join(dir, "asset.png"), referenceImagePaths, transparentBackground: extraction });
      if (generated.written && await pathExists(path.join(dir, "asset.png"))) { files.push("asset.png"); status = "completed"; }
      else { status = "failed"; imageSkips.push(generated.skippedReason ?? "Image generation returned no artifact."); }
      if (generated.warnings) imageSkips.push(...generated.warnings);
    } catch (err) { status = "failed"; imageSkips.push(err instanceof Error ? err.message : String(err)); }
  }
  const version: AssetVersion = { ...attempt, provenance: finalProvenance, files, status, ...(imageSkips.length ? { imageSkips } : {}) };
  await appendVersionToIndex(opts.directionDir, opts.assetId, meta, version);
  const filesWritten = [...files.map((file) => relTo(cwd, path.join(dir, file))), relTo(cwd, path.join(dir, "asset-attempt.json")), relTo(cwd, path.join(dir, "asset-version.json")), relTo(cwd, path.join(extractedAssetsRoot(opts.directionDir), opts.assetId, "asset.json"))];
  return { assetId: opts.assetId, versionId: attempt.id, filesWritten, dryRun, imageSkips, status };
}

export async function runAssetGenerate(opts: AssetGenerateOptions): Promise<AssetExtractResult> {
  const cwd = path.resolve(opts.cwd); loadEnvFiles(cwd);
  const config = await loadConfig(cwd);
  const foundation = await resolveFoundation({ cwd, config, directionId: opts.directionId, versionId: opts.versionId ?? "" });
  const direction = await resolveDirection(cwd, config, opts.directionId);
  // Validate local intent before reserving any identity.
  await assembleDerivedContext({ cwd, config, foundation, localIntent: opts.describe });
  const name = opts.name?.trim() || opts.describe;
  const assetId = await reserveAssetId(direction.dir, name);
  return produce({ cwd, config, foundation, directionDir: direction.dir, assetId, name, description: opts.describe, provenance: { kind: "generated" }, slotId: opts.slotId });
}

export async function runAssetExtract(opts: AssetExtractOptions): Promise<AssetExtractResult> {
  const cwd = path.resolve(opts.cwd); loadEnvFiles(cwd);
  const config = await loadConfig(cwd);
  const direction = await resolveDirection(cwd, config, opts.directionId);
  if (opts.image && opts.image !== "styleTile") throw new CommandError("That fixed image source is unsupported. Convert it to a Board, then select --board and --revision; or extract from --image styleTile with --version.");
  let foundation: FoundationContext;
  let sourceImage: string | null;
  let provenance: AssetProvenance;
  if (opts.boardId) {
    if (!opts.revisionId) throw new CommandError("Board extraction requires an explicit --revision.");
    const source = await resolveBoardImage(direction.dir, opts.boardId, opts.revisionId);
    if (source.revision.foundation.directionId !== opts.directionId) throw new CommandError("Board source belongs to a different direction.");
    if (opts.versionId && opts.versionId !== source.revision.foundation.versionId) throw new CommandError("Extraction foundation must match the selected Board revision.");
    foundation = await resolveFoundation({ cwd, config, ...source.revision.foundation });
    sourceImage = source.imagePath;
    provenance = { kind: "extracted", source: { kind: "board", directionId: opts.directionId, boardId: opts.boardId, revisionId: opts.revisionId } };
  } else {
    if (opts.revisionId) throw new CommandError("--revision requires a --board source for extraction.");
    foundation = await resolveFoundation({ cwd, config, directionId: opts.directionId, versionId: opts.versionId ?? "" });
    sourceImage = foundation.tilePath;
    provenance = { kind: "extracted", source: { kind: "foundation", directionId: opts.directionId, versionId: foundation.versionId, image: "styleTile" } };
  }
  const crop = await resolveCrop(cwd, opts.cropPath);
  if (opts.cropBox) provenance = { ...provenance, cropBox: opts.cropBox };
  await assembleDerivedContext({ cwd, config, foundation, localIntent: opts.describe });
  const name = opts.name?.trim() || opts.describe;
  const assetId = await reserveAssetId(direction.dir, name);
  return produce({ cwd, config, foundation, directionDir: direction.dir, assetId, name, description: opts.describe, provenance, sourceImage, crop, slotId: opts.slotId });
}

export async function runAssetRevise(opts: AssetRegenerateOptions): Promise<AssetExtractResult> {
  const cwd = path.resolve(opts.cwd); loadEnvFiles(cwd);
  const config = await loadConfig(cwd);
  const direction = await resolveDirection(cwd, config, opts.directionId);
  const index = await readAssetIndex(direction.dir, opts.assetId);
  const revisionId = opts.revisionId ?? (index.head || index.versions.at(-1));
  if (!revisionId || !index.versions.includes(revisionId)) throw new CommandError("Select an existing asset revision to revise.");
  const source = await readAssetVersion(direction.dir, opts.assetId, revisionId);
  if (source.foundation.directionId !== opts.directionId) throw new CommandError("Asset foundation belongs to a different direction.");
  let foundation: FoundationContext;
  if (opts.versionId !== undefined) {
    foundation = await resolveFoundation({ cwd, config, directionId: opts.directionId, versionId: opts.versionId });
  } else {
    try { foundation = await resolveFoundation({ cwd, config, ...source.foundation }); }
    catch (error) {
      const missing = !direction.record.versions.includes(source.foundation.versionId) || (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing) throw error;
      throw new AssetFoundationRequiredError(opts.directionId, opts.assetId, revisionId, source.foundation.versionId,
        direction.record.versions.filter((id) => id !== source.foundation.versionId));
    }
  }
  const prior = path.join(assetVersionDir(direction.dir, opts.assetId, revisionId), "asset.png");
  const previousImage = source.status === "completed" && await pathExists(prior) ? prior : undefined;
  if (previousImage) await assertFoundationPath(direction.dir, previousImage);
  let sourceImage: string | null = null;
  let crop: string | undefined;
  if (source.provenance.kind === "extracted") {
    const origin = source.provenance.source;
    if (origin.kind === "foundation") {
      // Extraction provenance names the original source, not the replacement
      // foundation. Its missing image is legal when a prior asset/crop exists.
      if (origin.versionId === foundation.versionId) sourceImage = foundation.tilePath;
      else if (direction.record.versions.includes(origin.versionId)) {
        try { sourceImage = (await resolveFoundation({ cwd, config, directionId: origin.directionId, versionId: origin.versionId })).tilePath; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    } else sourceImage = (await resolveBoardImage(direction.dir, origin.boardId, origin.revisionId)).imagePath;
    crop = await resolveCrop(cwd, source.provenance.cropPath);
  }
  const result = await produce({ cwd, config, directionDir: direction.dir, foundation, assetId: opts.assetId, name: index.name, description: source.description, provenance: source.provenance, sourceImage, crop, sourceRevisionId: revisionId, previousImage, tweak: opts.tweak });
  if (opts.remember) await createDirectionCore(cwd, config).appendFeedback(opts.directionId, { body: `Asset ${opts.assetId} tweak: ${opts.tweak}`, author: opts.author ?? "cli", source: "asset" });
  return result;
}
export const runAssetRegenerate = runAssetRevise;
