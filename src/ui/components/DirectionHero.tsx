/**
 * The image column of the direction focus pane: one dominant hero image
 * (homepage mockup preferred, style tile as fallback) with the remaining
 * evocative images demoted to small secondary thumbnails beneath it. All
 * images share one Lightbox group so paging through the viewer still walks
 * every generated image in order.
 *
 * Element-level feedback (crop / eyedropper on all three image targets) lives
 * here, but is HEAD-ONLY — the trigger and ElementFeedback panel are hidden for
 * historical versions. State for feedbackPath is lifted to DirectionCardBody.
 *
 * This component is purely presentational: it receives all data + callbacks as
 * props and owns no regenerate / approve logic.
 */
import React from "react";
import type { DashboardVersion } from "../types";
import { AssetImage } from "./AssetImage";
import { ElementFeedback } from "./ElementFeedback";
import {
  heroImageOf,
  secondaryImagesOf,
  galleryImagesOf,
} from "../direction-hero-images";
import { sourceImageNameFor } from "../asset-shelf-helpers.js";

interface DirectionHeroProps {
  version: DashboardVersion;
  imgVersion: number;
  isHead: boolean;
  directionId: string;
  feedbackPath: string | null;
  onToggleFeedback: (path: string) => void;
  onFeedbackDone: () => void;
}

export function DirectionHero({
  version,
  imgVersion,
  isHead,
  directionId,
  feedbackPath,
  onToggleFeedback,
  onFeedbackDone,
}: DirectionHeroProps): JSX.Element {
  const hero = heroImageOf(version);
  const secondaries = secondaryImagesOf(version);
  const gallery = galleryImagesOf(version, imgVersion);

  const galleryIndexOf = (path: string): number => gallery.findIndex((g) => g.path === path);

  const heroLabel =
    hero === version.images?.homepageMockup ? "Homepage mockup" : "Style tile";

  const feedbackTargets: { path: string; label: string }[] = [];
  if (version.images?.styleTile)
    feedbackTargets.push({ path: version.images.styleTile, label: "style tile" });
  if (version.images?.homepageMockup)
    feedbackTargets.push({ path: version.images.homepageMockup, label: "homepage mockup" });
  if (version.images?.styleBoard)
    feedbackTargets.push({ path: version.images.styleBoard, label: "style board" });

  return (
    <div className="direction-hero">
      {hero ? (
        <>
          <figure className="direction-hero-main">
            <AssetImage
              key={`${hero}-${imgVersion}`}
              className="direction-hero-image"
              path={hero}
              alt={`${version.name} — ${heroLabel}`}
              version={imgVersion}
              gallery={gallery}
              galleryIndex={galleryIndexOf(hero)}
            />
            <figcaption className="direction-hero-caption">{heroLabel}</figcaption>
          </figure>
          {secondaries.length > 0 && (
            <div className="direction-hero-thumbs">
              {secondaries.map((s) => (
                <figure className="direction-hero-thumb" key={s.path}>
                  <AssetImage
                    key={`${s.path}-${imgVersion}`}
                    className="direction-hero-thumb-image"
                    path={s.path}
                    alt={`${version.name} — ${s.label}`}
                    version={imgVersion}
                    gallery={gallery}
                    galleryIndex={galleryIndexOf(s.path)}
                  />
                  <figcaption className="direction-hero-thumb-caption">{s.label}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="gallery-no-preview" role="note">
          <span className="gallery-no-preview-title">No preview generated</span>
          <span className="gallery-no-preview-hint">
            Preview images require <code>OPENAI_API_KEY</code> and an entitled image model.
          </span>
        </div>
      )}

      {isHead && feedbackTargets.length > 0 && (
        <div className="gallery-feedback">
          <span className="gallery-feedback-label">Give feedback on an image:</span>
          <div className="gallery-feedback-tabs">
            {feedbackTargets.map((t) => (
              <button
                key={t.path}
                type="button"
                className={`btn btn-sm btn-ghost ${feedbackPath === t.path ? "is-active" : ""}`}
                aria-expanded={feedbackPath === t.path}
                onClick={() => onToggleFeedback(t.path)}
              >
                {feedbackPath === t.path ? `Close ${t.label}` : t.label}
              </button>
            ))}
          </div>
          {feedbackPath && (
            <ElementFeedback
              key={feedbackPath}
              directionId={directionId}
              versionId={version.versionId}
              imagePath={feedbackPath}
              sourceImage={sourceImageNameFor(version.images, feedbackPath) ?? undefined}
              onDone={onFeedbackDone}
            />
          )}
        </div>
      )}
    </div>
  );
}
