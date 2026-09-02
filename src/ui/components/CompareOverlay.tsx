/**
 * A full-screen, side-by-side comparison of exactly two versions — the answer to
 * "history is hard to review inline". Selection is made via the Compare checkbox
 * on each version pill (workspace-level, so the two may come from different
 * directions or versions, e.g. an old version vs. the head);
 * {@link DirectionWorkspace} opens this overlay once two are chosen.
 *
 * Each column renders the SAME {@link DirectionCardBody} used inline, so the two
 * versions are compared with identical cards (approve / regenerate / edit /
 * restore all work here) and no card logic is duplicated.
 *
 * Escape or the backdrop/close button dismisses it; body scroll is locked while
 * open.
 */
import React, { useEffect } from "react";
import type { DashboardVersion } from "../types";
import { DirectionCardBody, PaletteStrip } from "./DirectionGallery";

export interface CompareItem {
  directionId: string;
  version: DashboardVersion;
  isHead: boolean;
  approved: boolean;
}

export function CompareOverlay({
  items,
  onClose,
  reload,
}: {
  items: CompareItem[];
  onClose: () => void;
  reload: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div className="compare-overlay" role="dialog" aria-modal="true" aria-label="Compare versions">
      <button
        type="button"
        className="compare-overlay-backdrop"
        aria-label="Close compare"
        onClick={onClose}
      />
      <div className="compare-overlay-panel">
        <div className="compare-overlay-head">
          <h2>Compare versions</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close ✕
          </button>
        </div>
        <div className="compare-grid">
          {items.map((item) => (
            <div key={`${item.directionId}:${item.version.versionId}`} className="compare-col">
              <div className="compare-col-head">
                <div className="compare-col-title">
                  <span className="compare-col-name">
                    {item.version.name}
                    {item.isHead && (
                      <span className="direction-row-head" title="Current head version">
                        {" "}
                        head
                      </span>
                    )}
                    {item.approved && (
                      <span className="direction-row-approved" title="Approved (pinned) version">
                        {" "}
                        approved ✓
                      </span>
                    )}
                  </span>
                  <span className="compare-col-run">
                    {item.directionId} · {item.version.versionId}
                  </span>
                </div>
                <PaletteStrip version={item.version} />
              </div>
              <div className="direction-card direction-card--rich compare-card">
                <DirectionCardBody
                  directionId={item.directionId}
                  version={item.version}
                  isHead={item.isHead}
                  approved={item.approved}
                  reload={reload}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
