/**
 * Pure, JSX-free helpers behind the studio asset shelf (WS-06,
 * asset-extraction) — the single source of truth so `AssetShelf`/`AssetCard`
 * and the `ElementFeedback` extract gesture stay dumb renderers over these
 * decisions. Mirrors the `lifecycle-actions.ts` convention: `.js`-extension
 * type imports, total, never throws, no mutation.
 */
import type {
  DashboardDirection,
  DashboardExtractedAsset,
  DirectionImages,
} from "./types.js";

/** The logical source-image name the extract action sends (mirrors the
 * WS-01 AssetVersion.source.image enum). `styleBoardSvg` (the deterministic
 * board) is never an extract source. */
export type AssetSourceImage = "styleTile" | "homepageMockup" | "moodboard";

/**
 * The focused direction's shelf items, newest first by `createdAt` (stable:
 * ties keep payload order). Direction-scoped by construction — this reads
 * ONLY the given direction's own `extractedAssets`. Retired assets are
 * excluded server-side (the WS-05 read contract); this helper renders exactly
 * what the payload carries — it never invents or drops items. An absent /
 * empty `extractedAssets` yields `[]`.
 */
export function assetShelfItems(
  direction: DashboardDirection,
): DashboardExtractedAsset[] {
  return [...(direction.extractedAssets ?? [])].sort((a, b) => {
    if (a.createdAt < b.createdAt) return 1;
    if (a.createdAt > b.createdAt) return -1;
    return 0;
  });
}

export interface AssetAffordances {
  /** A head PNG exists to download. */
  canDownload: boolean;
  /** Regenerate is offered — ALWAYS true (dry-run parity: a keyless tweak
   * still appends a record + prompt). */
  canTweak: boolean;
  /** Dry-run: no imagePath → labeled placeholder, no download. */
  pending: boolean;
}

/** Which affordances an asset's state earns — keyed solely off `imagePath`. */
export function assetAffordances(
  asset: DashboardExtractedAsset,
): AssetAffordances {
  return {
    canDownload: asset.imagePath !== undefined,
    canTweak: true,
    pending: asset.imagePath === undefined,
  };
}

/**
 * The head version's image state, disambiguated. Three DISTINCT no-image
 * causes — a keyless dry-run, a keyed-but-failed generation, and a genuinely
 * unknown pending — plus a degraded-but-present state (e.g. the
 * transparent-background→opaque retry). Total and pure; `detail` carries the
 * persisted reasons verbatim so the UI never has to guess (the fix for
 * "every keyed failure reads as a key problem").
 */
export type AssetImageStatusKind =
  | "ok" // image present, no warnings
  | "ok-degraded" // image present, generation degraded (warnings recorded)
  | "dry-run" // no image because there was no key
  | "failed" // no image; generation was attempted and failed (reasons recorded)
  | "pending"; // no image, no recorded cause (e.g. a pre-fix record)

export interface AssetImageStatus {
  kind: AssetImageStatusKind;
  /** The recorded reasons, joined — present for `ok-degraded` and `failed`. */
  detail?: string;
}

export function assetImageStatus(
  asset: DashboardExtractedAsset,
): AssetImageStatus {
  const skips = asset.imageSkips ?? [];
  const detail = skips.length > 0 ? skips.join("; ") : undefined;
  if (asset.imagePath !== undefined) {
    return detail !== undefined ? { kind: "ok-degraded", detail } : { kind: "ok" };
  }
  if (asset.dryRun === true) {
    return detail !== undefined ? { kind: "dry-run", detail } : { kind: "dry-run" };
  }
  if (detail !== undefined) return { kind: "failed", detail };
  return { kind: "pending" };
}

/** The placeholder / caption label for a status — one wording source for the shelf. */
export function assetImageStatusLabel(status: AssetImageStatus): string {
  switch (status.kind) {
    case "ok":
      return "";
    case "ok-degraded":
      return `generated with a limitation: ${status.detail ?? ""}`.trimEnd();
    case "dry-run":
      return "dry-run — no OPENAI_API_KEY, image not generated";
    case "failed":
      return `image generation failed: ${status.detail ?? "unknown reason"}`;
    case "pending":
      return "pending — no image";
  }
}

/**
 * Map an open feedback-target path to the logical source-image name:
 * `images.styleTile` → `"styleTile"`, `images.homepageMockup` →
 * `"homepageMockup"`, `images.styleBoard` → `"moodboard"` (the evocative
 * board IS the moodboard-tier image). Unknown path or absent images → null
 * (the caller then omits the `image` field and the server applies its
 * default).
 */
export function sourceImageNameFor(
  images: DirectionImages | undefined,
  path: string,
): AssetSourceImage | null {
  if (!images) return null;
  if (images.styleTile !== undefined && images.styleTile === path) return "styleTile";
  if (images.homepageMockup !== undefined && images.homepageMockup === path) {
    return "homepageMockup";
  }
  if (images.styleBoard !== undefined && images.styleBoard === path) return "moodboard";
  return null;
}
