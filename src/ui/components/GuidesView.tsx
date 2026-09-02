/**
 * Visual-style / brand guide tabs. Moved from App.tsx; guide text now renders
 * through {@link Markdown} instead of raw pre-formatted text.
 */
import React, { useState } from "react";
import type { DashboardData } from "../types";
import { Markdown } from "./Markdown";

export function GuidesView({ guides }: { guides: DashboardData["guides"] }) {
  const [guideTab, setGuideTab] = useState<"visual" | "brand">("visual");
  const hasGuides = guides.visualStyle || guides.brand;

  return (
    <section id="guides" className="section">
      <h2>Style Guides</h2>
      {hasGuides ? (
        <>
          <div className="tabs">
            <button
              className={`tab ${guideTab === "visual" ? "active" : ""}`}
              onClick={() => setGuideTab("visual")}
            >
              Visual Style
            </button>
            <button
              className={`tab ${guideTab === "brand" ? "active" : ""}`}
              onClick={() => setGuideTab("brand")}
            >
              Brand
            </button>
          </div>
          <div className="guide-content">
            {guideTab === "visual" ? (
              <Markdown>{guides.visualStyle ?? "No visual style guide."}</Markdown>
            ) : (
              <Markdown>{guides.brand ?? "No brand guide."}</Markdown>
            )}
          </div>
        </>
      ) : (
        <div className="empty-state">
          No guides generated. Approve a direction to generate guides.
        </div>
      )}
    </section>
  );
}
