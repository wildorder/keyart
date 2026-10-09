/**
 * Resolves ONE pending capture taken on the gallery stage: a cropped region is
 * marked KEEP (`inspire` | `extract`), DISCARDED with a note, or extracted as a
 * transparent-PNG asset; an eyedropper pixel is locked as a color. The result is
 * POSTed to `/api/element-feedback` (WS-03) — or, for extract, to
 * `/api/actions/asset-extract` — with both server contracts unchanged.
 *
 * This component no longer renders an image. Cropping and color-picking happen on
 * the stage itself ({@link StageImage}, driven by {@link DirectionHero}) and the
 * capture arrives as a prop. That split is what removed the duplicate image the
 * user previously had to re-select and work on. The quick Keep / Discard / Lock
 * in the chat rail's composer cover the common case; this panel is the fuller
 * form, for the keep intent and extract-as-asset.
 */
import React, { useState } from "react";
import { useElementFeedback, postAssetExtract, ApiError } from "../hooks.js";
import type { ElementFeedbackIntent, Job } from "../types";
import {
  elementFeedbackRequest,
  extractAssetRequest,
} from "../direction-actions.js";
import { elementFeedbackTargetFields } from "./memory-select.js";
import type { AssetSourceImage } from "../asset-shelf-helpers.js";
import { formatCropSize, type Capture } from "../stage-capture.js";
import { JobProgress, summarizeJob } from "./JobProgress";
import { useToasts } from "./Toasts";

export function ElementFeedback({
  directionId,
  versionId,
  capture,
  sourceImage,
  onClear,
  onDone,
}: {
  directionId: string;
  versionId?: string;
  /** The capture taken on the stage — a crop PNG or an eyedropper hex. */
  capture: Capture;
  /** The logical source-image name for this feedback target (additive,
   * WS-06) — the extract action's `image` field. Absent → the field is
   * omitted from the extract POST and the server applies its default. */
  sourceImage?: AssetSourceImage;
  /** Drop the pending capture without recording anything. */
  onClear: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [intent, setIntent] = useState<ElementFeedbackIntent>("inspire");

  const { submit, pending, error } = useElementFeedback();
  const { pushToast } = useToasts();

  // --- Extract-as-asset (WS-06) — crop-referenced only; the text-described
  // form is the chat/CLI path. --------------------------------------------
  const [extractOpen, setExtractOpen] = useState(false);
  const [assetName, setAssetName] = useState("");
  const [assetDescribe, setAssetDescribe] = useState("");
  const [extractJobId, setExtractJobId] = useState<string | null>(null);
  const [extractPending, setExtractPending] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  /** Submit the pending capture, then hand control back to the stage. */
  const finish = async (payload: Parameters<typeof submit>[0]): Promise<void> => {
    const ok = await submit(payload);
    if (!ok) return; // error is surfaced inline; keep the capture so it can retry
    setNote("");
    onDone();
  };

  const trimmedNote = note.trim();
  const noteField: Record<string, string> = trimmedNote ? { note: trimmedNote } : {};
  // Scope is location — the direction the capture was taken on is the target.
  const targetFields = elementFeedbackTargetFields(directionId, versionId);

  const keepCrop = (): void => {
    if (capture.kind !== "crop") return;
    const req = elementFeedbackRequest({
      verb: "keep",
      intent,
      ...noteField,
      ...targetFields,
    });
    void finish({ blob: capture.blob, filename: "crop.png", fields: req.form! });
  };

  const discardCrop = (): void => {
    if (capture.kind !== "crop") return;
    const req = elementFeedbackRequest({
      verb: "discard",
      ...noteField,
      ...targetFields,
    });
    void finish({ blob: capture.blob, filename: "discard.png", fields: req.form! });
  };

  const lockColor = (): void => {
    if (capture.kind !== "color") return;
    const req = elementFeedbackRequest({
      verb: "keep",
      hex: capture.hex,
      ...noteField,
      ...targetFields,
    });
    void finish({ blob: null, fields: req.form! });
  };

  const startExtract = async (): Promise<void> => {
    if (capture.kind !== "crop" || extractPending) return;
    const name = assetName.trim();
    if (name.length === 0) return;
    const describe = assetDescribe.trim() || name; // describe defaults from the name
    setExtractPending(true);
    setExtractError(null);
    try {
      const req = extractAssetRequest({
        directionId, // the focused direction — direction-scoped by construction
        describe,
        name,
        ...(sourceImage ? { image: sourceImage } : {}),
        ...(versionId ? { versionId } : {}), // the version the stage is showing
      });
      const { jobId } = await postAssetExtract({
        blob: capture.blob, // the crop PNG the stage already produced
        filename: "crop.png",
        fields: req.form!,
      });
      setExtractJobId(jobId); // 202 — the job now renders inline
    } catch (e) {
      setExtractError(e instanceof ApiError ? e.message : String(e));
      setExtractPending(false); // keep the capture + fields so the user can retry
    }
  };

  const onExtractJobDone = (job: Job): void => {
    setExtractPending(false);
    setExtractJobId(null);
    if (job.status === "succeeded") {
      pushToast({ kind: "success", message: `Extracted asset — ${assetName.trim()}` });
      setAssetName("");
      setAssetDescribe("");
      onDone(); // clears the capture + reload() → the shelf shows the new asset
    } else {
      pushToast({ kind: "error", message: job.error ?? summarizeJob(job) });
    }
  };

  return (
    <div className="element-feedback">
      {capture.kind === "crop" && (
        <div className="ef-panel">
          <img className="ef-preview" src={capture.previewUrl} alt="Cropped region" />
          <div className="ef-panel-fields">
            <p className="ef-capture-size">{formatCropSize(capture.size)} px</p>
            <label className="ef-field">
              <span>Note (reason to keep or discard)</span>
              <input
                type="text"
                value={note}
                placeholder="e.g. love this texture / too busy"
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <label className="ef-field">
              <span>Keep as</span>
              <select
                value={intent}
                onChange={(e) => setIntent(e.target.value as ElementFeedbackIntent)}
              >
                <option value="inspire">inspire (feed the imagery)</option>
                <option value="extract">extract (seed the palette)</option>
              </select>
            </label>
          </div>
          <div className="ef-actions">
            <button type="button" className="btn btn-primary" disabled={pending} onClick={keepCrop}>
              {pending ? "Saving…" : "Keep this"}
            </button>
            <button type="button" className="btn btn-ghost" disabled={pending} onClick={discardCrop}>
              Discard with note
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              disabled={pending || extractPending}
              aria-expanded={extractOpen}
              onClick={() => setExtractOpen((o) => !o)}
            >
              Extract as asset
            </button>
            <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClear}>
              Clear
            </button>
          </div>

          {extractOpen && (
            <div className="ef-extract">
              <p className="ef-extract__hint">
                Isolates this element onto a transparent PNG — a new versioned asset on
                this direction&apos;s shelf.
              </p>
              <div className="ef-extract__fields">
                <label className="ef-field">
                  <span>Asset name</span>
                  <input
                    type="text"
                    value={assetName}
                    placeholder="yak-mascot"
                    onChange={(e) => setAssetName(e.target.value)}
                  />
                </label>
                <label className="ef-field">
                  <span>Describe the element (defaults from the name)</span>
                  <input
                    type="text"
                    value={assetDescribe}
                    placeholder="e.g. the yak mascot illustration"
                    onChange={(e) => setAssetDescribe(e.target.value)}
                  />
                </label>
              </div>
              <div className="ef-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={extractPending || assetName.trim().length === 0}
                  onClick={startExtract}
                >
                  {extractPending ? "Extracting…" : "Extract"}
                </button>
              </div>
              <JobProgress jobId={extractJobId} onDone={onExtractJobDone} />
              {extractError && <p className="ef-error">{extractError}</p>}
            </div>
          )}
        </div>
      )}

      {capture.kind === "color" && (
        <div className="ef-panel">
          <span className="ef-swatch" style={{ backgroundColor: capture.hex }} aria-hidden="true" />
          <code className="ef-swatch-hex">{capture.hex}</code>
          <label className="ef-field">
            <span>Note (optional)</span>
            <input
              type="text"
              value={note}
              placeholder="e.g. brand teal"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="ef-actions">
            <button type="button" className="btn btn-primary" disabled={pending} onClick={lockColor}>
              {pending ? "Saving…" : "Lock this color"}
            </button>
            <button type="button" className="btn btn-ghost" disabled={pending} onClick={onClear}>
              Clear
            </button>
          </div>
        </div>
      )}

      {error && <p className="ef-error">{error}</p>}
    </div>
  );
}
