/**
 * The image column of the direction focus pane, as ONE stage.
 *
 * There is a single set of images here and one place to work on them: the staged
 * image fills the stage, the thumbnail row below it selects which image is
 * staged, and the stage header carries the Select / Crop / Eyedrop mode toggle.
 * Dragging a crop or picking a color happens directly on the staged image — the
 * previous design opened a SEPARATE panel that re-rendered the same image at a
 * different size, so the user picked an image twice and worked on a duplicate.
 *
 * Capture is HEAD-ONLY: a historical version stages in `select` mode with no
 * toggle, since keep/discard/extract all act on the head. Coordinate and pixel
 * work lives in {@link StageImage} + `../crop-math`; the pending capture is
 * resolved by {@link ElementFeedback}, which is now a panel over a capture this
 * component already produced rather than an image surface of its own.
 */
import React, { useEffect, useState } from "react";
import type { DashboardVersion } from "../types";
import { AssetImage } from "./AssetImage";
import { ElementFeedback } from "./ElementFeedback";
import { StageImage } from "./StageImage";
import {
  STAGE_MODES,
  isCaptureMode,
  stageHint,
  stageModeLabel,
  type StageMode,
} from "../stage-capture.js";
import { galleryImagesOf, heroImageOf, stageImagesOf } from "../direction-hero-images";
import { sourceImageNameFor } from "../asset-shelf-helpers.js";
import { usePendingCapture } from "../pending-capture.js";

interface DirectionHeroProps {
  version: DashboardVersion;
  imgVersion: number;
  isHead: boolean;
  directionId: string;
  /** Called after a capture is successfully recorded (reloads the dashboard). */
  onFeedbackDone: () => void;
}

export function DirectionHero({
  version,
  imgVersion,
  isHead,
  directionId,
  onFeedbackDone,
}: DirectionHeroProps): JSX.Element {
  const stageImages = stageImagesOf(version);
  const gallery = galleryImagesOf(version, imgVersion);
  const hero = heroImageOf(version);

  const [mode, setMode] = useState<StageMode>("select");
  const [activePath, setActivePath] = useState<string | null>(hero);
  // The capture is SHARED — it lands as a chip in the chat composer, which is
  // where it gets resolved. The panel below only opens for extract, which is
  // the one intent that needs a form.
  const { pending, setPending, clear: clearCapture } = usePendingCapture();
  const [extractOpen, setExtractOpen] = useState(false);

  const capture = pending?.capture ?? null;

  // Keep the staged image valid as versions are appended / regenerated: re-stage
  // the hero whenever the version's image set changes underneath us.
  const stagePaths = stageImages.map((s) => s.path).join(",");
  useEffect(() => {
    setActivePath((current) =>
      current && stageImages.some((s) => s.path === current) ? current : hero,
    );
    clearCapture();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stagePaths, hero]);

  // Capture acts on the head only, so a historical version always stages plainly.
  const effectiveMode: StageMode = isHead ? mode : "select";

  const switchMode = (next: StageMode): void => {
    clearCapture();
    setExtractOpen(false);
    setMode(next);
  };

  if (!hero || stageImages.length === 0) {
    return (
      <div className="direction-hero">
        <div className="gallery-no-preview" role="note">
          <span className="gallery-no-preview-title">No preview generated</span>
          <span className="gallery-no-preview-hint">
            Preview images require <code>OPENAI_API_KEY</code> and an entitled image model.
          </span>
        </div>
      </div>
    );
  }

  const staged = activePath ?? hero;
  const stagedLabel =
    stageImages.find((s) => s.path === staged)?.label ?? "Generated image";
  const stagedIndex = Math.max(
    0,
    gallery.findIndex((g) => g.path === staged),
  );

  return (
    <div className="direction-hero">
      <div className="stage">
        <div className="stage-head">
          <b className="stage-head__title">Gallery</b>
          <span className="stage-head__count">
            {stageImages.length} {stageImages.length === 1 ? "image" : "images"}
          </span>
          {isHead && (
            <div className="stage-tools" role="group" aria-label="Stage mode">
              {STAGE_MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`stage-tool${effectiveMode === m ? " is-active" : ""}`}
                  aria-pressed={effectiveMode === m}
                  onClick={() => switchMode(m)}
                >
                  {stageModeLabel(m)}
                </button>
              ))}
            </div>
          )}
        </div>

        <StageImage
          path={staged}
          alt={`${version.name} — ${stagedLabel}`}
          mode={effectiveMode}
          imgVersion={imgVersion}
          gallery={gallery}
          galleryIndex={stagedIndex}
          onCapture={(next) => {
            setExtractOpen(false);
            setPending({
              capture: next,
              directionId,
              versionId: version.versionId,
              sourceImage: sourceImageNameFor(version.images, staged) ?? undefined,
            });
          }}
        />

        {stageImages.length > 1 && (
          <div className="stage-thumbs" role="tablist" aria-label="Staged image">
            {stageImages.map((s) => (
              <button
                key={s.path}
                type="button"
                role="tab"
                aria-selected={s.path === staged}
                className={`stage-thumb${s.path === staged ? " is-active" : ""}`}
                title={s.label}
                onClick={() => {
                  clearCapture();
                  setActivePath(s.path);
                }}
              >
                <AssetImage
                  key={`${s.path}-${imgVersion}`}
                  className="stage-thumb__img"
                  path={s.path}
                  alt={`${version.name} — ${s.label}`}
                  version={imgVersion}
                />
                <span className="stage-thumb__label">{s.label}</span>
              </button>
            ))}
          </div>
        )}

        {isHead && (
          <p className="stage-hint">
            {capture
              ? "Captured — resolve it from the chat composer, or open the full options below."
              : stageHint(effectiveMode)}
          </p>
        )}
      </div>

      {/* Resolved from the composer by default. The full panel opens on demand,
          for extract-as-asset and the less common options. */}
      {isHead && isCaptureMode(effectiveMode) && capture && (
        <>
          <button
            type="button"
            className="btn btn-sm btn-ghost stage-more-options"
            aria-expanded={extractOpen}
            onClick={() => setExtractOpen((o) => !o)}
          >
            {extractOpen ? "Hide options" : "More options (keep as, extract as asset)…"}
          </button>
          {extractOpen && (
            <ElementFeedback
              key={capture.kind === "crop" ? capture.previewUrl : capture.hex}
              directionId={directionId}
              versionId={version.versionId}
              capture={capture}
              sourceImage={sourceImageNameFor(version.images, staged) ?? undefined}
              onClear={() => {
                clearCapture();
                setExtractOpen(false);
              }}
              onDone={() => {
                clearCapture();
                setExtractOpen(false);
                onFeedbackDone();
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
