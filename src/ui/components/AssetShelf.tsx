/**
 * The focused direction's extracted-asset shelf (WS-06, asset-extraction) — a
 * thin front-end over the WS-05 asset routes. Direction-scoped by
 * construction: it reads ONLY `direction.extractedAssets` (via
 * `assetShelfItems`), so switching the studio's focused direction swaps the
 * shelf's entire data source and direction A's assets structurally cannot
 * appear beside direction B's.
 */
import React, { useState, type JSX } from "react";
import type { DashboardDirection, DashboardExtractedAsset, DashboardVersion } from "../types";
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
  assetReviseRequest,
  assetGenerateRequest,
  assetRetireRequest,
  exportAssetPackRequest,
} from "../direction-actions.js";
import { foundationLabel } from "../board-view.js";

interface AssetPackResponse {
  directionId: string;
  filesWritten: string[];
  assetsIncluded: unknown;
  assetsPending: unknown;
}

export function AssetShelf({
  direction,
  reload,
  focusedVersionId,
}: {
  /** The FOCUSED direction — the shelf reads ONLY its extractedAssets. */
  direction: DashboardDirection;
  reload: () => void;
  focusedVersionId?: string | null;
}): JSX.Element {
  const { pushToast } = useToasts();
  const items = assetShelfItems(direction);
  const [packing, setPacking] = useState(false);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [generateName, setGenerateName] = useState("");
  const [generateBrief, setGenerateBrief] = useState("");
  const [target, setTarget] = useState(focusedVersionId ?? direction.head ?? "");
  const [generateConfirmation, setGenerateConfirmation] = useState<{ directionId: string; versionId: string; name: string; describe: string } | null>(null);
  const generate = useAction(reload);
  const confirmGenerate = (): void => {
    if (!generateConfirmation) return;
    const req = assetGenerateRequest(generateConfirmation);
    generate.start(req.path, req.body); setGenerateConfirmation(null); setGenerateOpen(false);
  };

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
        <button className="btn btn-secondary btn-sm" disabled={!direction.head || generate.running} onClick={() => { setTarget(focusedVersionId ?? direction.head ?? ""); setGenerateOpen((v) => !v); setGenerateConfirmation(null); }}>Generate asset</button>
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

      {generateOpen && !generateConfirmation && <div className="regen-form">
        <label>Asset name<input value={generateName} onChange={(e) => setGenerateName(e.target.value)} /></label>
        <label>Asset brief<textarea value={generateBrief} onChange={(e) => setGenerateBrief(e.target.value)} /></label>
        <label>Foundation<select aria-label="Asset target foundation" value={target} onChange={(e) => setTarget(e.target.value)}>{[...direction.versions].reverse().map((v) => <option key={v.versionId} value={v.versionId}>{foundationLabel(direction.versions, v.versionId)}</option>)}</select></label>
        <button className="btn btn-primary btn-sm" disabled={!generateName.trim() || !generateBrief.trim() || !target} onClick={() => setGenerateConfirmation({ directionId: direction.id, versionId: target, name: generateName.trim(), describe: generateBrief.trim() })}>Review asset request</button>
      </div>}
      {generateConfirmation && <div className="lifecycle-confirm" aria-label="Confirm asset generation"><p>Generate “{generateConfirmation.name}” using foundation {foundationLabel(direction.versions, generateConfirmation.versionId)}.</p><p>{generateConfirmation.describe}</p>
        <button className="btn btn-primary btn-sm" onClick={confirmGenerate}>Confirm generation</button><button className="btn btn-ghost btn-sm" onClick={() => setGenerateConfirmation(null)}>Cancel</button></div>}
      <JobProgress jobId={generate.jobId} onDone={generate.onDone} />

      {items.length === 0 ? (
        <p className="asset-shelf__empty">
          No usable assets yet. Generate one directly, or crop a Foundation or Board image and choose Extract as asset.
        </p>
      ) : (
        <div className="asset-shelf__cards">
          {items.map((a) => (
            <AssetCard key={a.id} asset={a} directionId={direction.id} versions={direction.versions} reload={reload} />
          ))}
        </div>
      )}
    </div>
  );
}

function AssetCard({
  asset,
  directionId,
  versions,
  reload,
}: {
  asset: DashboardExtractedAsset;
  directionId: string;
  versions: DashboardVersion[];
  reload: () => void;
}): JSX.Element {
  const { pushToast } = useToasts();
  const aff = assetAffordances(asset);

  const tweakAction = useAction(reload);
  const [tweak, setTweak] = useState("");
  const [remember, setRemember] = useState(false);
  const [revisionConfirmation, setRevisionConfirmation] = useState<{ directionId: string; assetId: string; revisionId: string; tweak: string; remember: boolean; foundation: string } | null>(null);
  const [chooseFoundation, setChooseFoundation] = useState(false);
  const [replacement, setReplacement] = useState("");

  const startTweak = (): void => {
    const t = tweak.trim();
    if (t.length === 0) return;
    const original = asset.foundation?.versionId;
    const foundation = chooseFoundation ? replacement : original;
    if (!foundation || !versions.some((v) => v.versionId === foundation)) {
      setChooseFoundation(true);
      return;
    }
    setRevisionConfirmation({ directionId, assetId: asset.id, revisionId: asset.headVersionId, tweak: t, remember, foundation });
  };
  const confirmRevision = (): void => {
    if (!revisionConfirmation) return;
    const req = assetReviseRequest(revisionConfirmation.directionId, revisionConfirmation.assetId, revisionConfirmation.tweak,
      { remember: revisionConfirmation.remember, revisionId: revisionConfirmation.revisionId, versionId: revisionConfirmation.foundation });
    tweakAction.start(req.path, req.body);
    setRevisionConfirmation(null);
    setChooseFoundation(false);
    setReplacement("");
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
      {asset.foundation && <p className="field-hint">{asset.origin === "generated" ? "Generated" : "Extracted"} · Foundation {asset.foundation.versionId}</p>}
      {asset.conditioning === "legacy-unverified" && <p className="field-hint" role="note">Migrated artwork: foundation conditioning was not verified. Its version relationship is historical provenance.</p>}

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
          {tweakAction.running ? "Revising…" : "Revise asset"}
        </button>
        {chooseFoundation && !revisionConfirmation && <div className="lifecycle-confirm">
          <p>This asset’s original foundation is unavailable. Which foundation should this revision use? The existing asset is unchanged.</p>
          <label>Replacement foundation<select aria-label={`Foundation for ${asset.name}`} value={replacement} onChange={(e) => setReplacement(e.target.value)}>
            <option value="">Choose a foundation…</option>
            {versions.map((v) => <option key={v.versionId} value={v.versionId}>{foundationLabel(versions, v.versionId)}</option>)}
          </select></label>
          {versions.length === 0 && <p>Create a foundation first, then return to revise this asset.</p>}
          <button className="btn btn-primary btn-sm" disabled={!replacement} onClick={startTweak}>Review revision</button>
          <button className="btn btn-ghost btn-sm" onClick={() => { setChooseFoundation(false); setReplacement(""); }}>Cancel</button>
        </div>}
        {revisionConfirmation && <div className="lifecycle-confirm"><p>Revise source {revisionConfirmation.revisionId} using foundation {foundationLabel(versions, revisionConfirmation.foundation)}. {revisionConfirmation.tweak}</p>
          <button className="btn btn-primary btn-sm" onClick={confirmRevision}>Confirm revision</button><button className="btn btn-ghost btn-sm" onClick={() => setRevisionConfirmation(null)}>Cancel</button></div>}
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
