import { z } from "zod";

/**
 * The `ExtractedAsset` record family.
 *
 * Named `ExtractedAsset` DELIBERATELY — the existing `AssetRef`
 * (`src/direction/schema.ts`) is a different record: a path-only reference
 * (moodboard images, element-feedback kept crops) stored in `direction.yaml`
 * and fed into generation. An `ExtractedAsset` is a produced, versioned,
 * standalone artifact with its own tree. Neither record is ever converted
 * into the other; `AssetRef` is untouched by this program.
 */

/** Which generated direction-version image the element was extracted from. */
export type AssetSourceImage = "styleTile" | "homepageMockup" | "moodboard";
export const AssetSourceImageSchema = z.enum([
  "styleTile",
  "homepageMockup",
  "moodboard",
]);

/** A crop rectangle in source-image pixel coordinates (the studio's box-draw gesture). */
export interface CropBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const CropBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
});

/** Full provenance: exactly where in the direction's imagery the element came from. */
export interface AssetSource {
  directionId: string;
  versionId: string; // the DirectionVersion the element came from
  image: AssetSourceImage;
  cropBox?: CropBox; // present when the studio gesture supplied a crop
  cropPath?: string; // cwd-relative path of an uploaded crop reference image, when supplied
}
export const AssetSourceSchema = z.object({
  directionId: z.string(),
  versionId: z.string(),
  image: AssetSourceImageSchema,
  cropBox: CropBoxSchema.optional(),
  cropPath: z.string().optional(),
});

/** One immutable version of an extracted asset (the DirectionVersion idiom). */
export interface AssetVersion {
  id: string; // version label (mintAssetVersionId)
  createdAt: string; // ISO 8601
  producedBy?: string; // the tweak that created this version (absent on v1)
  description: string; // the element description ("the yak mascot")
  source: AssetSource;
  files: string[]; // version-folder-relative files written
  dryRun?: boolean;
  /** Why this version has no (or a degraded) image, when generation was
   * attempted: API failures and non-fatal degradations (e.g. transparent
   * background unsupported → retried opaque). Persisted so a keyed-but-failed
   * run is diagnosable after the fact, never mistaken for a keyless dry-run. */
  imageSkips?: string[];
}
export const AssetVersionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  producedBy: z.string().optional(),
  description: z.string(),
  source: AssetSourceSchema,
  files: z.array(z.string()),
  dryRun: z.boolean().optional(),
  imageSkips: z.array(z.string()).optional(),
});

/** The hydrated record: identity + full ordered version history (last = head). */
export interface ExtractedAsset {
  id: string;
  name: string;
  directionId: string;
  versions: AssetVersion[];
}

/** The tiny on-disk index at `extracted-assets/<assetId>/asset.json`. */
export interface ExtractedAssetIndex {
  id: string;
  name: string;
  directionId: string;
  versions: string[]; // ordered versionIds; the last is the head
  head: string; // === versions[versions.length - 1]
  retiredAt?: string; // ISO 8601 — NON-DESTRUCTIVE retire marker (the AssetRef.retiredAt idiom)
  /** The surface-manifest slot this asset fills (`surface-manifest` WS-03) —
   * the ONLY key bind matches on (never name heuristics). Absent ⇒ the asset
   * claims no slot (back-compat: pre-existing `asset.json` files parse
   * unchanged). */
  slotId?: string;
}
export const ExtractedAssetIndexSchema = z.object({
  id: z.string(),
  name: z.string(),
  directionId: z.string(),
  versions: z.array(z.string()),
  head: z.string(),
  retiredAt: z.string().optional(),
  slotId: z.string().optional(),
});

export const parseAssetVersion = (raw: unknown): AssetVersion =>
  AssetVersionSchema.parse(raw);
export const parseExtractedAssetIndex = (raw: unknown): ExtractedAssetIndex =>
  ExtractedAssetIndexSchema.parse(raw);

/**
 * True iff the asset has been retired (non-destructive marker present). PURE,
 * synchronous, no I/O — mirrors isAssetRetired (src/direction/schema.ts).
 */
export function isExtractedAssetRetired(index: { retiredAt?: string }): boolean {
  return typeof index.retiredAt === "string" && index.retiredAt.length > 0;
}
