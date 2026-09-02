/**
 * The app frame: a sticky {@link Sidebar} + a scrollable `<main>` content
 * region, with a header carrying the "Keyart Studio" wordmark and the
 * project name. Exactly one destination view renders as `children` in `<main>`
 * (the shell is view-switched, not a single scroll).
 */
import React from "react";
import type { DashboardDirection, StudioView } from "../types";
import { Sidebar } from "./Sidebar";

export function AppShell({
  projectName,
  directions,
  selectedDirectionId,
  setSelectedDirectionId,
  approvedDirectionId,
  onNewDirection,
  view,
  setView,
  children,
}: {
  projectName: string;
  directions: DashboardDirection[];
  selectedDirectionId: string | null;
  setSelectedDirectionId: (id: string) => void;
  approvedDirectionId: string | null;
  onNewDirection: () => void;
  view: StudioView;
  setView: (view: StudioView) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="app-shell">
      <aside className="app-aside">
        <div className="brand-mark">
          <span className="brand-wordmark">Keyart Studio</span>
          <span className="brand-project">{projectName}</span>
        </div>
        <Sidebar
          directions={directions}
          selectedDirectionId={selectedDirectionId}
          setSelectedDirectionId={setSelectedDirectionId}
          approvedDirectionId={approvedDirectionId}
          onNewDirection={onNewDirection}
          view={view}
          setView={setView}
        />
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}
