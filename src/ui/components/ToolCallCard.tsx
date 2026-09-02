/**
 * Renders one chat tool-call event. A `pending_approval` renders the
 * approve/deny affordance — light confirm for `write`, a heavier force-style
 * confirm for `destructive` — keyed SOLELY off the event's own `mutates`
 * field (mirroring `GlobalRulesView`'s hard-rule force confirm). A dispatched
 * `tool_call`/`tool_result` renders as already-run (no gate); a `job` event
 * renders the existing `JobProgress` inline.
 */
import React from "react";
import type { ChatEvent } from "../types";
import { affordanceFor } from "../chat-affordances.js";
import { JobProgress } from "./JobProgress";

/** Explicit consequence copy for the heavier confirm, per destructive leaf. */
const DESTRUCTIVE_COPY: Record<string, string> = {
  approve: "This approves the direction and rebrands the consuming repo.",
  direction_memory_delete: "This retires the signal.",
  rule_remove: "This changes the brand everywhere.",
  rule_edit: "This changes the brand everywhere.",
};

function formatArguments(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

export function ToolCallCard({
  ev,
  onApprove,
  onDeny,
  submitting,
  reload,
}: {
  ev: ChatEvent;
  onApprove: () => void;
  onDeny: () => void;
  submitting: boolean;
  reload: () => void;
}): JSX.Element | null {
  if (ev.type === "pending_approval") {
    const heavy = affordanceFor(ev.mutates) === "heavy-confirm";
    const argsLine = formatArguments(ev.arguments);
    return (
      <div className={`tool-call-card tool-call-card--pending${heavy ? " tool-call-card--heavy" : ""}`}>
        <div className="tool-call-card__name">{ev.toolName}</div>
        {argsLine && <div className="tool-call-card__args">{argsLine}</div>}
        <div
          className={`lifecycle-confirm chat-confirm${
            heavy ? " lifecycle-confirm--force chat-confirm--force" : ""
          }`}
        >
          <p className="lifecycle-confirm__copy">Run `{ev.toolName}`?</p>
          {heavy && (
            <p className="lifecycle-confirm__copy lifecycle-confirm__copy--force">
              {DESTRUCTIVE_COPY[ev.toolName] ?? "This makes a destructive, hard-to-undo change."}
            </p>
          )}
          <div className="lifecycle-confirm__actions">
            <button type="button" className="btn btn-ghost btn-sm" disabled={submitting} onClick={onDeny}>
              Cancel
            </button>
            <button type="button" className="btn btn-danger btn-sm" disabled={submitting} onClick={onApprove}>
              {submitting ? "Working…" : "Approve"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (ev.type === "tool_call") {
    return (
      <div className="tool-call-card tool-call-card--done">
        <span className="tool-call-card__name">{ev.toolName}</span>
      </div>
    );
  }

  if (ev.type === "tool_result") {
    return (
      <div className={`tool-call-card tool-call-card--done${ev.isError ? " tool-call-card--error" : ""}`}>
        <span className="tool-call-card__name">{ev.toolName}</span>
        <span className="tool-call-card__text">{ev.text}</span>
      </div>
    );
  }

  if (ev.type === "job") {
    return (
      <div className="tool-call-card tool-call-card--job">
        <JobProgress jobId={ev.jobId} onDone={() => reload()} />
      </div>
    );
  }

  return null;
}
