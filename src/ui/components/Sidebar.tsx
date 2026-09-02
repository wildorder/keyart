/**
 * The persistent left nav — the ONLY direction picker in the studio (WS-18:
 * one level of selection). The direction list IS the workspace switcher;
 * each item carries the thumbnail + status + "updated" idiom (via the pure
 * `representativeImage` / `lastUpdated` helpers in `format.ts`). The direction
 * that owns the approved global brand gets a distinct treatment (★).
 *
 * Archived directions are EXCLUDED by default (client-side filter over
 * `status` — R-5: the reversible archive verb is the CLI/MCP's; the studio
 * only hides what it archived). "+ New direction" opens the NewDirectionModal.
 *
 * The project-wide destinations (Approved Brand, Style Guides, Audit,
 * Settings) are secondary — pinned to the bottom as muted utility nav.
 */
import React from "react";
import type { DashboardDirection, StudioView } from "../types";
import { formatDate, lastUpdated, representativeImage } from "../format";
import { AssetImage } from "./AssetImage";
import { StatusBadge } from "./StatusBadge";

const UTILITY_VIEWS: { view: StudioView; label: string }[] = [
  { view: "global", label: "Approved Brand" },
  { view: "guides", label: "Style Guides" },
  { view: "audit", label: "Audit" },
  { view: "settings", label: "Settings" },
];

export function Sidebar({
  directions,
  selectedDirectionId,
  setSelectedDirectionId,
  approvedDirectionId,
  onNewDirection,
  view,
  setView,
}: {
  directions: DashboardDirection[];
  selectedDirectionId: string | null;
  setSelectedDirectionId: (id: string) => void;
  approvedDirectionId: string | null;
  onNewDirection: () => void;
  view: StudioView;
  setView: (view: StudioView) => void;
}) {
  // Default exclusion: archived directions never render in the picker.
  const visible = directions.filter((d) => d.status !== "archived");

  return (
    <nav className="sidebar" aria-label="Primary">
      <div className="sidebar-group">
        <div className="sidebar-heading">Directions</div>

        {visible.length > 0 && (
          <ul className="direction-nav">
            {visible.map((d) => {
              const isActive = view === "directions" && d.id === selectedDirectionId;
              const isApproved = d.id === approvedDirectionId;
              const img = representativeImage(d);
              const updated = lastUpdated(d);

              const meta: string[] = [];
              if (d.isDraft) meta.push("draft");
              if (updated != null) meta.push(formatDate(updated));

              return (
                <li key={d.id}>
                  <button
                    className={
                      "direction-nav-item direction-nav-item--thumb" +
                      (isActive ? " active" : "") +
                      (isApproved ? " direction-nav-item--approved" : "")
                    }
                    onClick={() => setSelectedDirectionId(d.id)}
                  >
                    {img != null ? (
                      <AssetImage path={img} alt="" className="direction-nav-thumb" />
                    ) : (
                      <span
                        className="direction-nav-thumb direction-nav-thumb--placeholder"
                        aria-hidden="true"
                      >
                        {d.name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="direction-nav-body">
                      <span className="direction-nav-name-row">
                        <span className="direction-nav-name">{d.name}</span>
                        {d.status !== "active" && <StatusBadge status={d.status} />}
                        {isApproved && (
                          <span
                            className="direction-nav-approved"
                            title="Approved as the global brand"
                            aria-label="Approved as the global brand"
                          >
                            ★
                          </span>
                        )}
                      </span>
                      {meta.length > 0 && (
                        <span className="direction-nav-meta">{meta.join(" · ")}</span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="sidebar-new-direction">
          <button type="button" className="btn btn-primary" onClick={onNewDirection}>
            + New direction
          </button>
        </div>
      </div>

      <div className="sidebar-group sidebar-utility">
        <ul className="section-nav">
          {UTILITY_VIEWS.map((item) => (
            <li key={item.view}>
              <button
                type="button"
                className={`section-nav-item ${view === item.view ? "active" : ""}`}
                aria-current={view === item.view ? "page" : undefined}
                onClick={() => setView(item.view)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
