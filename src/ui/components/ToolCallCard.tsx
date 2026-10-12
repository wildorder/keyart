/**
 * Renders one chat tool-call event. A `pending_approval` renders the
 * approve/deny affordance — light confirm for `write`, a heavier force-style
 * confirm for `destructive` — keyed SOLELY off the event's own `mutates`
 * field (mirroring `GlobalRulesView`'s hard-rule force confirm). A dispatched
 * `tool_call`/`tool_result` renders as already-run (no gate); a `job` event
 * renders the existing `JobProgress` inline.
 */
import React, { type JSX } from "react";
import type { ChatCardEvent } from "../types";
import { affordanceFor } from "../chat-affordances.js";
import { JobProgress } from "./JobProgress";
import type { ChatAction } from "../chat-stream";

const ACTION_TITLES: Record<string, string> = {
  asset_extract: "Extract asset", asset_generate: "Create asset", asset_revise: "Revise asset",
  asset_regenerate: "Revise asset", direction_revise: "Revise style tile", regenerate: "Revise style tile",
  direction_feedback: "Record feedback", direction_memory_add: "Remember feedback",
  board_create: "Create Board", board_revise: "Revise Board", board_update: "Update Boards",
  approve: "Approve foundation", direction_delete_version: "Delete foundation version",
};

function actionTitle(name: string): string {
  return ACTION_TITLES[name] ?? name.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

/** Explicit consequence copy for the heavier confirm, per destructive leaf. */
const DESTRUCTIVE_COPY: Record<string, string> = {
  approve: "This approves the direction and rebrands the consuming repo.",
  direction_memory_delete: "This retires the signal.",
  rule_remove: "This changes the brand everywhere.",
  rule_edit: "This changes the brand everywhere.",
};

function formatArguments(args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([key]) => key !== "captured");
  if (entries.length === 0) return "";
  return entries
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join(", ");
}

export function ToolCallCard({
  ev,
  action,
  onApprove,
  onDeny,
  submitting,
  reload,
}: {
  ev: ChatCardEvent;
  action?: ChatAction;
  onApprove: () => void;
  onDeny: () => void;
  submitting: boolean;
  reload: () => void;
}): JSX.Element | null {
  const title = actionTitle(action?.toolName ?? ("toolName" in ev ? ev.toolName : undefined) ?? "Action");
  if (ev.type === "approval_decision") {
    return (
      <div className="tool-call-card tool-call-card--done">
        <span className="tool-call-card__name">{title}</span>
        <span className="tool-call-card__text">{ev.approved ? "Approved" : "Cancelled"}</span>
      </div>
    );
  }
  if (ev.type === "pending_approval") {
    const heavy = affordanceFor(ev.mutates) === "heavy-confirm";
    const argsLine = formatArguments(ev.arguments);
    const foundation = ev.arguments.version ?? ev.arguments.targetFoundation;
    const source = ev.arguments.revision;
    return (
      <div className={`tool-call-card tool-call-card--pending${heavy ? " tool-call-card--heavy" : ""}`}>
        <div className="tool-call-card__name">{title}</div>
        {typeof foundation === "string" && <p><strong>Target foundation: {foundation}</strong></p>}
        {typeof source === "string" && <p>Source revision: {source === "none" ? "No previous render" : source}</p>}
        {ev.arguments.assetsExcluded === true && <p>Assets and approval are excluded from this update.</p>}
        {argsLine && <div className="tool-call-card__args">{argsLine}</div>}
        {typeof ev.arguments.captured === "string" && <details><summary>Captured Board inputs</summary><pre>{ev.arguments.captured}</pre></details>}
        <div
          className={`lifecycle-confirm chat-confirm${
            heavy ? " lifecycle-confirm--force chat-confirm--force" : ""
          }`}
        >
          <p className="lifecycle-confirm__copy">{title}?</p>
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
        <span className="tool-call-card__name">{title}</span>
      </div>
    );
  }

  if (ev.type === "tool_result") {
    return (
      <div className={`tool-call-card tool-call-card--done${ev.isError ? " tool-call-card--error" : ""}`}>
        <span className="tool-call-card__name">{title}</span>
        <span className="tool-call-card__text">{ev.text}</span>
      </div>
    );
  }

  if (ev.type === "job") {
    return (
      <div className="tool-call-card tool-call-card--job">
        <span className="tool-call-card__name">{title}</span>
        {action?.approved && <span className="tool-call-card__text">Approved</span>}
        <JobProgress jobId={ev.jobId} onDone={() => reload()} />
      </div>
    );
  }

  return null;
}
