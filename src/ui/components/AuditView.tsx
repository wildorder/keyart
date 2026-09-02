/**
 * Latest audit markdown + screenshot, plus an "Audit a URL" trigger. Running an
 * audit screenshots a live URL and grades it against the approved direction —
 * so it needs an approved direction and a working Playwright/Chromium, and can
 * take 30–60s. The trigger uses the shared {@link useAction} flow; on completion
 * the dashboard reloads so the newest audit markdown + screenshot appear, and a
 * failed job surfaces its error rather than crashing.
 */
import React, { useState } from "react";
import type { DashboardAudit } from "../types";
import { Markdown } from "./Markdown";
import { JobProgress, useAction } from "./JobProgress";
import { auditRequest } from "../direction-actions.js";

export function AuditView({
  latestAudit,
  reload,
}: {
  latestAudit: DashboardAudit | null;
  reload: () => void;
}) {
  const audit = useAction(reload);
  const [url, setUrl] = useState("");
  const trimmed = url.trim();
  const canRun = trimmed.length > 0 && !audit.running;

  const run = () => {
    if (!canRun) return;
    const req = auditRequest(trimmed);
    audit.start(req.path, req.body);
  };

  return (
    <section id="audit" className="section">
      <h2>
        Latest Audit
        {latestAudit && <span className="section-subtitle"> — {latestAudit.id}</span>}
      </h2>

      {/* Audit a URL */}
      <div className="audit-form">
        <div className="audit-form-row">
          <input
            className="input"
            type="url"
            value={url}
            placeholder="https://localhost:3000"
            aria-label="URL to audit"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run();
            }}
          />
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canRun}
            onClick={run}
          >
            {audit.running ? "Auditing…" : "Run audit"}
          </button>
        </div>
        <p className="field-hint">
          Screenshots the URL and grades it against your approved direction —
          needs an approved direction plus Playwright/Chromium, and can take
          30–60s.
        </p>
        <JobProgress jobId={audit.jobId} onDone={audit.onDone} />
      </div>

      {latestAudit ? (
        <>
          {latestAudit.markdown ? (
            <Markdown className="audit-content">{latestAudit.markdown}</Markdown>
          ) : (
            <div className="empty-state">No audit markdown.</div>
          )}
          {latestAudit.screenshotPath && (
            <img
              className="audit-screenshot"
              src="/api/audit-screenshot"
              alt="Audit screenshot"
            />
          )}
        </>
      ) : (
        <div className="empty-state">
          No audits yet. Enter a live URL above to run your first audit.
        </div>
      )}
    </section>
  );
}
