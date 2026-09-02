/**
 * The focused direction's extracted-asset shelf (WS-06, asset-extraction) — a
 * thin front-end over the WS-05 asset routes. Direction-scoped by
 * construction: it reads ONLY `direction.extractedAssets` (via
 * `assetShelfItems`), so switching the studio's focused direction swaps the
 * shelf's entire data source and direction A's assets structurally cannot
 * appear beside direction B's.
 */
import React, { useState } from "react";
import type { DashboardDirection, DashboardExtractedAsset } from "../types";
import {
  assetShelfItems,
  assetAffordances,
  assetImageStatus,
  assetImageStatusLabel,
} from "../asset-shelf-helpers.js";
import { AssetImage, assetUrl } from "./AssetImage";
import { JobProgress, useAction } from "./JobProgress";
import { useToasts } from "./Toasts";
import { postJson, deleteJson } from "../hooks";
import {
  assetRegenerateRequest,
  assetRetireRequest,
  exportAssetPackRequest,
} from "../direction-actions.js";

interface AssetPackResponse {
  directionId: string;
  filesWritten: string[];
  assetsIncluded: unknown;
  assetsPending: unknown;
}

export function AssetShelf({
  direction,
  reload,
}: {
  /** The FOCUSED direction — the shelf reads ONLY its extractedAssets. */
  direction: DashboardDirection;
  reload: () => void;
}): JSX.Element {
  const { pushToast } = useToasts();
  const items = assetShelfItems(direction);
  const [packing, setPacking] = useState(false);

  const exportPack = async (): Promise<void> => {
    if (packing) return;
    setPacking(true);
    try {
      const req = exportAssetPackRequest(direction.id);
      const res = await postJson<AssetPackResponse>(req.path, req.body);
      pushToast({
        kind: "success",
        message: `Asset pack written — brand/generated/asset-pack/${res.directionId}`,
      });
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Could not export the pack.",
      });
    } finally {
      setPacking(false);
    }
  };

  return (
    <div className="asset-shelf">
      <div className="asset-shelf__header">
        <span className="asset-shelf__title">Assets ({items.length})</span>
        {items.length > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={packing}
            onClick={exportPack}
          >
            {packing ? "Exporting…" : "Export asset pack"}
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <p className="asset-shelf__empty">
          No extracted assets yet — draw a box on an image above and choose Extract
          as asset.
        </p>
      ) : (
        <div className="asset-shelf__cards">
          {items.map((a) => (
            <AssetCard key={a.id} asset={a} directionId={direction.id} reload={reload} />
          ))}
        </div>
      )}
    </div>
  );
}

function AssetCard({
  asset,
  directionId,
  reload,
}: {
  asset: DashboardExtractedAsset;
  directionId: string;
  reload: () => void;
}): JSX.Element {
  const { pushToast } = useToasts();
  const aff = assetAffordances(asset);

  const tweakAction = useAction(reload);
  const [tweak, setTweak] = useState("");
  const [remember, setRemember] = useState(false);

  const startTweak = (): void => {
    const t = tweak.trim();
    if (t.length === 0) return;
    const req = assetRegenerateRequest(directionId, asset.id, t, { remember });
    tweakAction.start(req.path, req.body);
    setTweak("");
  };

  const [confirmingRetire, setConfirmingRetire] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const confirmRetire = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const req = assetRetireRequest(directionId, asset.id);
      await deleteJson(req.path, req.body);
      pushToast({ kind: "success", message: "Asset retired." });
      setConfirmingRetire(false);
      reload(); // the next dashboard payload excludes it → drops out immediately (SC-10)
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Could not retire this asset.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  const status = assetImageStatus(asset);
  const statusLabel = assetImageStatusLabel(status);

  return (
    <div className="asset-card">
      {aff.pending ? (
        <div
          className={`asset-card__pending asset-card__pending--${status.kind}`}
          role="img"
          aria-label={`${asset.name} — ${statusLabel}`}
          title={status.detail}
        >
          {statusLabel}
        </div>
      ) : (
        <AssetImage
          className="asset-card__thumb"
          path={asset.imagePath!}
          alt={asset.name}
          version={asset.headVersionId}
        />
      )}
      {status.kind === "ok-degraded" && (
        <p className="asset-card__degraded" title={status.detail}>
          ⚠ {statusLabel}
        </p>
      )}

      <div className="asset-card__identity">
        <span className="asset-card__name">{asset.name}</span>
        <span
          className="asset-card__pill"
          title={`${asset.versionCount} version${asset.versionCount === 1 ? "" : "s"} — head ${asset.headVersionId}`}
        >
          v{asset.versionCount}
        </span>
      </div>
      <p className="asset-card__description" title={asset.description}>
        {asset.description}
      </p>

      <div className="asset-card__tweak">
        <input
          type="text"
          value={tweak}
          placeholder="e.g. make it face left"
          disabled={tweakAction.running}
          onChange={(e) => setTweak(e.target.value)}
        />
        <label className="asset-card__remember">
          <input
            type="checkbox"
            checked={remember}
            disabled={tweakAction.running}
            onChange={(e) => setRemember(e.target.checked)}
          />
          <span>also remember in memory</span>
        </label>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={tweakAction.running || tweak.trim().length === 0}
          onClick={startTweak}
        >
          {tweakAction.running ? "Tweaking…" : "Tweak"}
        </button>
        <JobProgress jobId={tweakAction.jobId} onDone={tweakAction.onDone} />
      </div>

      <div className="asset-card__actions">
        {aff.canDownload && (
          <a
            className="btn btn-ghost btn-sm"
            href={assetUrl(asset.imagePath!)}
            download={`${asset.id}.png`}
          >
            Download
          </a>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setConfirmingRetire((o) => !o)}
        >
          Retire
        </button>
      </div>

      {confirmingRetire && (
        <div className="lifecycle-confirm">
          <p className="lifecycle-confirm__copy">
            Retire this asset — it leaves the shelf and the pack. Files and history
            are kept.
          </p>
          <div className="lifecycle-confirm__actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={submitting}
              onClick={() => setConfirmingRetire(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={submitting}
              onClick={confirmRetire}
            >
              {submitting ? "Retiring…" : "Retire"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
