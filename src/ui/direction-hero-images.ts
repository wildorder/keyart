import type { DashboardVersion } from "./types.js";

/** Shape-compatible with LightboxImage from Lightbox.tsx — duplicated here to
 *  avoid importing a JSX file from a plain .ts module (tsconfig has no jsx). */
interface LightboxImageLike {
  path: string;
  alt: string;
  caption?: string;
  version?: number | string;
}

/** The dominant hero image: homepage mockup preferred, style tile as fallback. */
export function heroImageOf(version: DashboardVersion): string | null {
  return version.images?.homepageMockup ?? version.images?.styleTile ?? null;
}

/**
 * The secondary (thumbnail) images: pick from [styleTile, homepageMockup, styleBoard]
 * in that fixed order, drop the one that became the hero, drop falsy entries.
 * `styleBoardSvg` (the deterministic board projection) is never a thumbnail target.
 */
export function secondaryImagesOf(
  version: DashboardVersion,
): { path: string; label: string }[] {
  const hero = heroImageOf(version);
  const candidates: { path: string | undefined; label: string }[] = [
    { path: version.images?.styleTile, label: "Style tile" },
    { path: version.images?.homepageMockup, label: "Homepage mockup" },
    { path: version.images?.styleBoard, label: "Style board (generated)" },
  ];
  return candidates.filter(
    (c): c is { path: string; label: string } => Boolean(c.path) && c.path !== hero,
  );
}

/**
 * Every evocative image for this version as one ordered `{path, label}` list —
 * the STAGE's image set, which the thumbnail row selects from.
 *
 * The order is identical to {@link galleryImagesOf}, so an index into either
 * list addresses the same image and the stage's thumbnail row stays in lockstep
 * with the lightbox group. Unlike {@link secondaryImagesOf} this INCLUDES the
 * hero: on the stage every image is a peer and the staged one is a selection,
 * not a fixed role. `styleBoardSvg` is still never a target.
 */
export function stageImagesOf(
  version: DashboardVersion,
): { path: string; label: string }[] {
  const candidates: { path: string | undefined; label: string }[] = [
    { path: version.images?.styleTile, label: "Style tile" },
    { path: version.images?.homepageMockup, label: "Homepage mockup" },
    { path: version.images?.styleBoard, label: "Style board (generated)" },
  ];
  return candidates.filter(
    (c): c is { path: string; label: string } => Boolean(c.path),
  );
}

/**
 * All evocative images for this version as one ordered LightboxImage group.
 * Order: styleTile → homepageMockup → styleBoard (mirrors the existing gallery logic).
 */
export function galleryImagesOf(
  version: DashboardVersion,
  imgVersion: number,
): LightboxImageLike[] {
  const result: LightboxImageLike[] = [];
  if (version.images?.styleTile)
    result.push({
      path: version.images.styleTile,
      alt: `${version.name} — style tile`,
      caption: `${version.name} — style tile`,
      version: imgVersion,
    });
  if (version.images?.homepageMockup)
    result.push({
      path: version.images.homepageMockup,
      alt: `${version.name} — homepage mockup`,
      caption: `${version.name} — homepage mockup`,
      version: imgVersion,
    });
  if (version.images?.styleBoard)
    result.push({
      path: version.images.styleBoard,
      alt: `${version.name} — style board (generated)`,
      caption: `${version.name} — style board (generated)`,
      version: imgVersion,
    });
  return result;
}
