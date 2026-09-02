/**
 * The studio scan trigger + review checklist (WS-09, surface-manifest) — the
 * human half of the app-surface scan: trigger a tracked scan job, then review
 * the proposal as an accept/reject checklist before merging accepted
 * candidates through the SAME validated write path `SurfaceBoard`'s routes
 * use. Mirrors the `ReconciliationPanel` review-checklist idiom, except its
 * data arrives on the dashboard payload (props), not a private fetch — so
 * "refetch" is simply `reload()`.
 *
 * Scoping note (WS-08's byte-identical-when-absent invariant is BOARD-scoped
 * only): unlike `SurfaceBoard` (which renders nothing without a manifest),
 * this component's trigger renders even with no manifest and no proposal —
 * the deliberate first-scan bootstrap (U1/SC-11) so the studio can start the
 * very first scan. Only the checklist is conditional on a proposal existing.
 */
import React, { useEffect, useState } from "react";
import type { DashboardSurface, ScanCandidate } from "../types";
import {
  proposalIsRefined,
  refinedFieldBadges,
  candidateDescription,
  partitionAccepted,
  skipRows,
  formatSkipRow,
  skipHeadline,
  migrationRows,
  overlayWarning,
} from "../scan-triage-helpers.js";
import { postJson, isVersionConflict, VERSION_CONFLICT_MESSAGE } from "../hooks";
import { scanTriggerRequest, scanApplyRequest } from "../direction-actions.js";
import { useToasts } from "./Toasts";
import { JobProgress, useAction } from "./JobProgress";
import { AssetImage } from "./AssetImage";

function ScanTrigger({ reload }: { reload: () => void }): JSX.Element {
  const scan = useAction(reload);
  const [url, setUrl] = useState("");
  const trimmed = url.trim();
  const canScan = trimmed.length > 0 && !scan.running;

  const run = (): void => {
    if (!canScan) return;
    const req = scanTriggerRequest([trimmed]);
    scan.start(req.path, req.body);
  };

  return (
    <div className="scan-triage__form">
      <div className="audit-form-row">
        <input
          className="input"
          type="url"
          value={url}
          placeholder="http://localhost:3000"
          aria-label="URL to scan"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") run();
          }}
        />
        <button type="button" className="btn btn-primary" disabled={!canScan} onClick={run}>
          {scan.running ? "Scanning…" : "Scan"}
        </button>
      </div>
      {/* The hook's OWN onDone — no component-owned completion handler. */}
      <JobProgress jobId={scan.jobId} onDone={scan.onDone} />
    </div>
  );
}

function FieldBadge({ refined }: { refined: boolean }): JSX.Element {
  return (
    <span
      className={refined ? "scan-triage__badge--refined" : "scan-triage__badge--floor"}
      title={refined ? "named by the vision model" : "as observed in the DOM"}
    >
      {refined ? "refined" : "floor"}
    </span>
  );
}

function CandidateRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: ScanCandidate;
  checked: boolean;
  onToggle: (signature: string) => void;
}): JSX.Element {
  const badges = refinedFieldBadges(candidate);
  const detail = candidate.hints.ariaLabel ?? candidate.hints.alt;

  return (
    <div className="scan-triage__row">
      <input
        type="checkbox"
        aria-label={`Accept ${candidate.proposedId}`}
        checked={checked}
        onChange={() => onToggle(candidate.signature)}
      />
      <AssetImage
        className="scan-triage__thumb"
        path={candidate.cropFile}
        alt={candidate.proposedId}
      />
      <div className="scan-triage__meta">
        <div>
          <code className="scan-triage__id">{candidate.proposedId}</code>{" "}
          <FieldBadge refined={badges.id} />
        </div>
        <div>
          <span>{candidate.kind}</span> <FieldBadge refined={badges.kind} />
        </div>
        <div className="scan-triage__note">
          {candidateDescription(candidate)} <FieldBadge refined={badges.description} />
        </div>
        {candidate.context?.note && (
          <div className="scan-triage__note">{candidate.context.note}</div>
        )}
        {detail && <div className="scan-triage__hint">{detail}</div>}
      </div>
    </div>
  );
}

export function ScanTriage({
  surface,
  reload,
}: {
  surface: DashboardSurface | null;
  reload: () => void;
}): JSX.Element {
  const { pushToast } = useToasts();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  const proposal = surface?.proposal;
  const candidates = proposal?.candidates ?? [];

  // A fresh proposal defaults every candidate to checked — U1's gesture is
  // "uncheck junk", never "check the good ones". Keyed on `createdAt` (a new
  // scan always carries a new timestamp).
  useEffect(() => {
    setChecked(new Set(proposal?.candidates.map((c) => c.signature) ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal?.createdAt]);

  const toggle = (signature: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(signature)) next.delete(signature);
      else next.add(signature);
      return next;
    });
  };

  const applyAccepted = async (): Promise<void> => {
    if (!proposal || submitting) return;
    setSubmitting(true);
    try {
      const { acceptedIds } = partitionAccepted(candidates, checked);
      const req = scanApplyRequest({ acceptedIds, expectedVersion: surface?.version });
      const result = await postJson<{ appliedCount: number; rejectedCount: number }>(
        req.path,
        req.body,
      );
      pushToast({
        kind: "success",
        message: `Applied ${result.appliedCount} slot(s); rejected ${result.rejectedCount}.`,
      });
      reload();
    } catch (e) {
      if (isVersionConflict(e)) {
        pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
        reload();
      } else {
        pushToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not apply the proposal.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const acceptedCount = candidates.filter((c) => checked.has(c.signature)).length;

  // WS-07 (surface-scan-quality) — the three additive display blocks. All
  // driven by proposal fields, so with `surface === null` (no manifest and no
  // proposal) the rendered output is byte-identical to the pre-WS-07 studio.
  const overlay = overlayWarning(proposal?.blockedByOverlay);
  const skipRowsList = skipRows(proposal?.skipped);
  const skipHeadlineText = skipHeadline(proposal?.skipped);
  const migrationRowsList = migrationRows(proposal?.migrations);

  return (
    <section className="scan-triage">
      <h2>Surface scan</h2>

      {surface === null && (
        <div className="empty-state">
          No surface manifest yet — scan a page to propose one, or author slots
          via an agent.
        </div>
      )}

      {overlay && (
        <div className="scan-triage__overlay" role="alert">
          <span className="job-icon" aria-hidden="true">
            ⚠
          </span>
          <span>{overlay.message}</span>
        </div>
      )}

      <ScanTrigger reload={reload} />

      {skipRowsList.length > 0 && (
        <div className="scan-triage__skips">
          <p>{skipHeadlineText}</p>
          {skipRowsList.map((row) => (
            <div key={row.reason} className="scan-triage__skip-row">
              <div>{formatSkipRow(row)}</div>
              {row.examples.length > 0 && (
                <div className="scan-triage__hint">
                  e.g. {row.examples.join(", ")}
                  {row.moreExamples > 0 && ` …and ${row.moreExamples} more`}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {migrationRowsList.length > 0 && (
        <div className="scan-triage__migrations">
          <p>Migration findings — replace these literals, don&apos;t add slots</p>
          {migrationRowsList.map((row) => (
            <div key={`${row.kind}:${row.value}`} className="scan-triage__migration-row">
              <div>{row.line}</div>
              {row.examples.length > 0 && (
                <div className="scan-triage__hint">
                  seen on {row.examples.join(", ")}
                  {row.moreExamples > 0 && ` …and ${row.moreExamples} more`}
                </div>
              )}
            </div>
          ))}
          <p className="scan-triage__advisory">
            Advisory only — findings are never applied to brand/surface.yaml and
            never become slots.
          </p>
        </div>
      )}

      {proposal && (
        <div className="scan-triage__checklist">
          {!proposalIsRefined(proposal) && (
            <p className="scan-triage__hint">
              Floor scan — ids are anonymous placeholders. Add an
              OPENAI_API_KEY and re-run the scan to get named candidates.
            </p>
          )}

          {candidates.length === 0 ? (
            <div className="empty-state">
              No candidates to review — run a scan.
              {proposal.rejectedSignatures.length > 0 && (
                <> {proposal.rejectedSignatures.length} candidate(s) previously rejected.</>
              )}
            </div>
          ) : (
            <>
              <div className="scan-triage__rows">
                {candidates.map((c) => (
                  <CandidateRow
                    key={c.signature}
                    candidate={c}
                    checked={checked.has(c.signature)}
                    onToggle={toggle}
                  />
                ))}
              </div>
              <button
                type="button"
                className="btn btn-primary scan-triage__apply"
                disabled={submitting}
                onClick={applyAccepted}
              >
                {submitting ? "Applying…" : `Apply accepted (${acceptedCount})`}
              </button>
            </>
          )}
        </div>
      )}
    </section>
  );
}
