/**
 * One direction rendered as a SINGLE card with an optional version switcher.
 * History no longer stacks full bodies — picking a pill swaps the one
 * {@link DirectionCardBody} below (default: head). Single-version directions
 * skip the pill bar entirely.
 *
 * The full card body — positioning, generated imagery, the exact palette/type
 * board, design rules, copy, and the approve/regenerate/edit/restore controls —
 * lives in {@link DirectionCardBody}, a single renderer shared by the inline
 * gallery AND the full-screen {@link CompareOverlay}, so there is no
 * duplicated card logic.
 *
 * The single iterate path is **regenerate → append a new version** (head-only).
 * A non-head, historical version is read-only with a **"Restore this version"**
 * control that appends its content as a new head. Approve pins a specific version
 * (distinct from the head). The version switcher shows segmented v1/v2/v3 pills;
 * compare is a lighter, non-default affordance revealed by a Compare toggle.
 */
import React, { useEffect, useState } from "react";
import type {
  DashboardDirection,
  DashboardVersion,
  PaletteRole,
} from "../types";
import { postJson, isVersionConflict, VERSION_CONFLICT_MESSAGE } from "../hooks";
import {
  approveRequest,
  regenerateRequest,
  restoreVersionRequest,
} from "../direction-actions.js";
import { DirectionEditor } from "./DirectionEditor";
import { PaletteBoard } from "./PaletteBoard";
import { JobProgress, useAction } from "./JobProgress";
import { useToasts } from "./Toasts";
import { DirectionHero } from "./DirectionHero";

/**
 * Workspace-level compare selection, threaded down from
 * {@link DirectionWorkspace} so a comparison can span directions/versions.
 * Selection is capped at two; `disabledFor` is true for unselected rows once
 * two are chosen.
 */
export interface CompareControls {
  isSelected: (directionId: string, versionId: string) => boolean;
  toggle: (directionId: string, versionId: string) => void;
  disabledFor: (directionId: string, versionId: string) => boolean;
}

/** A compact strip of the version's palette swatches for at-a-glance signal. */
export function PaletteStrip({
  version,
  max = 7,
}: {
  version: DashboardVersion;
  max?: number;
}) {
  const palette = version.tokens?.palette;
  if (!palette || palette.length === 0) return null;
  return (
    <span className="palette-strip" aria-hidden="true">
      {palette.slice(0, max).map((t) => (
        <span
          key={t.role}
          className="palette-strip-chip"
          style={{ backgroundColor: t.hex }}
          title={`${t.name} ${t.hex}`}
        />
      ))}
    </span>
  );
}

/** Format a version's createdAt for pill tooltips / secondary labels. */
function shortDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

export function DirectionGallery({
  direction,
  isPinnedVersion,
  reload,
  compare,
  onSelectedVersionChange,
}: {
  direction: DashboardDirection;
  isPinnedVersion: (directionId: string, versionId: string) => boolean;
  reload: () => void;
  compare: CompareControls;
  /** Notify the parent when the selected version changes (so the chat rail
   * inherits the VIEWED version, not blindly the head). */
  onSelectedVersionChange?: (version: DashboardVersion) => void;
}) {
  const [selectedVersionId, setSelectedVersionId] = useState(direction.head);
  const [compareMode, setCompareMode] = useState(false);

  // Keep selection valid when versions are appended / reloaded.
  useEffect(() => {
    const stillThere = direction.versions.some((v) => v.versionId === selectedVersionId);
    if (!stillThere) setSelectedVersionId(direction.head);
  }, [direction.versions, direction.head, selectedVersionId]);

  // Prefer following the head when it advances (new regenerate), unless the
  // user deliberately picked a historical version that still exists.
  useEffect(() => {
    setSelectedVersionId(direction.head);
  }, [direction.head]);

  const versionsHeadFirst = [...direction.versions].reverse();
  const selected =
    direction.versions.find((v) => v.versionId === selectedVersionId) ??
    direction.versions[direction.versions.length - 1];

  useEffect(() => {
    if (selected) onSelectedVersionChange?.(selected);
    // Intentionally depend on identity fields only — the parent callback is not
    // memoized and must not retrigger this effect every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.versionId, selected?.name]);

  if (!selected) return null;

  const isHead = selected.versionId === direction.head;
  const approved = isPinnedVersion(direction.id, selected.versionId);
  const showSwitcher = direction.versions.length > 1;

  return (
    <div className="direction-gallery">
      {/* Description of the active direction. The title lives in the
          DirectionChrome above. */}
      <div className="direction-header">
        <p className="gallery-summary">{selected.summary}</p>
        {selected.positioning && (
          <p className="gallery-positioning">{selected.positioning}</p>
        )}
      </div>

      {/* Segmented version pills + lighter compare affordance */}
      <div className="version-pills-bar">
        {showSwitcher && (
          <div className="version-pills" role="tablist" aria-label="Version history">
            {versionsHeadFirst.map((v) => {
              const ordinal =
                direction.versions.findIndex((x) => x.versionId === v.versionId) + 1;
              const pillIsHead = v.versionId === direction.head;
              const pillApproved = isPinnedVersion(direction.id, v.versionId);
              const selectedPill = v.versionId === selected.versionId;
              return (
                <button
                  key={v.versionId}
                  type="button"
                  role="tab"
                  aria-selected={selectedPill}
                  className={`version-pill${selectedPill ? " is-selected" : ""}${
                    compare.isSelected(direction.id, v.versionId) ? " is-comparing" : ""
                  }`}
                  title={`${v.name} · ${shortDate(v.createdAt)}${
                    pillIsHead ? " · head" : ""
                  }${pillApproved ? " · approved" : ""}`}
                  onClick={() => setSelectedVersionId(v.versionId)}
                >
                  v{ordinal}
                  {pillIsHead && (
                    <span className="direction-row-head" title="Current head version">
                      {" "}
                      head
                    </span>
                  )}
                  {pillApproved && (
                    <span className="direction-row-approved" title="Approved (pinned) version">
                      {" "}
                      approved ✓
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
        <button
          type="button"
          className={`version-pills-compare-toggle btn btn-sm btn-ghost${
            compareMode ? " is-active" : ""
          }`}
          aria-pressed={compareMode}
          onClick={() => setCompareMode((m) => !m)}
        >
          Compare
        </button>
      </div>

      {compareMode && (
        <div className="version-pills-compare-area">
          {(showSwitcher ? versionsHeadFirst : [selected]).map((v) => {
            const compareSelected = compare.isSelected(direction.id, v.versionId);
            const compareDisabled = compare.disabledFor(direction.id, v.versionId);
            const ordinal =
              direction.versions.findIndex((x) => x.versionId === v.versionId) + 1;
            return (
              <label
                key={v.versionId}
                className={`direction-compare ${compareDisabled ? "is-disabled" : ""}`}
                title={
                  compareDisabled
                    ? "Two versions are already selected to compare"
                    : "Select to compare (up to two)"
                }
              >
                <input
                  type="checkbox"
                  checked={compareSelected}
                  disabled={compareDisabled}
                  onChange={() => compare.toggle(direction.id, v.versionId)}
                />
                v{ordinal}
              </label>
            );
          })}
        </div>
      )}

      <div
        className={`direction-card direction-card--rich direction-selected ${
          approved ? "approved" : ""
        } ${compare.isSelected(direction.id, selected.versionId) ? "is-comparing" : ""}`}
      >
        <DirectionCardBody
          directionId={direction.id}
          version={selected}
          isHead={isHead}
          approved={approved}
          reload={reload}
        />
      </div>
    </div>
  );
}

/**
 * The full, interactive body of a direction version — the hero image column and
 * the detail column side by side (master–detail). Shared verbatim by the inline
 * gallery and the compare overlay so the approve/regenerate/edit/restore behaviour
 * is never duplicated.
 *
 * Iterate controls (regenerate / edit-in-place / palette reroll / element
 * feedback) act on the HEAD, so they render only for the head version. A non-head
 * version is read-only with a "Restore this version" control that appends its
 * content as a new head. Approve is available for any version (it pins that one).
 */
export function DirectionCardBody({
  directionId,
  version,
  isHead,
  approved,
  reload,
}: {
  directionId: string;
  version: DashboardVersion;
  isHead: boolean;
  approved: boolean;
  reload: () => void;
}) {
  const { pushToast } = useToasts();
  const [editOpen, setEditOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenFeedback, setRegenFeedback] = useState("");
  const [imgVersion, setImgVersion] = useState(0);
  const [restoring, setRestoring] = useState(false);
  // The palette roles the user has locked on the board — threaded up so the
  // unified Regenerate holds them verbatim while the rest re-extract (SC-06/08).
  const [lockedRoles, setLockedRoles] = useState<PaletteRole[]>([]);
  // The generated image currently open for element-level feedback (crop /
  // eyedropper), or null when the overlay is closed.
  const [feedbackPath, setFeedbackPath] = useState<string | null>(null);

  const images = version.images;

  // On a successful regenerate: bump the per-card image version (so the same-src
  // <img> refetches) AND reload the dashboard (so the new head appears).
  const regen = useAction(() => {
    setImgVersion((v) => v + 1);
    reload();
  });

  // Approve pins THIS version — a tracked job on its own action so the compare
  // overlay's card is fully self-contained.
  const approve = useAction(reload);

  const hasImage = Boolean(images?.styleTile || images?.homepageMockup);

  /** Map locked roles to their CURRENT hexes off the version's tokens. */
  const colorsFor = (roles: PaletteRole[]): { role: PaletteRole; hex: string }[] => {
    const palette = version.tokens?.palette ?? [];
    return roles
      .map((role) => {
        const token = palette.find((t) => t.role === role);
        return token ? { role, hex: token.hex } : null;
      })
      .filter((x): x is { role: PaletteRole; hex: string } => x !== null);
  };

  /** Approve (pin) the rendered version via the pure builder. */
  const startApprove = (): void => {
    const req = approveRequest(directionId, version.versionId);
    approve.start(req.path, req.body);
  };

  /**
   * The ONE regenerate convergence point (SC-08): all four iterate gestures feed
   * it — lock (roles held verbatim), clip/keep + discard (already persisted to
   * direction memory via ElementFeedback, consumed server-side), and generic
   * feedback (this-pass art direction). Regenerate reads the direction's HEAD and
   * APPENDS a new version (never overwrites).
   */
  const startRegen = (): void => {
    const req = regenerateRequest(directionId, {
      feedback: regenFeedback.trim() || undefined,
      lockedRoles,
      lockedColors: colorsFor(lockedRoles),
    });
    regen.start(req.path, req.body);
  };

  /** The board's "Regenerate image with these locks" push — the same builder,
   * with the board's (possibly rerolled) locked colors. */
  const startRegenWithLocks = (
    roles: PaletteRole[],
    colors: { role: PaletteRole; hex: string }[],
  ): void => {
    const req = regenerateRequest(directionId, {
      lockedRoles: roles,
      lockedColors: colors,
    });
    regen.start(req.path, req.body);
  };

  /** Restore this (non-head) version: append its content as a new head via the
   * version-append route. Prior versions are untouched (append-only). */
  const restore = async (): Promise<void> => {
    if (restoring) return;
    setRestoring(true);
    try {
      const req = restoreVersionRequest(directionId, {
        name: version.name,
        summary: version.summary,
        positioning: version.positioning,
        character: version.character,
        styleTilePrompt: version.styleTilePrompt,
        homepageMockupPrompt: version.homepageMockupPrompt,
        usage: version.usage,
        copyExamples: version.copyExamples,
        ...(version.tokens ? { tokens: version.tokens } : {}),
      });
      await postJson(req.path, req.body);
      pushToast({ kind: "success", message: `Restored "${version.name}" as a new version.` });
      reload();
    } catch (e) {
      if (isVersionConflict(e)) {
        pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
        reload();
      } else {
        pushToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not restore this version.",
        });
      }
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="direction-row-body">
      {/* Images first — kept above the fold. Title/description live in the
          DirectionGallery header above the version pills. */}
      <DirectionHero
        version={version}
        imgVersion={imgVersion}
        isHead={isHead}
        directionId={directionId}
        feedbackPath={feedbackPath}
        onToggleFeedback={(p) => setFeedbackPath((c) => (c === p ? null : p))}
        onFeedbackDone={() => {
          setFeedbackPath(null);
          reload();
        }}
      />

      {/* The deterministic palette + type board, straight from the tokens
            (extraction-backed once a style tile exists; degrades to a note for
            legacy token-less versions). On the head its lock toggles thread up to
            the unified Regenerate and its "Regenerate image with these locks" button
            pushes the current (possibly rerolled) palette into a creative
            regenerate. On a non-head version it is read-only. */}
        <PaletteBoard
          directionId={directionId}
          tokens={version.tokens}
          reload={reload}
          extracted={Boolean(images?.tokensExtracted)}
          readOnly={!isHead}
          onLockedChange={isHead ? setLockedRoles : undefined}
          onRegenerateWithLocks={isHead ? startRegenWithLocks : undefined}
          regenBusy={regen.running}
        />

        {version.usage.rules.length > 0 && (
          <ul className="rules-list">
            {version.usage.rules.slice(0, 4).map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}

        <dl className="gallery-copy">
          <dt>Headline</dt>
          <dd>{version.copyExamples.headline}</dd>
          <dt>Subhead</dt>
          <dd>{version.copyExamples.subheadline}</dd>
          <dt>CTA</dt>
          <dd>{version.copyExamples.cta}</dd>
        </dl>

        <div className="gallery-card-actions">
          {!approved && (
            <button
              type="button"
              className="btn btn-primary"
              aria-label={`Approve ${version.name}`}
              disabled={approve.running}
              onClick={startApprove}
            >
              {approve.running ? "Approving…" : "Approve this version"}
            </button>
          )}
          {isHead && (
            <button
              type="button"
              className="btn btn-secondary"
              aria-expanded={regenOpen}
              disabled={regen.running}
              onClick={() => setRegenOpen((o) => !o)}
            >
              {regen.running
                ? "Regenerating…"
                : regenOpen
                  ? "Cancel"
                  : hasImage
                    ? "Regenerate visuals…"
                    : "Generate visuals…"}
            </button>
          )}
          {isHead && (
            <button
              type="button"
              className="btn btn-ghost"
              aria-expanded={editOpen}
              onClick={() => setEditOpen((o) => !o)}
            >
              {editOpen ? "Cancel edit" : "Edit…"}
            </button>
          )}
          {!isHead && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={restoring}
              title="Append this version's content as a new head, leaving history untouched"
              onClick={restore}
            >
              {restoring ? "Restoring…" : "Restore this version"}
            </button>
          )}
        </div>

        {isHead && regenOpen && (
          <div className="regen-form">
            <p className="field-hint">
              One loop: <strong>keep/discard</strong> a region above,{" "}
              <strong>lock</strong> swatches on the board, add a{" "}
              <strong>note</strong>, then <strong>Regenerate</strong>. It re-renders
              both graphics from the brief + your locked colors + kept crops +
              discard notes, then re-extracts the unlocked tokens from the new style
              tile and appends a new version. The direction&apos;s text and copy are
              left untouched.
            </p>
            {lockedRoles.length > 0 && (
              <p className="field-hint">
                Holding {lockedRoles.length} locked{" "}
                {lockedRoles.length === 1 ? "color" : "colors"} verbatim; the rest
                re-extract from the new tile.
              </p>
            )}
            <label className="refine-tweak">
              <span>Generic feedback / art direction (this pass only)</span>
              <input
                type="text"
                value={regenFeedback}
                placeholder="e.g. warmer palette, larger type, more editorial"
                onChange={(e) => setRegenFeedback(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="btn btn-primary"
              disabled={regen.running}
              onClick={startRegen}
            >
              {regen.running ? "Regenerating…" : "Regenerate"}
            </button>
          </div>
        )}

        {/* Rendered OUTSIDE the collapsible form so a regenerate triggered from the
            board's "Regenerate image with these locks" button shows progress even
            when the form is closed. Null-renders until a job is in flight. */}
        <JobProgress jobId={regen.jobId} onDone={regen.onDone} />
        <JobProgress jobId={approve.jobId} onDone={approve.onDone} />

        {isHead && editOpen && (
          <DirectionEditor
            directionId={directionId}
            version={version}
            reload={reload}
            onClose={() => setEditOpen(false)}
          />
        )}
    </div>
  );
}
