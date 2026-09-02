import path from "node:path";
import { CommandError } from "../errors.js";
import { loadConfig } from "../config.js";
import { pathExists } from "../fs.js";
import { resolveDirection } from "../direction/store.js";
import { createBrandCore } from "../brand/core.js";
import {
  runAssetExtract,
  runAssetRegenerate,
  type AssetExtractResult,
} from "../asset/extract.js";
import { runAssetPack, type PackedAsset } from "../asset/pack.js";
import {
  listAssetIds,
  readAssetIndex,
  retireExtractedAsset,
} from "../asset/asset-store.js";
import { isExtractedAssetRetired, type AssetSourceImage } from "../asset/schema.js";

export const ASSET_VERBS = ["extract", "regenerate", "list", "remove", "pack"] as const;
export type AssetVerb = (typeof ASSET_VERBS)[number];
export const ASSET_SOURCE_IMAGES = ["styleTile", "homepageMockup", "moodboard"] as const;

/** Typed flag bag — the CLI passes commander's cmdOpts directly; the MCP adapter maps ParsedArgs.flags. */
export interface AssetFlags {
  direction?: string;
  describe?: string;
  image?: string;
  version?: string;
  crop?: string;
  name?: string;
  tweak?: string;
  remember?: boolean;
  author?: string;
}

export interface AssetListRow {
  id: string;
  name: string;
  directionId: string;
  head: string;
  versionCount: number;
  /** cwd-relative path to the head version's PNG — absent when the head has
   * no image yet (dry-run/pending), never fabricated. */
  headPng?: string;
}

export type AssetCommandResult =
  | ({ verb: "extract" } & AssetExtractResult)
  | ({ verb: "regenerate" } & AssetExtractResult)
  | { verb: "list"; directionId: string; assets: AssetListRow[]; filesWritten: string[] }
  | {
      verb: "remove";
      directionId: string;
      assetId: string;
      retiredAt: string;
      alreadyRetired: boolean;
      filesWritten: string[];
    }
  | {
      verb: "pack";
      directionId: string;
      filesWritten: string[];
      assetsIncluded: string[];
      assetsPending: string[];
      packDir: string;
      assets: PackedAsset[];
    };

const USAGE: Record<AssetVerb, string> = {
  extract:
    'Usage: keyart asset extract --direction <dirId> --describe "<text>" [--image styleTile|homepageMockup|moodboard] [--version <versionId>] [--crop <path>] [--name <name>]',
  regenerate:
    'Usage: keyart asset regenerate <assetId> --direction <dirId> --tweak "<text>" [--remember] [--author <author>]',
  list: "Usage: keyart asset list [--direction <dirId>]",
  remove: "Usage: keyart asset remove <assetId> [--direction <dirId>]",
  pack: "Usage: keyart asset pack [--direction <dirId>]",
};

function relTo(cwd: string): (abs: string) => string {
  const resolved = path.resolve(cwd);
  return (abs: string): string =>
    path.relative(resolved, abs).split(path.sep).join("/");
}

/** Rejects any flag not in `allowed` for `verb` — the runConcept wrong-verb-coupling idiom. */
function assertOnlyFlags(
  verb: AssetVerb,
  flags: AssetFlags,
  allowed: (keyof AssetFlags)[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(flags) as (keyof AssetFlags)[]) {
    const value = flags[key];
    // `remember: false` (the CLI/MCP unset-boolean default) is not "given".
    if (value === undefined || value === false) continue;
    if (!allowedSet.has(key)) {
      throw new CommandError(
        `--${key} is not valid with asset ${verb}.\n${USAGE[verb]}`,
      );
    }
  }
}

function logImageSkips(imageSkips: string[]): void {
  if (imageSkips.length > 0) {
    console.log(`Warnings:\n${imageSkips.map((s) => `- ${s}`).join("\n")}`);
  }
}

/** Resolve the target directionId: the given flag, else the approved pointer's. */
async function resolveTargetDirection(
  cwd: string,
  given: string | undefined,
  usage: string,
): Promise<string> {
  if (given) return given;
  const config = await loadConfig(cwd);
  const pointer = (await createBrandCore(cwd, config).read()).approvedPointer;
  if (!pointer) {
    throw new CommandError(
      `No direction given and nothing is approved yet.\n${usage}`,
    );
  }
  return pointer.directionId;
}

export async function runAsset(
  cwd: string,
  rest: string[],
  flags: AssetFlags,
): Promise<AssetCommandResult> {
  const verb = rest[0];
  if (!(ASSET_VERBS as readonly string[]).includes(verb)) {
    throw new CommandError(
      `Unknown asset verb "${verb}". Supported: extract, regenerate, list, remove, pack.`,
    );
  }

  switch (verb as AssetVerb) {
    case "extract":
      return assetExtract(cwd, rest, flags);
    case "regenerate":
      return assetRegenerate(cwd, rest, flags);
    case "list":
      return assetList(cwd, rest, flags);
    case "remove":
      return assetRemove(cwd, rest, flags);
    case "pack":
      return assetPack(cwd, rest, flags);
  }
}

async function assetExtract(
  cwd: string,
  rest: string[],
  flags: AssetFlags,
): Promise<AssetCommandResult> {
  if (rest.length > 1) {
    throw new CommandError(`Too many arguments for asset extract.\n${USAGE.extract}`);
  }
  assertOnlyFlags("extract", flags, [
    "direction",
    "describe",
    "image",
    "version",
    "crop",
    "name",
  ]);
  if (!flags.direction) {
    throw new CommandError(`asset extract requires --direction.\n${USAGE.extract}`);
  }
  if (!flags.describe) {
    throw new CommandError(`asset extract requires --describe.\n${USAGE.extract}`);
  }
  if (
    flags.image !== undefined &&
    !(ASSET_SOURCE_IMAGES as readonly string[]).includes(flags.image)
  ) {
    throw new CommandError(
      `Invalid --image: ${flags.image}. Valid images: ${ASSET_SOURCE_IMAGES.join(", ")}.`,
    );
  }

  const result = await runAssetExtract({
    cwd,
    directionId: flags.direction,
    describe: flags.describe,
    image: flags.image as AssetSourceImage | undefined,
    versionId: flags.version,
    cropPath: flags.crop,
    name: flags.name,
  });

  console.log(
    `Extracted asset "${result.assetId}" (${result.versionId}) from direction "${flags.direction}"${result.dryRun ? " — dry-run, no PNG" : ""}.`,
  );
  logImageSkips(result.imageSkips);

  return { verb: "extract", ...result };
}

async function assetRegenerate(
  cwd: string,
  rest: string[],
  flags: AssetFlags,
): Promise<AssetCommandResult> {
  if (rest.length > 2) {
    throw new CommandError(`Too many arguments for asset regenerate.\n${USAGE.regenerate}`);
  }
  assertOnlyFlags("regenerate", flags, ["direction", "tweak", "remember", "author"]);
  const assetId = rest[1];
  if (!assetId) {
    throw new CommandError(`asset regenerate requires an assetId.\n${USAGE.regenerate}`);
  }
  if (!flags.tweak) {
    throw new CommandError(`asset regenerate requires --tweak.\n${USAGE.regenerate}`);
  }

  const directionId = await resolveTargetDirection(cwd, flags.direction, USAGE.regenerate);

  const result = await runAssetRegenerate({
    cwd,
    directionId,
    assetId,
    tweak: flags.tweak,
    remember: flags.remember === true,
    author: flags.author,
  });

  console.log(
    `Regenerated asset "${result.assetId}" (${result.versionId}) on direction "${directionId}"${result.dryRun ? " — dry-run, no PNG" : ""}.`,
  );
  logImageSkips(result.imageSkips);

  return { verb: "regenerate", ...result };
}

async function assetList(
  cwd: string,
  rest: string[],
  flags: AssetFlags,
): Promise<AssetCommandResult> {
  if (rest.length > 1) {
    throw new CommandError(`asset list takes no positional argument.\n${USAGE.list}`);
  }
  assertOnlyFlags("list", flags, ["direction"]);

  const config = await loadConfig(cwd);
  const directionId = await resolveTargetDirection(cwd, flags.direction, USAGE.list);
  const direction = await resolveDirection(cwd, config, directionId);
  const rel = relTo(cwd);

  const ids = await listAssetIds(direction.dir);
  const rows: AssetListRow[] = [];
  for (const id of ids) {
    const index = await readAssetIndex(direction.dir, id);
    if (isExtractedAssetRetired(index)) continue;
    const headPngAbs = path.join(
      direction.dir,
      "extracted-assets",
      index.id,
      "versions",
      index.head,
      "asset.png",
    );
    const hasPng = await pathExists(headPngAbs);
    rows.push({
      id: index.id,
      name: index.name,
      directionId: index.directionId,
      head: index.head,
      versionCount: index.versions.length,
      ...(hasPng ? { headPng: rel(headPngAbs) } : {}),
    });
  }

  console.log(
    rows.length === 0
      ? `No extracted assets for direction "${direction.id}".`
      : rows
          .map(
            (r) =>
              `${r.id}  (${r.directionId})  head=${r.head}  versions=${r.versionCount}  "${r.name}"  ${
                r.headPng ? `png=${r.headPng}` : "(pending — no png yet)"
              }`,
          )
          .join("\n"),
  );

  return { verb: "list", directionId: direction.id, assets: rows, filesWritten: [] };
}

async function assetRemove(
  cwd: string,
  rest: string[],
  flags: AssetFlags,
): Promise<AssetCommandResult> {
  if (rest.length > 2) {
    throw new CommandError(`Too many arguments for asset remove.\n${USAGE.remove}`);
  }
  assertOnlyFlags("remove", flags, ["direction"]);
  const assetId = rest[1];
  if (!assetId) {
    throw new CommandError(`asset remove requires an assetId.\n${USAGE.remove}`);
  }

  const config = await loadConfig(cwd);
  const directionId = await resolveTargetDirection(cwd, flags.direction, USAGE.remove);
  const direction = await resolveDirection(cwd, config, directionId);
  const rel = relTo(cwd);

  // Throws CommandError when the asset is genuinely absent.
  const before = await readAssetIndex(direction.dir, assetId);
  const alreadyRetired = isExtractedAssetRetired(before);
  const after = await retireExtractedAsset(direction.dir, assetId);

  console.log(
    alreadyRetired
      ? `Asset "${assetId}" was already retired.`
      : `Retired asset "${assetId}" (non-destructive retire).`,
  );

  return {
    verb: "remove",
    directionId: direction.id,
    assetId,
    retiredAt: after.retiredAt!,
    alreadyRetired,
    filesWritten: alreadyRetired
      ? []
      : [rel(path.join(direction.dir, "extracted-assets", assetId, "asset.json"))],
  };
}

async function assetPack(
  cwd: string,
  rest: string[],
  flags: AssetFlags,
): Promise<AssetCommandResult> {
  if (rest.length > 1) {
    throw new CommandError(`asset pack takes no positional argument.\n${USAGE.pack}`);
  }
  assertOnlyFlags("pack", flags, ["direction"]);

  const result = await runAssetPack({
    cwd,
    directionId: flags.direction,
  });

  console.log(
    `Asset pack written for ${result.directionId}: ${result.assetsIncluded.length} asset(s), ${result.assetsPending.length} pending.`,
  );

  return { verb: "pack", ...result };
}
