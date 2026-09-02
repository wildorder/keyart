/**
 * The sole direction-creation entry point (WS-18): Describe | Fork | Author.
 *
 *  - **Describe** → `divergentExploreRequest` (`POST /api/actions/explore`
 *    with seed text and NO target id — the divergent mode mints N drafts +
 *    v1 each; never the single-draft create path).
 *  - **Fork** → `forkRequest` (`POST /api/directions/:sourceId/fork` — WS-04's
 *    keyless copy of the source's brief + moodboard into N drafts).
 *  - **Author** → the embedded authored form ({@link CreateDirection}) on
 *    `authoredCreateRequest` (`POST /api/directions/:sourceId/create`).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardDirection, Job } from "../types";
import { divergentExploreRequest, forkRequest } from "../direction-actions.js";
import { postJson, ApiError } from "../hooks.js";
import { JobProgress, useAction } from "./JobProgress";
import { CreateDirection } from "./CreateDirection";
import { useToasts } from "./Toasts";

type Mode = "describe" | "fork" | "author";

const TAB_LABELS: { mode: Mode; label: string }[] = [
  { mode: "describe", label: "Describe" },
  { mode: "fork", label: "Fork" },
  { mode: "author", label: "Author" },
];

export interface NewDirectionModalProps {
  /** Every visible direction — fork/author source choices. */
  directions: DashboardDirection[];
  /** The focused direction (default fork/author source), or null. */
  sourceId: string | null;
  open: boolean;
  onClose: () => void;
  reload: () => void;
}

export function NewDirectionModal({
  directions,
  sourceId,
  open,
  onClose,
  reload,
}: NewDirectionModalProps) {
  const { pushToast } = useToasts();
  const [mode, setMode] = useState<Mode>("describe");
  const [describe, setDescribe] = useState("");
  const [count, setCount] = useState(3);
  const [forkSource, setForkSource] = useState(sourceId ?? "");
  const [forkName, setForkName] = useState("");
  const [withMemory, setWithMemory] = useState(false);
  const [forking, setForking] = useState(false);

  const explore = useAction(reload);

  const panelRef = useRef<HTMLDivElement>(null);
  const describeRef = useRef<HTMLTextAreaElement>(null);

  const hasSources = directions.length > 0;

  // Reset state when modal closes; follow the focused direction while closed.
  useEffect(() => {
    if (!open) {
      setDescribe("");
      setMode("describe");
      setForkName("");
      setWithMemory(false);
    }
  }, [open]);

  useEffect(() => {
    setForkSource(sourceId ?? "");
  }, [sourceId, open]);

  // Focus the panel (or describe textarea) when modal opens.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (mode === "describe" && describeRef.current) {
        describeRef.current.focus();
      } else {
        panelRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [open, mode]);

  // Esc key closes the modal.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const onExploreDone = useCallback(
    (job: Job) => {
      explore.onDone(job);
      if (job.status === "succeeded") onClose();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [explore.onDone, onClose],
  );

  /** Describe tab: seed text, NO direction id — the divergent explore. */
  const startDescribe = (): void => {
    const seed = describe.trim();
    if (seed.length === 0) return;
    const req = divergentExploreRequest(seed, count);
    explore.start(req.path, req.body);
  };

  /** Fork tab: copy the source's brief + moodboard into N drafts (keyless). */
  const startFork = async (): Promise<void> => {
    if (forking || forkSource === "") return;
    setForking(true);
    try {
      const req = forkRequest(forkSource, {
        name: forkName.trim() || undefined,
        withMemory,
      });
      await postJson(req.path, req.body);
      pushToast({ kind: "success", message: `Forked "${forkSource}".` });
      reload();
      onClose();
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof ApiError ? e.message : String(e),
      });
    } finally {
      setForking(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="new-direction-modal-backdrop"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="new-direction-modal"
        role="dialog"
        aria-modal="true"
        aria-label="New direction"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="new-direction-modal-head">
          <h2 className="new-direction-modal-title">New direction</h2>
          <button
            type="button"
            className="new-direction-modal-close"
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        {/* Tab strip */}
        <div className="new-direction-modal-tabs">
          {TAB_LABELS.map(({ mode: m, label }) => (
            <button
              key={m}
              type="button"
              className={`new-direction-modal-tab${mode === m ? " is-active" : ""}`}
              disabled={m !== "describe" && !hasSources}
              onClick={() => setMode(m)}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab body */}
        <div className="new-direction-modal-body">
          {mode === "describe" && (
            <>
              <label className="explore-guidance">
                <span className="explore-guidance-label">
                  Describe what to explore
                </span>
                <textarea
                  ref={describeRef}
                  className="textarea explore-guidance-input"
                  value={describe}
                  placeholder="e.g. a warm, editorial identity for a slow-coffee subscription"
                  rows={3}
                  onChange={(e) => setDescribe(e.target.value)}
                />
                <span className="field-hint new-direction-modal-hint">
                  Mints new sibling directions from this brief seed — steers only
                  this generation.
                </span>
              </label>

              <label className="explore-guidance new-direction-modal-count">
                <span className="explore-guidance-label">How many</span>
                <input
                  type="number"
                  min={1}
                  max={6}
                  value={count}
                  onChange={(e) => setCount(Math.max(1, Number(e.target.value) || 1))}
                />
              </label>

              <div className="action-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={explore.running || describe.trim().length === 0}
                  onClick={startDescribe}
                >
                  {explore.running ? "Exploring…" : "Explore"}
                </button>
              </div>

              <JobProgress jobId={explore.jobId} onDone={onExploreDone} />
            </>
          )}

          {mode === "fork" && (
            <>
              <p className="new-direction-modal-hint">
                Copy an existing direction&apos;s brief and moodboard into a new
                draft — keyless, nothing is generated yet.
              </p>

              <div className="field">
                <label className="label" htmlFor="fork-source">
                  Fork from
                </label>
                <select
                  id="fork-source"
                  className="select"
                  value={forkSource}
                  onChange={(e) => setForkSource(e.target.value)}
                >
                  {directions.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ({d.id})
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label className="label" htmlFor="fork-name">
                  Name (optional)
                </label>
                <input
                  id="fork-name"
                  className="input"
                  value={forkName}
                  placeholder="e.g. Warm Editorial II"
                  onChange={(e) => setForkName(e.target.value)}
                />
              </div>

              <label className="radio-option new-direction-modal-with-memory">
                <input
                  type="checkbox"
                  checked={withMemory}
                  onChange={(e) => setWithMemory(e.target.checked)}
                />
                Also copy the source&apos;s memory
              </label>

              <div className="action-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={forking || forkSource === ""}
                  onClick={startFork}
                >
                  {forking ? "Forking…" : "Fork"}
                </button>
              </div>
            </>
          )}

          {mode === "author" && (
            <CreateDirection
              directions={directions}
              sourceId={forkSource || sourceId || directions[0]?.id || ""}
              reload={reload}
              alwaysOpen={true}
              onSuccess={onClose}
            />
          )}
        </div>
      </div>
    </div>
  );
}
