/** A direction's memory entries (feedback/learning/decision). Moved from App.tsx. */
import React, { useState } from "react";
import type { DashboardMemoryEntry } from "../types";
import { formatDate } from "../format";
import { AssetImage } from "./AssetImage";
import { selectMemoryEntries } from "./memory-select.js";
import { selectActiveMemoryEntries } from "./lifecycle-actions.js";
import { MemoryEntryActions } from "./MemoryEntryActions";

export { selectMemoryEntries } from "./memory-select.js";

function EntryRow({
  entry,
  variant,
  directionId,
  expectedVersion,
  reload,
}: {
  entry: DashboardMemoryEntry;
  variant: "full" | "rail";
  directionId?: string;
  expectedVersion?: number;
  reload?: () => void;
}) {
  return (
    <div
      key={entry.id}
      className={`memory-entry${entry.retiredAt ? " memory-entry-retired" : ""}`}
    >
      <span className={`memory-kind memory-kind-${entry.kind}`}>{entry.kind}</span>
      {entry.channel && (
        <span className="directive-tag">
          {entry.channel} · {entry.polarity ?? "prefer"}
        </span>
      )}
      {entry.retiredAt && (
        <span
          className="retired-badge"
          title={entry.supersededBy ? `superseded by ${entry.supersededBy}` : "retired"}
        >
          retired
        </span>
      )}
      {/* Rail variant omits thumbnail to keep the column compact. */}
      {entry.asset && variant !== "rail" && (
        <AssetImage
          className="memory-thumb"
          path={entry.asset}
          alt="discarded crop"
        />
      )}
      <div className="memory-body">{entry.body}</div>
      <div className="memory-meta">
        {variant === "rail"
          ? formatDate(entry.date)
          : `${entry.author}/${entry.source} · ${formatDate(entry.date)}`}
      </div>
      {directionId !== undefined && expectedVersion !== undefined && reload !== undefined && (
        <MemoryEntryActions
          entry={entry}
          directionId={directionId}
          expectedVersion={expectedVersion}
          reload={reload}
          variant={variant}
        />
      )}
    </div>
  );
}

export function MemoryPanel({
  memory,
  limit,
  variant = "full",
  focusedDirectionId,
  directionId,
  expectedVersion,
  reload,
  retiredMemory,
}: {
  memory: DashboardMemoryEntry[];
  limit?: number;
  variant?: "full" | "rail";
  focusedDirectionId?: string | null;
  /** The controls render only when directionId/expectedVersion/reload are all present. */
  directionId?: string;
  expectedVersion?: number;
  reload?: () => void;
  /** The direction's retired/superseded memory history (WS-05's `retiredMemory` bucket). */
  retiredMemory?: DashboardMemoryEntry[];
}) {
  const [showHistory, setShowHistory] = useState(false);

  // Memory is scope-by-location: all entries belong to the focused direction.
  // No filtering is needed - selectActiveMemoryEntries handles retired/superseded.
  const active = selectActiveMemoryEntries(memory);
  const displayed = selectMemoryEntries(active, variant, limit);

  const history = retiredMemory
    ? selectMemoryEntries(retiredMemory, variant)
    : [];

  return (
    <div className={variant === "rail" ? "memory-panel memory-panel--rail" : "memory-panel"}>
      {variant !== "rail" && <h3>Memory</h3>}
      {displayed.length > 0 ? (
        displayed.map((entry) => (
          <EntryRow
            key={entry.id}
            entry={entry}
            variant={variant}
            directionId={directionId}
            expectedVersion={expectedVersion}
            reload={reload}
          />
        ))
      ) : (
        <div className="empty-state">
          {variant === "rail"
            ? "No notes yet."
            : "No memory yet. Feedback, learnings, and decisions for this direction appear here."}
        </div>
      )}
      {variant === "full" && retiredMemory !== undefined && (
        <div className="memory-history">
          <button
            type="button"
            className="btn btn-ghost btn-sm memory-history-toggle"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((o) => !o)}
          >
            {showHistory ? "Hide history" : "Show history"}
          </button>
          {showHistory && (
            <div className="memory-history__list">
              {history.length > 0 ? (
                history.map((entry) => (
                  <EntryRow key={entry.id} entry={entry} variant={variant} />
                ))
              ) : (
                <div className="empty-state">No retired or superseded entries yet.</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
