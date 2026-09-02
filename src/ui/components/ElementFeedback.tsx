/**
 * The tactile studio gesture that closes the visual-feedback loop: over a single
 * generated evocative image, the user either drags a marquee to CROP a region or
 * uses an EYEDROPPER to pick an exact pixel color, then marks it KEEP
 * (`inspire` | `extract`) or DISCARD (with a note). Cropping and color-picking
 * happen ENTIRELY client-side in a `<canvas>` — no model call, no
 * `OPENAI_API_KEY` — and the result is POSTed to `/api/element-feedback` (WS-03).
 *
 * All coordinate/pixel math lives in the pure, DOM-free `../crop-math` module so
 * it is correct across CSS-scaled / retina images and unit-testable without JSX.
 * The overlay reads pixels from the SAME-ORIGIN `GET /api/asset` image, so the
 * canvas is untainted; the `getImageData`/`toBlob` calls are still guarded.
 */
import React, { useRef, useState } from "react";
import { assetUrl } from "./AssetImage";
import { toNaturalCrop, pixelToHex, type CropRect } from "../crop-math.js";
import { useElementFeedback, postAssetExtract, ApiError } from "../hooks.js";
import type { ElementFeedbackIntent, Job } from "../types";
import {
  elementFeedbackRequest,
  extractAssetRequest,
} from "../direction-actions.js";
import { elementFeedbackTargetFields } from "./memory-select.js";
import type { AssetSourceImage } from "../asset-shelf-helpers.js";
import { JobProgress, summarizeJob } from "./JobProgress";
import { useToasts } from "./Toasts";

type Mode = "crop" | "eyedropper";

/** A pending capture — either a cropped PNG or an eyedropper hex, never both. */
type Capture =
  | { kind: "crop"; blob: Blob; previewUrl: string }
  | { kind: "color"; hex: string };

export function ElementFeedback({
  directionId,
  versionId,
  imagePath,
  sourceImage,
  onDone,
}: {
  directionId: string;
  versionId?: string;
  imagePath: string;
  /** The logical source-image name for this feedback target (additive,
   * WS-06) — the extract action's `image` field. Absent → the field is
   * omitted from the extract POST and the server applies its default. */
  sourceImage?: AssetSourceImage;
  onDone: () => void;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [mode, setMode] = useState<Mode>("crop");
  // The live marquee, in CSS px relative to the rendered image box.
  const [sel, setSel] = useState<CropRect | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [note, setNote] = useState("");
  const [intent, setIntent] = useState<ElementFeedbackIntent>("inspire");
  const [canvasError, setCanvasError] = useState<string | null>(null);

  const { submit, pending, error } = useElementFeedback();
  const { pushToast } = useToasts();

  // --- Extract-as-asset (WS-06, additive — the crop keep/discard/eyedropper
  // paths above are untouched). ------------------------------------------
  const [extractOpen, setExtractOpen] = useState(false);
  const [assetName, setAssetName] = useState("");
  const [assetDescribe, setAssetDescribe] = useState("");
  const [extractJobId, setExtractJobId] = useState<string | null>(null);
  const [extractPending, setExtractPending] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  const resetExtract = (): void => {
    setExtractOpen(false);
    setExtractError(null);
  };

  /** Pointer coordinates relative to the rendered image box (CSS px, clamped). */
  const pointToImage = (e: React.PointerEvent | React.MouseEvent): { x: number; y: number } => {
    const img = imgRef.current;
    if (!img) return { x: 0, y: 0 };
    const rect = img.getBoundingClientRect();
    return {
      x: Math.min(Math.max(0, e.clientX - rect.left), rect.width),
      y: Math.min(Math.max(0, e.clientY - rect.top), rect.height),
    };
  };

  const imageReady = (): HTMLImageElement | null => {
    const img = imgRef.current;
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  };

  const metricsFor = (img: HTMLImageElement): {
    clientWidth: number;
    clientHeight: number;
    naturalWidth: number;
    naturalHeight: number;
  } => {
    const rect = img.getBoundingClientRect();
    return {
      clientWidth: rect.width,
      clientHeight: rect.height,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
    };
  };

  const clearCapture = (): void => {
    setCapture((prev) => {
      if (prev?.kind === "crop") URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    resetExtract();
  };

  // --- Crop mode: draw a marquee, then rasterize the region client-side. ------

  const onPointerDown = (e: React.PointerEvent): void => {
    if (mode !== "crop" || !imageReady()) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = pointToImage(e);
    dragStart.current = p;
    setSel({ x: p.x, y: p.y, width: 0, height: 0 });
  };

  const onPointerMove = (e: React.PointerEvent): void => {
    if (mode !== "crop" || !dragStart.current) return;
    const start = dragStart.current;
    const p = pointToImage(e);
    setSel({
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      width: Math.abs(p.x - start.x),
      height: Math.abs(p.y - start.y),
    });
  };

  const onPointerUp = (): void => {
    if (mode !== "crop" || !dragStart.current) return;
    dragStart.current = null;
    const img = imageReady();
    if (!img || !sel || sel.width < 4 || sel.height < 4) {
      setSel(null);
      return; // ignore a stray click — a real crop needs a dragged box
    }
    const crop = toNaturalCrop(sel, metricsFor(img));
    try {
      const canvas = document.createElement("canvas");
      canvas.width = crop.width;
      canvas.height = crop.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(
        img,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        crop.width,
        crop.height,
      );
      canvas.toBlob((blob) => {
        if (!blob) {
          setCanvasError("Could not read the crop from this image.");
          return;
        }
        clearCapture();
        setCanvasError(null);
        setCapture({ kind: "crop", blob, previewUrl: URL.createObjectURL(blob) });
      }, "image/png");
    } catch {
      setCanvasError("This image could not be read for cropping (tainted canvas).");
    } finally {
      setSel(null);
    }
  };

  // --- Eyedropper mode: read one exact pixel client-side. ---------------------

  const onEyedropperClick = (e: React.MouseEvent): void => {
    if (mode !== "eyedropper") return;
    const img = imageReady();
    if (!img) return;
    const p = pointToImage(e);
    const m = metricsFor(img);
    // Map the click to a single natural pixel (a 1×1 selection clamps in-bounds).
    const px = toNaturalCrop({ x: p.x, y: p.y, width: 0, height: 0 }, m);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = m.naturalWidth;
      canvas.height = m.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(img, 0, 0);
      const { data } = ctx.getImageData(px.x, px.y, 1, 1);
      clearCapture();
      setCanvasError(null);
      setCapture({ kind: "color", hex: pixelToHex(data, 1, 0, 0) });
    } catch {
      setCanvasError("This image could not be read for color picking (tainted canvas).");
    }
  };

  // --- Submit the pending capture to /api/element-feedback. -------------------

  const finish = async (payload: Parameters<typeof submit>[0]): Promise<void> => {
    const ok = await submit(payload);
    if (!ok) return; // error is surfaced inline; keep the capture so it can retry
    clearCapture();
    setNote("");
    onDone();
  };

  const trimmedNote = note.trim();
  const noteField: Record<string, string> = trimmedNote ? { note: trimmedNote } : {};
  // Scope is location now — the focused direction is always the target.
  const targetFields = elementFeedbackTargetFields(directionId, versionId);

  const keepCrop = (): void => {
    if (capture?.kind !== "crop") return;
    const req = elementFeedbackRequest({
      verb: "keep",
      intent,
      ...noteField,
      ...targetFields,
    });
    void finish({ blob: capture.blob, filename: "crop.png", fields: req.form! });
  };

  const discardCrop = (): void => {
    if (capture?.kind !== "crop") return;
    const req = elementFeedbackRequest({
      verb: "discard",
      ...noteField,
      ...targetFields,
    });
    void finish({ blob: capture.blob, filename: "discard.png", fields: req.form! });
  };

  const lockColor = (): void => {
    if (capture?.kind !== "color") return;
    const req = elementFeedbackRequest({
      verb: "keep",
      hex: capture.hex,
      ...noteField,
      ...targetFields,
    });
    void finish({ blob: null, fields: req.form! });
  };

  // --- Extract as asset (WS-06, additive) — crop-referenced only; the text-
  // described form is the chat/CLI path. --------------------------------
  const startExtract = async (): Promise<void> => {
    if (capture?.kind !== "crop" || extractPending) return;
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
        ...(versionId ? { versionId } : {}), // the version the overlay is showing
      });
      const { jobId } = await postAssetExtract({
        blob: capture.blob, // the crop PNG the component already produced
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
      clearCapture();
      setAssetName("");
      setAssetDescribe("");
      onDone(); // → onFeedbackDone → closes the overlay + reload() → the shelf shows the new asset
    } else {
      pushToast({ kind: "error", message: job.error ?? summarizeJob(job) });
    }
  };

  const switchMode = (next: Mode): void => {
    setMode(next);
    setSel(null);
    dragStart.current = null;
    clearCapture();
    setCanvasError(null);
  };

  return (
    <div className="element-feedback">
      <div className="ef-toolbar" role="group" aria-label="Feedback mode">
        <button
          type="button"
          className={`ef-mode-btn ${mode === "crop" ? "is-active" : ""}`}
          aria-pressed={mode === "crop"}
          onClick={() => switchMode("crop")}
        >
          ▭ Crop
        </button>
        <button
          type="button"
          className={`ef-mode-btn ${mode === "eyedropper" ? "is-active" : ""}`}
          aria-pressed={mode === "eyedropper"}
          onClick={() => switchMode("eyedropper")}
        >
          ⬤ Eyedropper
        </button>
        <span className="ef-hint">
          {mode === "crop"
            ? "Drag a box over what to keep or discard."
            : "Click a pixel to pick its exact color."}
        </span>
      </div>

      <div
        className={`ef-stage ef-stage--${mode}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onEyedropperClick}
      >
        <img
          ref={imgRef}
          className="ef-image"
          src={assetUrl(imagePath)}
          alt="Generated image — draw a crop or pick a color"
          draggable={false}
        />
        {sel && sel.width > 0 && sel.height > 0 && (
          <div
            className="ef-marquee"
            style={{
              left: `${sel.x}px`,
              top: `${sel.y}px`,
              width: `${sel.width}px`,
              height: `${sel.height}px`,
            }}
          />
        )}
      </div>

      <p className="ef-note-copy">
        Keeps bias the next render toward the crop; discards bias away from it —
        this steers regeneration, it is not a literal region swap.
      </p>

      {canvasError && <p className="ef-error">{canvasError}</p>}

      {capture?.kind === "crop" && (
        <div className="ef-panel">
          <img className="ef-preview" src={capture.previewUrl} alt="Cropped region" />
          <div className="ef-panel-fields">
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
            <button type="button" className="btn btn-ghost" disabled={pending} onClick={clearCapture}>
              Clear
            </button>
          </div>

          {extractOpen && (
            <div className="ef-extract">
              <p className="ef-extract__hint">
                Isolates this element onto a transparent PNG — a new versioned asset on
                this direction's shelf.
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

      {capture?.kind === "color" && (
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
            <button type="button" className="btn btn-ghost" disabled={pending} onClick={clearCapture}>
              Clear
            </button>
          </div>
        </div>
      )}

      {error && <p className="ef-error">{error}</p>}
    </div>
  );
}
