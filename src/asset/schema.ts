import { z } from "zod";

export const AssetSourceImageSchema = z.enum(["styleTile"]);
export type AssetSourceImage = z.infer<typeof AssetSourceImageSchema>;
export const CropBoxSchema = z.object({ x: z.number().nonnegative(), y: z.number().nonnegative(), w: z.number().positive(), h: z.number().positive() });
export type CropBox = z.infer<typeof CropBoxSchema>;
export const AssetFoundationSchema = z.object({ directionId: z.string().min(1), versionId: z.string().min(1) });
export type AssetFoundation = z.infer<typeof AssetFoundationSchema>;
export const AssetSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("foundation"), directionId: z.string(), versionId: z.string(), image: z.literal("styleTile") }),
  z.object({ kind: z.literal("board"), directionId: z.string(), boardId: z.string(), revisionId: z.string() }),
]);
export type AssetSource = z.infer<typeof AssetSourceSchema>;
export const AssetProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("generated") }),
  z.object({ kind: z.literal("extracted"), source: AssetSourceSchema, cropPath: z.string().optional(), cropBox: CropBoxSchema.optional() }),
]);
export type AssetProvenance = z.infer<typeof AssetProvenanceSchema>;
export const AssetVersionSchema = z.object({
  formatVersion: z.literal(2),
  conditioning: z.enum(["foundation", "legacy-unverified"]),
  id: z.string().min(1), createdAt: z.string(), producedBy: z.string().optional(),
  description: z.string(), foundation: AssetFoundationSchema, provenance: AssetProvenanceSchema,
  sourceRevisionId: z.string().optional(), status: z.enum(["pending", "completed", "failed"]),
  contextSnapshot: z.string(), files: z.array(z.string()), dryRun: z.boolean().optional(), imageSkips: z.array(z.string()).optional(),
});
export type AssetVersion = z.infer<typeof AssetVersionSchema>;
export const ExtractedAssetIndexSchema = z.object({
  formatVersion: z.literal(2), id: z.string(), name: z.string(), directionId: z.string(),
  versions: z.array(z.string()),
  /** Empty until a completed render exists. Attempts never advance this pointer. */
  head: z.string(), retiredAt: z.string().optional(), slotId: z.string().optional(),
});
export type ExtractedAssetIndex = z.infer<typeof ExtractedAssetIndexSchema>;
export interface ExtractedAsset { id: string; name: string; directionId: string; versions: AssetVersion[] }
export const parseAssetVersion = (raw: unknown): AssetVersion => AssetVersionSchema.parse(raw);
export const parseExtractedAssetIndex = (raw: unknown): ExtractedAssetIndex => ExtractedAssetIndexSchema.parse(raw);
export function isExtractedAssetRetired(index: { retiredAt?: string }): boolean {
  return typeof index.retiredAt === "string" && index.retiredAt.length > 0;
}
