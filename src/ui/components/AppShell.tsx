/**
 * The app frame: a sticky {@link Sidebar} with the "Keyart Studio" wordmark and
 * the project name, a scrollable `<main>` content region, and the right-hand
 * rail slot. Exactly one destination view renders as `children` in `<main>`
 * (the shell is view-switched, not a single scroll).
 *
 * The three columns each scroll independently and every one is viewport-tall, so
 * the rail spans the full height beside the workspace rather than scrolling away
 * with it. The rail's CONTENT is portalled in from the direction workspace via
 * {@link RailHostProvider}; with nothing portalled the slot collapses to zero
 * width and the shell reads as a plain two-column layout.
 */
import React from "react";
import type { DashboardDirection, StudioView } from "../types";
import { Sidebar } from "./Sidebar";
import { RailHostProvider, RailSlot } from "./RailHost";

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
    <RailHostProvider>
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
        <RailSlot />
      </div>
    </RailHostProvider>
  );
}
