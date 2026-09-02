/**
 * An `<img>` pointing at the traversal-safe `GET /api/asset?path=` endpoint.
 * When the image is missing (image generation may still fail — galleries must
 * degrade gracefully) the broken image is replaced by an "image unavailable"
 * placeholder.
 *
 * Inline thumbnails are deliberately cropped (`object-fit: cover`) for layout;
 * pass a `gallery` (and this image's `galleryIndex`) to make the thumbnail
 * clickable — it then opens the shared {@link Lightbox} to view the full,
 * uncropped image and page through the rest of the group.
 */
import React, { useState } from "react";
import { useLightbox, type LightboxImage } from "./Lightbox";
// The traversal-safe asset URL builder — lifted to the pure `asset-url.ts`
// module (WS-20) so `direction-actions.ts` can reuse the exact encoding;
// re-exported here unchanged so this module's public surface is identical.
import { assetUrl } from "../asset-url";

export { assetUrl };

export function AssetImage({
  path,
  alt,
  className,
  version,
  gallery,
  galleryIndex,
}: {
  path: string;
  alt: string;
  className?: string;
  /** Cache-bust token — bump to force a refetch of the SAME path (e.g. after
   * regenerating an in-place image). Assets are served `no-store`, but a
   * same-`src` <img> would otherwise never re-request. */
  version?: number | string;
  /** When provided, the thumbnail becomes a button that opens the lightbox on
   * this group. Omit for a plain, non-interactive image. */
  gallery?: LightboxImage[];
  /** This image's position within `gallery` (defaults to the first). */
  galleryIndex?: number;
}) {
  const [failed, setFailed] = useState(false);
  const { open } = useLightbox();

  const content = failed ? (
    <div
      className={className ? `asset-missing ${className}` : "asset-missing"}
      role="img"
      aria-label={`${alt} — image unavailable`}
      title="Image unavailable"
    >
      Image unavailable
    </div>
  ) : (
    <img
      className={className}
      src={assetUrl(path, version)}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );

  // A missing image is not worth opening full-screen — only wrap a real image.
  if (gallery && gallery.length > 0 && !failed) {
    return (
      <button
        type="button"
        className="asset-open"
        aria-label={`View ${alt} full screen`}
        onClick={() => open(gallery, galleryIndex ?? 0)}
      >
        {content}
      </button>
    );
  }

  return content;
}
