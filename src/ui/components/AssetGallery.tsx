/**
 * A responsive grid of a direction's registered assets (WS-02 `AssetRef`s). Image
 * assets render inline via the traversal-safe `AssetImage` (`/api/asset?path=`),
 * degrading to an "image unavailable" placeholder when the file is missing;
 * non-image kinds (font/color/other) render as a small chip. An empty gallery
 * shows an onboarding line pointing at the moodboard uploader above it.
 */
import React, { useState } from "react";
import type { DashboardAsset } from "../types";
import { AssetImage } from "./AssetImage";
import type { LightboxImage } from "./Lightbox";
import { deleteJson, isVersionConflict, VERSION_CONFLICT_MESSAGE } from "../hooks";
import { moodboardAssetRetireRequest } from "../direction-actions.js";
import { useToasts } from "./Toasts";

/** The last path segment, used as a readable fallback caption/alt. */
function baseName(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || p;
}

function RemoveAssetControl({
  asset,
  directionId,
  expectedVersion,
  reload,
}: {
  asset: DashboardAsset;
  directionId: string;
  expectedVersion: number;
  reload: () => void;
}) {
  const { pushToast } = useToasts();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const remove = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const req = moodboardAssetRetireRequest(directionId, asset.path, expectedVersion);
      await deleteJson(req.path, req.body);
      pushToast({ kind: "success", message: "Removed crop." });
      setConfirming(false);
      reload();
    } catch (e) {
      if (isVersionConflict(e)) {
        pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
        reload();
      } else {
        pushToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not remove this crop.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!confirming) {
    return (
      <button
        type="button"
        className="btn btn-ghost btn-sm asset-remove-trigger"
        onClick={() => setConfirming(true)}
      >
        Remove
      </button>
    );
  }

  return (
    <div className="lifecycle-confirm lifecycle-confirm--asset">
      <p className="lifecycle-confirm__copy">
        Remove this crop — it will stop influencing generation. History is kept.
      </p>
      <div className="lifecycle-confirm__actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={submitting}
          onClick={() => setConfirming(false)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-danger btn-sm"
          disabled={submitting}
          onClick={remove}
        >
          {submitting ? "Removing…" : "Remove"}
        </button>
      </div>
    </div>
  );
}

export function AssetGallery({
  assets,
  variant,
  directionId,
  expectedVersion,
  reload,
}: {
  assets: DashboardAsset[] | undefined;
  variant?: "drawer";
  directionId?: string;
  expectedVersion?: number;
  reload?: () => void;
}) {
  const list = assets ?? [];
  const canRemove = directionId !== undefined && expectedVersion !== undefined && reload !== undefined;

  if (list.length === 0) {
    return (
      <div className="empty-state gallery-empty">
        Drop reference images to build this direction&apos;s moodboard.
      </div>
    );
  }

  // All image assets form one lightbox group so the viewer's rail pages through
  // the whole moodboard, uncropped. Indices are into this image-only list.
  const imageGallery: LightboxImage[] = list
    .filter((a) => a.kind === "image")
    .map((a) => ({ path: a.path, alt: a.note ?? baseName(a.path), caption: a.note ?? baseName(a.path) }));
  const galleryIndexOf = (p: string): number =>
    imageGallery.findIndex((g) => g.path === p);

  return (
    <div className={`gallery${variant === "drawer" ? " gallery--drawer" : ""}`}>
      {list.map((asset, i) => {
        const caption = asset.note ?? baseName(asset.path);
        if (asset.kind === "image") {
          return (
            <figure key={`${asset.path}-${i}`} className="asset-figure">
              <AssetImage
                path={asset.path}
                alt={caption}
                className="asset-thumb"
                gallery={imageGallery}
                galleryIndex={galleryIndexOf(asset.path)}
              />
              <span
                className="asset-reference-badge"
                title="Fed to direction generation and reference-capable image generation."
              >
                used as reference
              </span>
              <figcaption className="asset-caption">{caption}</figcaption>
              {canRemove && (
                <RemoveAssetControl
                  asset={asset}
                  directionId={directionId as string}
                  expectedVersion={expectedVersion as number}
                  reload={reload as () => void}
                />
              )}
            </figure>
          );
        }
        return (
          <div key={`${asset.path}-${i}`} className="asset-chip" title={asset.path}>
            <span className="asset-chip-kind">{asset.kind}</span>
            <span className="asset-chip-label">{caption}</span>
          </div>
        );
      })}
    </div>
  );
}
