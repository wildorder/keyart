/**
 * The gallery STAGE: one generated image, worked on in place.
 *
 * This is the surface that replaced the old duplicate-image feedback panel. In
 * `select` mode the staged image is an ordinary {@link AssetImage} — clicking it
 * opens the shared lightbox. In `crop` mode a marquee is dragged directly on the
 * image and rasterized client-side; in `eyedropper` mode a click reads one exact
 * pixel. Both capture modes render a PLAIN `<img>` (no lightbox button) so a
 * gesture is never stolen by a navigation click.
 *
 * Cropping and color-picking happen ENTIRELY client-side in a `<canvas>` — no
 * model call, no `OPENAI_API_KEY`. Pixels are read from the SAME-ORIGIN
 * `GET /api/asset` image so the canvas is untainted; `getImageData`/`toBlob` are
 * still guarded and surface a readable error rather than throwing.
 *
 * Coordinate math lives in the pure `../crop-math` module and mode/drag geometry
 * in `../stage-capture`, so this component holds only DOM wiring.
 */
import React, { useRef, useState } from "react";
import { AssetImage, assetUrl } from "./AssetImage";
import type { LightboxImage } from "./Lightbox";
import { toNaturalCrop, pixelToHex, type CropRect } from "../crop-math.js";
import {
  dataUrlToBlob,
  formatCropSize,
  isCaptureMode,
  isRealDrag,
  normalizeDrag,
  type Capture,
  type StageMode,
} from "../stage-capture.js";

export function StageImage({
  path,
  alt,
  mode,
  imgVersion,
  gallery,
  galleryIndex,
  onCapture,
}: {
  path: string;
  alt: string;
  mode: StageMode;
  /** Cache-bust token so a regenerated image at the same path refetches. */
  imgVersion: number;
  /** The lightbox group — used in `select` mode only. */
  gallery: LightboxImage[];
  galleryIndex: number;
  /** Fired when a crop is rasterized or a pixel is picked. */
  onCapture: (capture: Capture) => void;
}): JSX.Element {
  const imgRef = useRef<HTMLImageElement | null>(null);
  // The live marquee, in CSS px relative to the rendered image box.
  const [sel, setSel] = useState<CropRect | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Pointer coordinates relative to the rendered image box (CSS px, clamped). */
  const pointToImage = (
    e: React.PointerEvent | React.MouseEvent,
  ): { x: number; y: number } => {
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

  const metricsFor = (
    img: HTMLImageElement,
  ): {
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

  // --- Crop mode: drag a marquee, then rasterize the region client-side. ------

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
    setSel(normalizeDrag(dragStart.current, pointToImage(e)));
  };

  const onPointerUp = (e: React.PointerEvent): void => {
    if (mode !== "crop" || !dragStart.current) return;
    // The box comes from the release point, not from `sel`: the last move
    // event's state may not have rendered yet, and a fast drag can end before
    // any move was recorded at all.
    const finalSel = normalizeDrag(dragStart.current, pointToImage(e));
    dragStart.current = null;
    const img = imageReady();
    if (!img || !isRealDrag(finalSel)) {
      setSel(null);
      return; // ignore a stray click — a real crop needs a dragged box
    }
    const crop = toNaturalCrop(finalSel, metricsFor(img));
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
      // Synchronous encode — see dataUrlToBlob for why not toBlob.
      const blob = dataUrlToBlob(canvas.toDataURL("image/png"));
      if (!blob) {
        setError("Could not read the crop from this image.");
        return;
      }
      setError(null);
      onCapture({
        kind: "crop",
        blob,
        previewUrl: URL.createObjectURL(blob),
        size: crop,
      });
    } catch {
      setError("This image could not be read for cropping (tainted canvas).");
    } finally {
      setSel(null);
    }
  };

  // --- Eyedropper mode: read one exact pixel client-side. --------------------

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
      setError(null);
      onCapture({ kind: "color", hex: pixelToHex(data, 1, 0, 0) });
    } catch {
      setError("This image could not be read for color picking (tainted canvas).");
    }
  };

  // `select` mode is the plain gallery image, lightbox and all.
  if (!isCaptureMode(mode)) {
    return (
      <div className="stage-image stage-image--select">
        <AssetImage
          key={`${path}-${imgVersion}`}
          className="stage-image__img"
          path={path}
          alt={alt}
          version={imgVersion}
          gallery={gallery}
          galleryIndex={galleryIndex}
        />
      </div>
    );
  }

  return (
    <div className="stage-image">
      <div
        className={`stage-image__surface stage-image__surface--${mode}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onClick={onEyedropperClick}
      >
        <img
          ref={imgRef}
          key={`${path}-${imgVersion}`}
          className="stage-image__img"
          src={assetUrl(path, imgVersion)}
          alt={alt}
          draggable={false}
        />
        {sel && sel.width > 0 && sel.height > 0 && (
          <div
            className="stage-marquee"
            style={{
              left: `${sel.x}px`,
              top: `${sel.y}px`,
              width: `${sel.width}px`,
              height: `${sel.height}px`,
            }}
          >
            <span className="stage-marquee__size">{formatCropSize(sel)}</span>
          </div>
        )}
      </div>
      {error && <p className="stage-image__error">{error}</p>}
    </div>
  );
}
