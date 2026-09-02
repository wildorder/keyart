import React, { useEffect, useState } from "react";
import { useDashboard } from "./hooks";
import { ToastProvider } from "./components/Toasts";
import { LightboxProvider } from "./components/Lightbox";
import { AppShell } from "./components/AppShell";
import { DirectionWorkspace } from "./components/DirectionWorkspace";
import { NewDirectionModal } from "./components/NewDirectionModal";
import { GlobalRulesView } from "./components/GlobalRulesView";
import { SurfaceBoard } from "./components/SurfaceBoard";
import { ScanTriage } from "./components/ScanTriage";
import { GuidesView } from "./components/GuidesView";
import { AuditView } from "./components/AuditView";
import { SettingsView } from "./components/SettingsView";
import { resolveInitialDirection, writeSelectedDirection } from "./selection.js";
import type { StudioView } from "./types";

export function App() {
  const { data, error, loading, reload } = useDashboard();
  // ONE level of selection (WS-18): the focused direction id, persisted via
  // selection.ts so a reload restores the last-focused direction.
  const [selectedDirectionId, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<StudioView>("directions");
  const [newDirectionOpen, setNewDirectionOpen] = useState(false);

  // Archived directions are excluded by default — the picker never shows them
  // and the initial focus never lands on one.
  const visibleDirections = (data?.directions ?? []).filter(
    (d) => d.status !== "archived",
  );
  const visibleIds = visibleDirections.map((d) => d.id);

  // Land on a meaningful direction once data loads (or when the focused one
  // disappears after a reload): the persisted selection if it still exists,
  // else the latest direction.
  useEffect(() => {
    if (!data) return;
    if (selectedDirectionId !== null && visibleIds.includes(selectedDirectionId)) {
      return;
    }
    setSelected(resolveInitialDirection(visibleIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selectedDirectionId, visibleIds.join(",")]);

  if (error) {
    return <div className="loading">Error loading dashboard: {error}</div>;
  }
  if (loading || !data) {
    return <div className="loading">Loading…</div>;
  }

  const approved = data.approved;
  // The direction the global pointer currently references — surfaced in the
  // sidebar so the list shows which one owns the approved brand.
  const approvedDirectionId = data.global?.approvedPointer?.directionId ?? null;

  // Picking a direction from the sidebar persists it and navigates to the
  // Directions view, so the selection is always reflected in what's on screen.
  const setSelectedDirectionId = (id: string) => {
    setSelected(id);
    writeSelectedDirection(id);
    setView("directions");
  };

  const focusedDirection =
    visibleDirections.find((d) => d.id === selectedDirectionId) ?? null;

  return (
    <ToastProvider>
      <LightboxProvider>
        <AppShell
          projectName={data.projectName}
          directions={data.directions}
          selectedDirectionId={selectedDirectionId}
          setSelectedDirectionId={setSelectedDirectionId}
          approvedDirectionId={approvedDirectionId}
          onNewDirection={() => setNewDirectionOpen(true)}
          view={view}
          setView={setView}
        >
          {data.errors.length > 0 && (
            <div className="errors">
              {data.errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}

          {view === "directions" &&
            (focusedDirection ? (
              <section id="directions" className="section direction-detail-section">
                <DirectionWorkspace
                  direction={focusedDirection}
                  directions={visibleDirections}
                  approved={approved}
                  global={data.global}
                  reload={reload}
                />
              </section>
            ) : (
              <section id="directions" className="section">
                <div className="empty-state directions-empty">
                  <p>No directions yet. Describe what you want to explore.</p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setNewDirectionOpen(true)}
                  >
                    + New direction
                  </button>
                </div>
              </section>
            ))}

          {view === "global" &&
            (data.global ? (
              <GlobalRulesView
                global={data.global}
                approved={approved}
                directions={visibleDirections}
                reload={reload}
              />
            ) : (
              <section id="global" className="section global-section">
                <h2>Approved Brand</h2>
                <div className="empty-state">
                  No global brand yet. Approve a direction or add a rule to create it.
                </div>
              </section>
            ))}

          {view === "global" && (
            <SurfaceBoard surface={data.surface ?? null} reload={reload} />
          )}

          {view === "global" && (
            <ScanTriage surface={data.surface ?? null} reload={reload} />
          )}

          {view === "guides" && <GuidesView guides={data.guides} />}

          {view === "audit" && (
            <AuditView latestAudit={data.latestAudit} reload={reload} />
          )}

          {view === "settings" && <SettingsView />}

          <footer className="footer">Keyart Studio</footer>
        </AppShell>

        <NewDirectionModal
          directions={visibleDirections}
          sourceId={focusedDirection?.id ?? null}
          open={newDirectionOpen}
          onClose={() => setNewDirectionOpen(false)}
          reload={reload}
        />
      </LightboxProvider>
    </ToastProvider>
  );
}
