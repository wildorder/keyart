import path from "node:path";
import { loadConfig, directionsRoot } from "../config.js";
import { loadEnvFiles } from "../env.js";
import { hasApiKey, generateImage } from "../openai.js";
import { resolveDirection, readVersion } from "../direction/store.js";
import { assertDirectionHasVersions } from "../direction/draft-guard.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { assembleContext } from "../brand/assemble-context.js";
import { composeArtDirection } from "../explore/compose-art-direction.js";
import { composeExtractPrompt } from "./compose-extract-prompt.js";
import { pathExists, writeTextFile } from "../fs.js";
import { CommandError } from "../errors.js";
import {
  extractedAssetsRoot,
  mintAssetId,
  mintAssetVersionId,
  listAssetIds,
  readAssetIndex,
  readAssetHead,
  appendVersionToIndex,
} from "./asset-store.js";
import type { AssetSourceImage, AssetSource, AssetVersion } from "./schema.js";

/**
 * The extraction + tweak pipeline's two cores, layered over the
 * `ExtractedAsset` record/store. `runAssetExtract` mints a NEW asset's v1 from
 * an element description + a source direction-version image; `runAssetRegenerate`
 * appends the next version to an EXISTING asset from a tweak. Both compose the
 * asset prompt through `composeExtractPrompt` (isolation directive + tweak +
 * the direction's `composeArtDirection` block, verbatim) and make exactly ONE
 * `generateImage` call with `transparentBackground: true`.
 *
 * Assets are evocative-imagery-tier only: neither core ever calls
 * `describeImageBrand`, writes tokens/`brand.css`, or edits a direction record —
 * the inverted token spine is untouched.
 */

/** On-disk filename for each source-image kind, under a direction version's folder. */
const SOURCE_IMAGE_FILENAMES: Record<AssetSourceImage, string> = {
  styleTile: "style-tile.png",
  homepageMockup: "homepage-mockup.png",
  moodboard: "style-board.png",
};

export interface AssetExtractOptions {
  cwd: string;
  directionId: string; // REQUIRED — assets are direction-scoped
  describe: string;
  image?: AssetSourceImage; // default "styleTile"
  versionId?: string; // default: the direction's head
  cropPath?: string; // optional crop reference (studio gesture)
  name?: string; // default derived from describe
}

export interface AssetExtractResult {
  assetId: string;
  versionId: string;
  filesWritten: string[]; // cwd-relative, forward slashes
  dryRun: boolean;
  imageSkips: string[];
}

export interface AssetRegenerateOptions {
  cwd: string;
  directionId: string; // REQUIRED — locates the asset's tree
  assetId: string;
  tweak: string;
  remember?: boolean; // default FALSE — asset-local, no memory write
  author?: string; // attribution for the remember entry (default "cli")
}

/** Absolute path to a direction version's source image on disk. */
function sourceImagePath(
  directionsDir: string,
  source: { directionId: string; versionId: string; image: AssetSourceImage },
): string {
  return path.join(
    directionsDir,
    source.directionId,
    "versions",
    source.versionId,
    SOURCE_IMAGE_FILENAMES[source.image],
  );
}

/** cwd-relative, forward-slash path — the shared reporting convention. */
function relTo(cwd: string, abs: string): string {
  return path.relative(cwd, abs).split(path.sep).join("/");
}

export async function runAssetExtract(
  opts: AssetExtractOptions,
): Promise<AssetExtractResult> {
  const cwd = path.resolve(opts.cwd);
  loadEnvFiles(cwd);
  const config = await loadConfig(opts.cwd);
  const rel = (abs: string): string => relTo(cwd, abs);
  const filesWritten: string[] = [];
  const imageSkips: string[] = [];
  const dryRun = !hasApiKey();

  const direction = await resolveDirection(opts.cwd, config, opts.directionId);
  const root = directionsRoot(opts.cwd, config);

  // Verify the source version exists — throws CommandError when a NAMED
  // version is absent; a draft with no explicit versionId gets the shared
  // teaching refusal naming `keyart explore <id>`.
  let sourceVersionId: string;
  if (opts.versionId) {
    sourceVersionId = opts.versionId;
    await readVersion(root, opts.directionId, sourceVersionId);
  } else {
    assertDirectionHasVersions(opts.directionId, direction.record.head);
    sourceVersionId = direction.record.head;
  }

  // Resolve the source image path; tolerate absence (a dry-run direction).
  const image = opts.image ?? "styleTile";
  const sourceImageAbs = sourceImagePath(root, {
    directionId: opts.directionId,
    versionId: sourceVersionId,
    image,
  });
  const sourceImageExists = await pathExists(sourceImageAbs);
  if (!sourceImageExists) {
    imageSkips.push(
      `source image missing: ${rel(sourceImageAbs)} (direction generated in dry-run)`,
    );
  }

  // Resolve the crop reference — a NAMED-but-missing crop is a caller error.
  let cropAbs: string | undefined;
  if (opts.cropPath) {
    cropAbs = path.resolve(cwd, opts.cropPath);
    if (!(await pathExists(cropAbs))) {
      throw new CommandError(`Crop reference image not found: ${opts.cropPath}`);
    }
  }

  // Assemble context from THIS direction's own memory (isolation is structural).
  const core = createDirectionCore(cwd, config);
  const brief = await core.getRenderedBrief(opts.directionId);
  const global = await createBrandCore(cwd, config).read();
  const memory = await core.memoryEntries(opts.directionId);
  const assembled = assembleContext({ brief, global, memory });
  const artDirection = composeArtDirection(assembled);
  const prompt = composeExtractPrompt({ description: opts.describe, artDirection });

  // Mint ids.
  const name = opts.name?.trim() || opts.describe;
  const assetId = mintAssetId(name, await listAssetIds(direction.dir));
  const versionId = mintAssetVersionId([]);
  const versionDir = path.join(
    extractedAssetsRoot(direction.dir),
    assetId,
    "versions",
    versionId,
  );

  // ONE generateImage call, gated exactly like write-direction-version.ts.
  const referenceImagePaths: string[] = [];
  if (sourceImageExists) referenceImagePaths.push(sourceImageAbs);
  if (cropAbs) referenceImagePaths.push(cropAbs);

  let pngWritten = false;
  if (hasApiKey() && config.models.image) {
    const pngAbs = path.join(versionDir, "asset.png");
    const genRes = await generateImage({
      model: config.models.image,
      prompt,
      outPath: pngAbs,
      referenceImagePaths,
      transparentBackground: true,
    });
    if (genRes.written) {
      filesWritten.push(rel(pngAbs));
      pngWritten = true;
    } else if (genRes.skippedReason) {
      imageSkips.push(genRes.skippedReason);
    }
    if (genRes.warnings) imageSkips.push(...genRes.warnings);
  }

  // Write the prompt file + the version record via the store.
  const promptMdAbs = path.join(versionDir, "asset-prompt.md");
  await writeTextFile(promptMdAbs, prompt + "\n");
  filesWritten.push(rel(promptMdAbs));

  const source: AssetSource = {
    directionId: opts.directionId,
    versionId: sourceVersionId,
    image,
    ...(cropAbs ? { cropPath: rel(cropAbs) } : {}),
  };
  const version: AssetVersion = {
    id: versionId,
    createdAt: new Date().toISOString(),
    description: opts.describe,
    source,
    files: ["asset-prompt.md", ...(pngWritten ? ["asset.png"] : [])],
    ...(dryRun ? { dryRun: true } : {}),
    ...(imageSkips.length > 0 ? { imageSkips } : {}),
  };
  await appendVersionToIndex(direction.dir, assetId, { name, directionId: opts.directionId }, version);
  filesWritten.push(rel(path.join(versionDir, "asset-version.json")));
  filesWritten.push(rel(path.join(extractedAssetsRoot(direction.dir), assetId, "asset.json")));

  return {
    assetId,
    versionId,
    filesWritten,
    dryRun,
    imageSkips,
  };
}

export async function runAssetRegenerate(
  opts: AssetRegenerateOptions,
): Promise<AssetExtractResult> {
  const cwd = path.resolve(opts.cwd);
  loadEnvFiles(cwd);
  const config = await loadConfig(opts.cwd);
  const rel = (abs: string): string => relTo(cwd, abs);
  const filesWritten: string[] = [];
  const imageSkips: string[] = [];
  const dryRun = !hasApiKey();

  const direction = await resolveDirection(opts.cwd, config, opts.directionId);
  const root = directionsRoot(opts.cwd, config);

  const index = await readAssetIndex(direction.dir, opts.assetId);
  const head = await readAssetHead(direction.dir, opts.assetId);

  // Reference fallback ladder: head PNG → original source image + recorded
  // crop → prompt-only. When there is no prior asset render, the recorded crop
  // (head.source.cropPath) rides along to narrow WHICH element is meant —
  // without it, a never-rendered asset's regenerate would rely on the text
  // description alone to locate the element in the full source image.
  const referenceImagePaths: string[] = [];
  const headPngAbs = path.join(
    extractedAssetsRoot(direction.dir),
    opts.assetId,
    "versions",
    head.id,
    "asset.png",
  );
  if (await pathExists(headPngAbs)) {
    referenceImagePaths.push(headPngAbs);
  } else {
    const sourceAbs = sourceImagePath(root, head.source);
    if (await pathExists(sourceAbs)) {
      referenceImagePaths.push(sourceAbs);
    }
    if (head.source.cropPath) {
      const cropAbs = path.resolve(cwd, head.source.cropPath);
      if (await pathExists(cropAbs)) {
        referenceImagePaths.push(cropAbs);
      }
    }
    if (referenceImagePaths.length === 0) {
      imageSkips.push(
        `no reference image available for regenerate: neither the head asset.png, the original source image, nor the recorded crop exists`,
      );
    }
  }

  // Re-assemble context from THIS direction's own memory.
  const core = createDirectionCore(cwd, config);
  const brief = await core.getRenderedBrief(opts.directionId);
  const global = await createBrandCore(cwd, config).read();
  const memory = await core.memoryEntries(opts.directionId);
  const assembled = assembleContext({ brief, global, memory });
  const prompt = composeExtractPrompt({
    description: head.description,
    artDirection: composeArtDirection(assembled),
    tweak: opts.tweak,
  });

  const versionId = mintAssetVersionId(index.versions);
  const versionDir = path.join(
    extractedAssetsRoot(direction.dir),
    opts.assetId,
    "versions",
    versionId,
  );

  let pngWritten = false;
  if (hasApiKey() && config.models.image) {
    const pngAbs = path.join(versionDir, "asset.png");
    const genRes = await generateImage({
      model: config.models.image,
      prompt,
      outPath: pngAbs,
      referenceImagePaths,
      transparentBackground: true,
    });
    if (genRes.written) {
      filesWritten.push(rel(pngAbs));
      pngWritten = true;
    } else if (genRes.skippedReason) {
      imageSkips.push(genRes.skippedReason);
    }
    if (genRes.warnings) imageSkips.push(...genRes.warnings);
  }

  const promptMdAbs = path.join(versionDir, "asset-prompt.md");
  await writeTextFile(promptMdAbs, prompt + "\n");
  filesWritten.push(rel(promptMdAbs));

  const version: AssetVersion = {
    id: versionId,
    createdAt: new Date().toISOString(),
    producedBy: opts.tweak,
    description: head.description,
    source: head.source,
    files: ["asset-prompt.md", ...(pngWritten ? ["asset.png"] : [])],
    ...(dryRun ? { dryRun: true } : {}),
    ...(imageSkips.length > 0 ? { imageSkips } : {}),
  };
  await appendVersionToIndex(
    direction.dir,
    opts.assetId,
    { name: index.name, directionId: opts.directionId },
    version,
  );
  filesWritten.push(rel(path.join(versionDir, "asset-version.json")));
  filesWritten.push(
    rel(path.join(extractedAssetsRoot(direction.dir), opts.assetId, "asset.json")),
  );

  if (opts.remember === true) {
    await core.appendFeedback(opts.directionId, {
      body: `Asset ${opts.assetId} tweak: ${opts.tweak}`,
      author: opts.author ?? "cli",
      source: "asset",
    });
  }

  return {
    assetId: opts.assetId,
    versionId,
    filesWritten,
    dryRun,
    imageSkips,
  };
}
