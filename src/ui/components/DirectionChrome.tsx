/**
 * Sticky chrome header for the focused direction — the single-level twin of
 * the deleted two-level chrome. Renders the direction's name + StatusBadge, the
 * four secondary drawer buttons (Brief | Moodboard | Memory | Setup — state
 * owned HERE behind `setOpenDrawer`, the plan-bound setter name), and the
 * primary CTA: **Generate v1** on a draft (via `generateV1Request` — WS-15's
 * positional explore writes v1 into the draft; `regenerate` rejects a
 * zero-version draft) or **Regenerate** otherwise (via `regenerateRequest`).
 *
 * There is no back button: the sidebar direction list is the switcher, so the
 * workspace is never a dead end to escape from.
 */
import React, { useEffect, useState } from "react";
import type { ChromePanel, DashboardDirection } from "../types";
import { generateV1Request, regenerateRequest } from "../direction-actions.js";
import { NotesComposer } from "./NotesComposer";
import { MemoryPanel } from "./MemoryPanel";
import { selectDecisions } from "./memory-select.js";
import { ReconciliationPanel } from "./ReconciliationPanel";
import { BriefEditor } from "./BriefEditor";
import { MoodboardUploader } from "./MoodboardUploader";
import { AssetGallery } from "./AssetGallery";
import { StatusBadge } from "./StatusBadge";
import { JobProgress, useAction } from "./JobProgress";

export interface DirectionChromeProps {
  direction: DashboardDirection;
  reload: () => void;
}

const PANEL_LABELS: Record<Exclude<ChromePanel, null>, string> = {
  brief: "Brief",
  moodboard: "Moodboard",
  memory: "Memory",
  setup: "Setup",
};

const PANEL_ICONS: Record<Exclude<ChromePanel, null>, JSX.Element> = {
  brief: (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="2" y="1.5" width="10" height="11" rx="1" />
      <line x1="4.5" y1="5" x2="9.5" y2="5" />
      <line x1="4.5" y1="7.5" x2="9.5" y2="7.5" />
      <line x1="4.5" y1="10" x2="7.5" y2="10" />
    </svg>
  ),
  moodboard: (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <rect x="1" y="1" width="5" height="5" rx="1" />
      <rect x="8" y="1" width="5" height="5" rx="1" />
      <rect x="1" y="8" width="5" height="5" rx="1" />
      <rect x="8" y="8" width="5" height="5" rx="1" />
    </svg>
  ),
  memory: (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 1.5h8v11l-4-2.5-4 2.5V1.5z" />
    </svg>
  ),
  setup: (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <circle cx="7" cy="7" r="2" />
      <path d="M7 1.5V3M7 11v1.5M1.5 7H3M11 7h1.5M3.2 3.2l1.1 1.1M9.7 9.7l1.1 1.1M3.2 10.8l1.1-1.1M9.7 4.3l1.1-1.1" />
    </svg>
  ),
};

export function DirectionChrome({ direction, reload }: DirectionChromeProps) {
  // The open secondary drawer — `setOpenDrawer` is the plan-bound setter name.
  const [openDrawer, setOpenDrawer] = useState<ChromePanel>(null);

  const primary = useAction(reload);

  // Close the active drawer/panel on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openDrawer !== null) {
        setOpenDrawer(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openDrawer]);

  /** Draft: positional explore writes v1 into THIS draft — a single existing
   * id, no `count`; never `regenerateRequest` (WS-15 rejects a draft). */
  const startGenerateV1 = (): void => {
    const req = generateV1Request(direction.id);
    primary.start(req.path, req.body);
  };

  /** Non-draft: the quick Regenerate — the rich lock/feedback form lives in
   * the gallery card; this is the chrome's one-click iterate. */
  const startRegenerate = (): void => {
    const req = regenerateRequest(direction.id);
    primary.start(req.path, req.body);
  };

  const renderInlinePanel = () => {
    switch (openDrawer) {
      case "memory": {
        const decisions = selectDecisions(direction.memory);
        return (
          <div className="chrome-panel-body">
            {decisions.length > 0 && (
              <div className="memory-decisions">
                <span className="memory-decisions-title">Key decisions</span>
                <ul className="key-decision-list">
                  {decisions.map((d) => (
                    <li key={d.id} className="key-decision">
                      <span className="key-decision__check" aria-hidden="true">✓</span>
                      <span className="key-decision__body">{d.body}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <NotesComposer
              directionId={direction.id}
              memory={direction.memory}
              reload={reload}
              variant="full"
              showMemory={false}
            />
            <MemoryPanel
              memory={direction.memory}
              variant="full"
              directionId={direction.id}
              expectedVersion={direction.version}
              reload={reload}
              retiredMemory={direction.retiredMemory}
            />
          </div>
        );
      }
      case "setup":
        return (
          <div className="chrome-panel-body">
            <ReconciliationPanel
              directionId={direction.id}
              reload={reload}
              variant="setup"
            />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <>
      <header className="direction-chrome">
        <h2 className="chrome-direction-name">{direction.name}</h2>
        <StatusBadge status={direction.status} />

        <div className="chrome-actions">
          {(Object.keys(PANEL_LABELS) as Array<Exclude<ChromePanel, null>>).map(
            (panel) => (
              <button
                key={panel}
                type="button"
                className="chrome-action-btn"
                aria-pressed={openDrawer === panel}
                onClick={() => setOpenDrawer(openDrawer === panel ? null : panel)}
              >
                <span className="chrome-action-icon">{PANEL_ICONS[panel]}</span>
                <span className="chrome-action-label">{PANEL_LABELS[panel]}</span>
              </button>
            ),
          )}
          {direction.isDraft ? (
            <button
              type="button"
              className="btn btn-primary chrome-primary-cta"
              disabled={primary.running}
              onClick={startGenerateV1}
            >
              {primary.running ? "Generating…" : "Generate v1"}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary chrome-primary-cta"
              disabled={primary.running}
              onClick={startRegenerate}
            >
              {primary.running ? "Regenerating…" : "Regenerate"}
            </button>
          )}
        </div>
      </header>

      <JobProgress jobId={primary.jobId} onDone={primary.onDone} />

      {/* Brief drawer — fixed overlay at var(--drawer-z) = 300 */}
      {openDrawer === "brief" && (
        <>
          <div
            className="chrome-drawer-backdrop"
            onClick={() => setOpenDrawer(null)}
          />
          <div className="chrome-drawer" role="complementary" aria-label="Brief">
            <div className="chrome-drawer-header">
              <span className="chrome-drawer-title">Brief</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm chrome-drawer-close"
                aria-label="Close Brief panel"
                onClick={() => setOpenDrawer(null)}
              >
                ✕
              </button>
            </div>
            <div className="chrome-drawer-body">
              <BriefEditor direction={direction} reload={reload} variant="drawer" />
            </div>
          </div>
        </>
      )}

      {/* Moodboard drawer — fixed overlay at var(--drawer-z) = 300 */}
      {openDrawer === "moodboard" && (
        <>
          <div
            className="chrome-drawer-backdrop"
            onClick={() => setOpenDrawer(null)}
          />
          <div className="chrome-drawer" role="complementary" aria-label="Moodboard">
            <div className="chrome-drawer-header">
              <span className="chrome-drawer-title">Moodboard</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm chrome-drawer-close"
                aria-label="Close Moodboard panel"
                onClick={() => setOpenDrawer(null)}
              >
                ✕
              </button>
            </div>
            <div className="chrome-drawer-body">
              <MoodboardUploader directionId={direction.id} reload={reload} variant="drawer" />
              <AssetGallery
                assets={direction.assets}
                variant="drawer"
                directionId={direction.id}
                expectedVersion={direction.version}
                reload={reload}
              />
            </div>
          </div>
        </>
      )}

      {/* Memory and Setup — inline panel below the chrome header */}
      {(openDrawer === "memory" || openDrawer === "setup") && (
        <div className="chrome-panel">
          <div className="chrome-panel-close-row">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => setOpenDrawer(null)}
            >
              Close
            </button>
          </div>
          {renderInlinePanel()}
        </div>
      )}
    </>
  );
}
