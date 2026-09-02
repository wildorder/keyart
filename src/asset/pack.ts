import path from "node:path";
import fs from "node:fs/promises";
import { loadConfig } from "../config.js";
import {
  ensureDir,
  writeTextFile,
  writeJsonFile,
  pathExists,
  copyFileSafe,
} from "../fs.js";
import { CommandError } from "../errors.js";
import { createBrandCore } from "../brand/core.js";
import { resolveDirection, readVersion, readHead } from "../direction/store.js";
import { assertDirectionHasVersions } from "../direction/draft-guard.js";
import { directionsRoot } from "../config.js";
import {
  listAssetIds,
  readAssetIndex,
  readAssetHead,
} from "./asset-store.js";
import { isExtractedAssetRetired, type ExtractedAssetIndex } from "./schema.js";
import { resolveBrandVars } from "../approve/render-guides.js";
import { renderDtcgTokens } from "./render-dtcg-tokens.js";
import {
  renderContactSheetSvg,
  renderContactSheetMarkdown,
  type ContactSheetAsset,
} from "./render-contact-sheet.js";

/**
 * `runAssetPack` — the deterministic, keyless designer handoff: a direction's
 * active extracted assets + tokens projected into
 * `brand/generated/asset-pack/<directionId>/`. No model call, ever — every
 * artifact is a pure projection of on-disk state, byte-identical for
 * identical input. Consumes the WS-01 store, the sibling renderers,
 * `resolveBrandVars`, config/direction resolution, and fs helpers
 * only — never `src/openai.ts`, never anything under `src/ui/`, never
 * `assembleContext` (the pack assembles no prompts).
 */

export interface AssetPackOptions {
  cwd: string;
  directionId?: string; // explicit direction override — defaults to the approved pointer
}

/** One active asset as shipped (or honestly pending) in the pack. */
export interface PackedAsset {
  id: string;
  name: string;
  description: string;
  pending: boolean;
  /** Pack-dir-relative filename (`<id>.png`) — absent while pending. */
  file?: string;
}

export interface AssetPackResult {
  directionId: string;
  filesWritten: string[]; // cwd-relative, forward-slash paths
  assetsIncluded: string[]; // asset ids whose head PNG shipped
  assetsPending: string[]; // asset ids whose head has no PNG (dry-run) — listed, never fabricated
  /** The pack folder, cwd-relative with forward slashes. */
  packDir: string;
  /** Per-asset detail for downstream projections (the approve-codified guides). */
  assets: PackedAsset[];
}

export async function runAssetPack(
  opts: AssetPackOptions,
): Promise<AssetPackResult> {
  const config = await loadConfig(opts.cwd);
  const cwd = path.resolve(opts.cwd);
  const rel = (abs: string): string =>
    path.relative(cwd, abs).split(path.sep).join("/");

  const pointer = (await createBrandCore(opts.cwd, config).read())
    .approvedPointer;

  const directionId = opts.directionId ?? pointer?.directionId;
  if (directionId === undefined) {
    throw new CommandError(
      "No direction to pack: nothing is approved yet and no direction was given. " +
        "Approve a direction (`keyart approve <directionId>`) or pass an explicit direction.",
    );
  }
  const direction = await resolveDirection(opts.cwd, config, directionId);
  if (opts.directionId !== undefined) {
    // Explicit-id branch only (R-4): an explicitly targeted draft gets the
    // teaching refusal. The id-omitted pointer branch keeps its approve-first
    // error — a pointer direction can never be a draft (approve needs a version).
    assertDirectionHasVersions(directionId, direction.record.head);
  }
  const root = directionsRoot(opts.cwd, config);

  // Gather ACTIVE assets, direction-scoped: retired assets are excluded,
  // never destructively. Every asset under this direction's own tree already
  // belongs to it (scope is location) — the `directionId` check is a
  // defensive assertion, not a cross-direction filter.
  const ids = await listAssetIds(direction.dir);
  const active: ExtractedAssetIndex[] = [];
  for (const id of ids) {
    const index = await readAssetIndex(direction.dir, id);
    if (isExtractedAssetRetired(index)) continue;
    if (index.directionId !== directionId) continue;
    active.push(index);
  }

  // Resolve the token-bearing direction version: the PINNED version when the
  // pack direction is the approved one (so the pack ships the approved
  // tokens even if the direction's head has moved past approval), else head.
  const isApprovedDirection = pointer !== null && pointer.directionId === directionId;
  const version = isApprovedDirection
    ? await readVersion(root, directionId, pointer!.versionId)
    : await readHead(root, directionId);
  const generatedFrom = version.id;
  const vars = resolveBrandVars(version);

  // The pack dir is a pure projection of current state: delete-then-recreate
  // so a PNG from a since-retired asset never lingers (double-run
  // byte-equality is a folder-level claim).
  const packDir = path.resolve(
    opts.cwd,
    config.brand.root,
    "generated",
    "asset-pack",
    directionId,
  );
  await fs.rm(packDir, { recursive: true, force: true });
  await ensureDir(packDir);

  const filesWritten: string[] = [];
  const assetsIncluded: string[] = [];
  const assetsPending: string[] = [];
  const contactSheetAssets: ContactSheetAsset[] = [];
  const manifestAssets: Record<string, unknown>[] = [];
  const packedAssets: PackedAsset[] = [];

  for (const index of active) {
    const head = await readAssetHead(direction.dir, index.id);
    const headPngPath = path.join(
      direction.dir,
      "extracted-assets",
      index.id,
      "versions",
      head.id,
      "asset.png",
    );
    const hasImage = await pathExists(headPngPath);
    if (hasImage) {
      const dest = path.join(packDir, `${index.id}.png`);
      await copyFileSafe(headPngPath, dest);
      filesWritten.push(rel(dest));
      assetsIncluded.push(index.id);
    } else {
      assetsPending.push(index.id);
    }

    contactSheetAssets.push({
      id: index.id,
      name: index.name,
      description: head.description,
      versionId: head.id,
      hasImage,
      source: head.source,
    });

    manifestAssets.push({
      id: index.id,
      name: index.name,
      description: head.description,
      headVersionId: head.id,
      source: head.source,
      pending: !hasImage,
      // The packed filename, stated explicitly so a consumer never has to
      // infer the `<assetId>.png` convention; absent while pending.
      ...(hasImage ? { file: `${index.id}.png` } : {}),
    });

    packedAssets.push({
      id: index.id,
      name: index.name,
      description: head.description,
      pending: !hasImage,
      ...(hasImage ? { file: `${index.id}.png` } : {}),
    });
  }

  const sheetInput = {
    directionId,
    directionName: version.name,
    assets: contactSheetAssets,
  };
  const contactSheetSvgPath = path.join(packDir, "contact-sheet.svg");
  await writeTextFile(contactSheetSvgPath, renderContactSheetSvg(sheetInput));
  filesWritten.push(rel(contactSheetSvgPath));

  const contactSheetMdPath = path.join(packDir, "contact-sheet.md");
  await writeTextFile(
    contactSheetMdPath,
    renderContactSheetMarkdown(sheetInput),
  );
  filesWritten.push(rel(contactSheetMdPath));

  const tokensPath = path.join(packDir, "tokens.json");
  await writeJsonFile(
    tokensPath,
    renderDtcgTokens(vars, { scale: version.tokens?.typography.scale }),
  );
  filesWritten.push(rel(tokensPath));

  const manifestPath = path.join(packDir, "pack-manifest.json");
  await writeJsonFile(manifestPath, {
    directionId,
    generatedFrom,
    approved: isApprovedDirection,
    assets: manifestAssets,
  });
  filesWritten.push(rel(manifestPath));

  return {
    directionId,
    filesWritten,
    assetsIncluded,
    assetsPending,
    packDir: rel(packDir),
    assets: packedAssets,
  };
}
