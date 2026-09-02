/**
 * A compact, `useJob`-driven status line for a WS-03 action job, plus the shared
 * {@link useAction} hook that every trigger (explore / approve / audit) uses to
 * kick off a job and refresh the dashboard on completion.
 *
 * `JobProgress` shows a spinner while `running`, a success summary while
 * `succeeded`, or a red error line while `failed`, and fires `onDone(job)` EXACTLY
 * once when the job first reaches a terminal state (guarded against double-firing
 * so the parent's `reload()` + toast run a single time).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { ContradictionWarning, Job } from "../types";
import { useJob, postJson } from "../hooks";
import { useToasts } from "./Toasts";

/** Read a string field off an unknown job result without throwing. */
function resultField(result: unknown, key: string): string | null {
  if (result && typeof result === "object" && key in result) {
    const v = (result as Record<string, unknown>)[key];
    return typeof v === "string" ? v : null;
  }
  return null;
}

/** Read an array field's length off an unknown job result without throwing. */
function resultArrayLen(result: unknown, key: string): number | null {
  if (result && typeof result === "object" && key in result) {
    const v = (result as Record<string, unknown>)[key];
    return Array.isArray(v) ? v.length : null;
  }
  return null;
}

/**
 * Defensively extract hard-rule warnings from an unknown job result.
 * Reads `result.contradictionReport.warnings`, filters for `code === "hard-rule-conflict"`.
 * Returns [] when the field is absent or malformed.
 */
function resultHardRuleWarnings(result: unknown): ContradictionWarning[] {
  if (!result || typeof result !== "object") return [];
  const r = result as Record<string, unknown>;
  if (!r.contradictionReport || typeof r.contradictionReport !== "object") return [];
  const report = r.contradictionReport as Record<string, unknown>;
  if (!Array.isArray(report.warnings)) return [];
  return (report.warnings as unknown[]).filter(
    (w): w is ContradictionWarning =>
      w !== null &&
      typeof w === "object" &&
      (w as Record<string, unknown>).code === "hard-rule-conflict",
  );
}

/** The result's `imageSkips` — image-generation failures/degradations a
 * "succeeded" job may still carry (explore/regenerate/asset results). Surfaced
 * so a keyed-but-failed image call never hides behind a green checkmark. */
function resultImageSkips(r: unknown): string[] {
  if (r === null || typeof r !== "object") return [];
  const v = (r as Record<string, unknown>).imageSkips;
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string")
    : [];
}

/** The first filled slot's id off a `SurfaceFillResult`-shaped job result
 * (`{ filled: [{ slotId }] }`) — defensive, never throws. */
function resultFirstFilledSlotId(r: unknown): string | null {
  if (!r || typeof r !== "object") return null;
  const filled = (r as Record<string, unknown>).filled;
  if (!Array.isArray(filled) || filled.length === 0) return null;
  const first = filled[0];
  if (!first || typeof first !== "object") return null;
  const slotId = (first as Record<string, unknown>).slotId;
  return typeof slotId === "string" ? slotId : null;
}

/** A short, human summary of a succeeded job's result (kind-specific). */
export function summarizeJob(job: Job): string {
  const r = job.result;
  switch (job.kind) {
    case "explore": {
      // Explore seeds sibling directions (each at v1) — report how many.
      const n = resultArrayLen(r, "directionIds");
      return n !== null
        ? `Generated ${n} direction${n === 1 ? "" : "s"}`
        : "Generated directions";
    }
    case "approve": {
      const name = resultField(r, "directionName");
      return name ? `Approved “${name}”` : "Direction approved";
    }
    case "audit": {
      const id = resultField(r, "auditId");
      return id ? `Audit complete — ${id}` : "Audit complete";
    }
    case "regenerate": {
      const id = resultField(r, "directionId");
      return id ? `Regenerated visuals — ${id}` : "Regenerated visuals";
    }
    case "asset": {
      // Extract and tweak share the ONE "asset" job kind (merged WS-05
      // spelling) and an identical result shape, so this summary is
      // deliberately verb-neutral — callers that know which gesture just ran
      // (the extract sub-panel) toast a more specific message themselves.
      const id = resultField(r, "assetId");
      return id ? `Asset updated — ${id}` : "Asset updated";
    }
    case "surface": {
      // Fill and scan share the ONE "surface" kind (the merged "asset"
      // precedent). `runSurfaceFill`'s real result carries `filled: [{ slotId
      // }]` (not a top-level slotId) — read the first filled slot; the
      // defensive fallback covers WS-09's scan results without this file
      // needing to change for that shape.
      const slotId = resultFirstFilledSlotId(r) ?? resultField(r, "slotId");
      return slotId ? `Filled slot — ${slotId}` : "Surface task complete";
    }
    default:
      return "Done";
  }
}

export function JobProgress({
  jobId,
  onDone,
}: {
  jobId: string | null;
  onDone?: (job: Job) => void;
}) {
  const { job } = useJob(jobId);
  // Guard against firing onDone more than once per job (poll updates re-run this
  // effect, and a stale job can linger across an id change).
  const firedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!job || job.status === "running") return;
    if (firedFor.current === job.id) return;
    firedFor.current = job.id;
    onDone?.(job);
  }, [job, onDone]);

  if (jobId === null || !job) return null;

  if (job.status === "running") {
    return (
      <div className="job-progress job-progress-running">
        <span className="job-spinner" aria-hidden="true" />
        <span>Working…</span>
      </div>
    );
  }

  if (job.status === "succeeded") {
    const hardWarnings = resultHardRuleWarnings(job.result);
    const imageSkips = resultImageSkips(job.result);
    return (
      <div className="job-progress job-progress-success">
        <span className="job-icon" aria-hidden="true">
          ✓
        </span>
        <span>{summarizeJob(job)}</span>
        {hardWarnings.length > 0 && (
          <div className="job-progress-warning">
            {hardWarnings.map((w, i) => (
              <div key={i} className="job-warning-line">
                Hard rule kept: {w.message}
              </div>
            ))}
          </div>
        )}
        {imageSkips.length > 0 && (
          <div className="job-progress-warning">
            {imageSkips.map((w, i) => (
              <div key={i} className="job-warning-line">
                Image: {w}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="job-progress job-progress-error" role="alert">
      <span className="job-icon" aria-hidden="true">
        ⚠
      </span>
      <span>{job.error ?? "Action failed."}</span>
    </div>
  );
}

/**
 * The shared "start an action → track its job → refresh on completion" flow,
 * factored out so explore / approve / audit don't each re-implement it.
 *
 * `start(url, body)` POSTs to a `POST /api/actions/*` endpoint, stores the
 * returned `jobId`, and marks the runner busy. Render
 * `<JobProgress jobId={jobId} onDone={onDone} />` to show live progress; on
 * completion `onDone` toasts (success summary or the captured error) and calls
 * `reload()`. `running` stays true only while a job is genuinely in flight, so a
 * trigger button can disable itself without hiding the finished status line.
 */
export function useAction(reload: () => void): {
  jobId: string | null;
  running: boolean;
  start: (url: string, body: unknown) => void;
  onDone: (job: Job) => void;
} {
  const { pushToast } = useToasts();
  const [jobId, setJobId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const start = useCallback(
    (url: string, body: unknown) => {
      setRunning(true);
      setJobId(null);
      void (async () => {
        try {
          const { jobId: id } = await postJson<{ jobId: string }>(url, body);
          setJobId(id);
        } catch (e) {
          setRunning(false);
          pushToast({
            kind: "error",
            message: e instanceof Error ? e.message : "Could not start action.",
          });
        }
      })();
    },
    [pushToast],
  );

  const onDone = useCallback(
    (job: Job) => {
      setRunning(false);
      if (job.status === "succeeded") {
        pushToast({ kind: "success", message: summarizeJob(job) });
        for (const w of resultHardRuleWarnings(job.result)) {
          pushToast({ kind: "warning", message: w.message });
        }
      } else {
        pushToast({ kind: "error", message: job.error ?? "Action failed." });
      }
      reload();
    },
    [pushToast, reload],
  );

  return { jobId, running, start, onDone };
}
