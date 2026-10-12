import React, { useEffect, useState, type JSX } from "react";
import type { DashboardVersion, DashboardBoard, VisualSource, VisualFocus } from "../types";
import { AssetImage } from "./AssetImage";
import { ElementFeedback } from "./ElementFeedback";
import { StageImage } from "./StageImage";
import { BoardControls } from "./BoardControls";
import { STAGE_MODES, isCaptureMode, stageHint, stageModeLabel, type StageMode } from "../stage-capture.js";
import { boardStageItems, foundationLabel } from "../board-view.js";
import { usePendingCapture } from "../pending-capture.js";

interface DirectionHeroProps {
  version: DashboardVersion; imgVersion: number; isHead: boolean; directionId: string;
  onFeedbackDone: () => void; headerStart?: React.ReactNode;
  boards?: DashboardBoard[]; versions?: DashboardVersion[]; latestVersionId?: string;
  onSourceChange?: (source: VisualFocus | null) => void;
}

/** One stage, with Foundation and arbitrary named Boards sharing the existing left thumbnails. */
export function DirectionHero({ version, imgVersion, directionId, onFeedbackDone, headerStart,
  boards = [], versions = [version], latestVersionId = version.versionId, onSourceChange }: DirectionHeroProps): JSX.Element {
  const [mode, setMode] = useState<StageMode>("select");
  const [selectedKey, setSelectedKey] = useState("foundation");
  const [historyRevision, setHistoryRevision] = useState<string | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [extractOpen, setExtractOpen] = useState(false);
  const { pending, setPending, clear: clearCapture } = usePendingCapture();
  const items = boardStageItems(directionId, version, boards, showRetired);
  const item = items.find((s) => s.key === selectedKey) ?? items[0];
  const revision = item.board?.revisions.find((r) => r.id === historyRevision) ?? item.revision;
  const source: VisualSource | null = item.board && revision
    ? { kind: "board", directionId, versionId: revision.foundation.versionId, boardId: item.board.id, revisionId: revision.id }
    : item.source;
  const imagePath = item.board ? revision?.imagePath : item.path;
  const identity = source ? `${source.kind}:${source.versionId}:${source.kind === "board" ? source.revisionId : ""}` : `${selectedKey}:absent`;
  useEffect(() => { setHistoryRevision(null); clearCapture(); setExtractOpen(false); }, [directionId, version.versionId]);
  useEffect(() => { clearCapture(); setExtractOpen(false); onSourceChange?.(source ?? (item.board
    ? { kind: "board", directionId, versionId: version.versionId, boardId: item.board.id } : null)); }, [identity, version.versionId]);
  const gallery = imagePath ? [{ path: imagePath, alt: item.label, caption: item.label, version: imgVersion }] : [];
  const capture = pending?.capture;
  const changeMode = (next: StageMode): void => { clearCapture(); setExtractOpen(false); setMode(next); };
  return <div className="direction-hero">
    <div className="stage">
      <div className="stage-head">
        {headerStart ?? <b className="stage-head__title">Foundation and Boards</b>}
        {imagePath && source && <div className="stage-tools" role="group" aria-label="Stage mode">
          {STAGE_MODES.map((m) => <button key={m} type="button" className={`stage-tool${mode === m ? " is-active" : ""}`} aria-pressed={mode === m} onClick={() => changeMode(m)}>{stageModeLabel(m)}</button>)}
        </div>}
      </div>
      <div className="stage-body">
        <div className="stage-thumbs" role="tablist" aria-label="Staged image" aria-orientation="vertical">
          {items.map((entry) => <button key={entry.key} type="button" role="tab" aria-selected={entry.key === item.key}
            className={`stage-thumb${entry.key === item.key ? " is-active" : ""}`} title={entry.label}
            onClick={() => { clearCapture(); setSelectedKey(entry.key); setHistoryRevision(null); }}>
            {entry.path ? <AssetImage className="stage-thumb__img" path={entry.path} alt={entry.label} version={imgVersion} /> : <span className="stage-thumb__img" aria-label="No render">—</span>}
            <span className="stage-thumb__label">{entry.label}{entry.board?.retiredAt ? " (retired)" : ""}</span>
          </button>)}
        </div>
        <div className="board-stage-content">
          {imagePath && source ? <StageImage key={identity} path={imagePath} alt={`${version.name} — ${item.label}`} mode={mode} imgVersion={imgVersion}
            gallery={gallery} galleryIndex={0} onCapture={(next) => setPending({ capture: next, source })} />
            : <div className="gallery-no-preview" role="note"><span className="gallery-no-preview-title">{revision?.status === "failed" ? "Board render failed" : revision ? "Board render pending" : item.board ? "No Board render for this foundation" : "Foundation render pending"}</span>
              <span className="gallery-no-preview-hint">{revision?.error ?? (item.board ? "Choose a historical revision or explicitly update this Board to the selected foundation." : "Generate a foundation tile to enable image-conditioned Boards and assets. Keyless runs retain prompts.")}</span></div>}
          <details className="stage-details" key={item.key}>
            <summary>{item.board ? "Details & history" : "Details"}</summary>
            <p className="field-hint"><strong>{item.label}</strong> · Foundation {foundationLabel(versions, source?.versionId ?? version.versionId)}</p>
            {revision?.conditioning === "legacy-unverified" && <p className="field-hint" role="note">Migrated artwork: foundation conditioning was not verified. Its version relationship is historical provenance.</p>}
            {item.board && <label>Board history<select aria-label="Board revision history" value={revision?.id ?? ""} onChange={(e) => { clearCapture(); setHistoryRevision(e.target.value); }}>
              {!revision && <option value="">No revision for selected foundation</option>}
              {[...item.board.revisions].reverse().map((r) => <option key={r.id} value={r.id}>{r.id} · {foundationLabel(versions, r.foundation.versionId)} · {r.status}</option>)}
            </select></label>}
          </details>
        </div>
      </div>
      {imagePath && (capture || isCaptureMode(mode)) && <p className="stage-hint">{capture ? "Captured — resolve it in the chat composer or open the full options below." : stageHint(mode)}</p>}
    </div>
    {boards.some((b) => b.retiredAt) && <label className="field-hint"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Show retired Board history</label>}
    <BoardControls directionId={directionId} versions={versions} boards={boards} selectedVersionId={version.versionId} latestVersionId={latestVersionId}
      board={item.board} revisionId={revision?.id ?? null} reload={onFeedbackDone} />
    {isCaptureMode(mode) && capture && source && <>
      <button type="button" className="btn btn-sm btn-ghost stage-more-options" aria-expanded={extractOpen} onClick={() => setExtractOpen((o) => !o)}>{extractOpen ? "Hide options" : "More options (keep as, extract as asset)…"}</button>
      {extractOpen && <ElementFeedback key={capture.kind === "crop" ? capture.previewUrl : capture.hex}
        source={source} capture={capture}
        onClear={() => { clearCapture(); setExtractOpen(false); }} onDone={() => { clearCapture(); setExtractOpen(false); onFeedbackDone(); }} />}
    </>}
  </div>;
}
