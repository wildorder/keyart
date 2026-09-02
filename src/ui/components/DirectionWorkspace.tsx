/**
 * The TOP-LEVEL workspace for the focused direction (WS-18: one level of
 * selection). Hosts DirectionChrome + the focused DirectionGallery (single-
 * hero master–detail, swatch row, segmented version control) + AssetShelf +
 * the ChatRail — the ONLY ChatRail mount in the studio, with a non-nullable
 * `directionId`. Owns compare state (up to two versions, across directions).
 *
 * A DRAFT direction (zero versions, `head: null`) renders the describe-first
 * empty state instead of the gallery: brief form + moodboard dropzone, with
 * the chrome's single **Generate v1** CTA above them.
 */
import React, { useState } from "react";
import type {
  ApprovedDirection,
  DashboardDirection,
  DashboardGlobal,
} from "../types";
import { DirectionGallery, type CompareControls } from "./DirectionGallery";
import { DirectionChrome } from "./DirectionChrome";
import { CompareOverlay, type CompareItem } from "./CompareOverlay";
import { AssetShelf } from "./AssetShelf";
import { ChatRail } from "./ChatRail";
import { BriefEditor } from "./BriefEditor";
import { MoodboardUploader } from "./MoodboardUploader";
import { AssetGallery } from "./AssetGallery";

interface CompareRef {
  directionId: string;
  versionId: string;
}

const MAX_COMPARE = 2;

interface DirectionWorkspaceProps {
  /** The focused direction — the aggregate root this workspace renders. */
  direction: DashboardDirection;
  /** Every visible direction — compare selections may span siblings. */
  directions: DashboardDirection[];
  approved: ApprovedDirection | null;
  global: DashboardGlobal | null;
  reload: () => void;
}

export function DirectionWorkspace({
  direction,
  directions,
  approved,
  global,
  reload,
}: DirectionWorkspaceProps): JSX.Element {
  const pointer = global?.approvedPointer ?? null;

  const [compare, setCompare] = useState<CompareRef[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);

  // The version the user is actually VIEWING in the segmented version
  // switcher, for the chat rail to inherit. null ⇒ head.
  const [focusedVersionId, setFocusedVersionId] = useState<string | null>(null);

  const isPinnedVersion = (directionId: string, versionId: string): boolean => {
    if (pointer) {
      return pointer.directionId === directionId && pointer.versionId === versionId;
    }
    if (approved?.provenance) {
      const p = approved.provenance;
      return p.directionId === directionId && p.versionId === versionId;
    }
    return false;
  };

  const isCompareSelected = (directionId: string, versionId: string): boolean =>
    compare.some(
      (c) => c.directionId === directionId && c.versionId === versionId,
    );

  const toggleCompare = (directionId: string, versionId: string): void =>
    setCompare((prev) => {
      const exists = prev.some(
        (c) => c.directionId === directionId && c.versionId === versionId,
      );
      if (exists) {
        return prev.filter(
          (c) => !(c.directionId === directionId && c.versionId === versionId),
        );
      }
      if (prev.length >= MAX_COMPARE) return prev;
      return [...prev, { directionId, versionId }];
    });

  const compareDisabledFor = (directionId: string, versionId: string): boolean =>
    compare.length >= MAX_COMPARE && !isCompareSelected(directionId, versionId);

  const compareItems: CompareItem[] = compare
    .map(({ directionId, versionId }): CompareItem | null => {
      const owner = directions.find((d) => d.id === directionId);
      const version = owner?.versions.find((v) => v.versionId === versionId);
      if (!owner || !version) return null;
      return {
        directionId,
        version,
        isHead: version.versionId === owner.head,
        approved: isPinnedVersion(directionId, versionId),
      };
    })
    .filter((x): x is CompareItem => x !== null);

  const compareControls: CompareControls = {
    isSelected: isCompareSelected,
    toggle: toggleCompare,
    disabledFor: compareDisabledFor,
  };

  return (
    <div className="direction-workspace">
      <DirectionChrome direction={direction} reload={reload} />

      <div className="workspace-body workspace-focus-layout">
        <div className="workspace-focus-main">
          {direction.isDraft ? (
            /* Draft empty state — describe-first: fill in the brief, drop
               reference images, then Generate v1 (the chrome's single CTA). */
            <div className="workspace-empty-state">
              <div className="empty-state-setup">
                <BriefEditor direction={direction} reload={reload} />
                <div className="empty-state-moodboard">
                  <MoodboardUploader directionId={direction.id} reload={reload} />
                  <AssetGallery
                    assets={direction.assets}
                    directionId={direction.id}
                    expectedVersion={direction.version}
                    reload={reload}
                  />
                </div>
              </div>
              <p className="empty-state-hint">
                Fill in the brief and add reference images, then hit{" "}
                <strong>Generate v1</strong> above to render this direction&apos;s
                first version.
              </p>
            </div>
          ) : (
            <>
              <DirectionGallery
                direction={direction}
                isPinnedVersion={isPinnedVersion}
                reload={reload}
                compare={compareControls}
                onSelectedVersionChange={(version) =>
                  setFocusedVersionId(version.versionId)
                }
              />
              <AssetShelf direction={direction} reload={reload} />
            </>
          )}

          {compare.length > 0 && (
            <div className="compare-bar" role="region" aria-label="Compare selection">
              <span className="compare-bar-count">
                {compare.length} of {MAX_COMPARE} selected to compare
              </span>
              <div className="compare-bar-actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={compareItems.length !== MAX_COMPARE}
                  onClick={() => setCompareOpen(true)}
                >
                  Compare
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setCompare([]);
                    setCompareOpen(false);
                  }}
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {compareOpen && compareItems.length === MAX_COMPARE && (
            <CompareOverlay
              items={compareItems}
              onClose={() => setCompareOpen(false)}
              reload={reload}
            />
          )}
        </div>

        <ChatRail
          directionId={direction.id}
          direction={direction}
          focusedVersionId={focusedVersionId}
          pointer={pointer}
          reload={reload}
        />
      </div>
    </div>
  );
}
