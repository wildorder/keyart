/**
 * Append a feedback / learning / decision note to the focused direction's
 * memory via `notesComposerRequest` (`POST /api/directions/:id/feedback` —
 * scope is location, no scope field), then reload so it appears in the memory
 * panel rendered below. A 409 surfaces the standard reload-and-retry message.
 */
import React, { useEffect, useState } from "react";
import type { DashboardMemoryEntry, DirectiveChannel, DirectivePolarity, MemoryKind } from "../types";
import { postJson, isVersionConflict, VERSION_CONFLICT_MESSAGE } from "../hooks";
import { notesComposerRequest } from "../direction-actions.js";
import { useToasts } from "./Toasts";
import { MemoryPanel } from "./MemoryPanel";

const KINDS: MemoryKind[] = ["feedback", "learning", "decision"];

export function NotesComposer({
  directionId,
  memory,
  reload,
  variant = "full",
  showMemory = true,
}: {
  directionId: string;
  memory: DashboardMemoryEntry[];
  reload: () => void;
  variant?: "full" | "rail";
  showMemory?: boolean;
}) {
  const { pushToast } = useToasts();
  const [kind, setKind] = useState<MemoryKind>("feedback");
  const [body, setBody] = useState("");
  const [channel, setChannel] = useState<DirectiveChannel>("visual");
  const [polarity, setPolarity] = useState<DirectivePolarity>("avoid");
  const [submitting, setSubmitting] = useState(false);

  const trimmed = body.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const req = notesComposerRequest(directionId, {
        body: trimmed,
        kind,
        ...(kind === "decision" ? { channel, polarity } : {}),
      });
      await postJson(req.path, req.body);
      pushToast({ kind: "success", message: `Added ${kind} note.` });
      setBody("");
      reload();
    } catch (e) {
      if (isVersionConflict(e)) {
        pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
        reload();
      } else {
        pushToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not add note.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={variant === "rail" ? "composer composer--rail" : "composer"}>
      {variant !== "rail" && <h3>Add a note</h3>}
      <div className="composer-row">
        <div className="field composer-kind">
          <label className="label" htmlFor="note-kind">
            Kind
          </label>
          <select
            id="note-kind"
            className="select"
            value={kind}
            onChange={(e) => setKind(e.target.value as MemoryKind)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
        {kind === "decision" && (
          <>
            <div className="field">
              <label className="label" htmlFor="note-channel">
                Applies to
              </label>
              <select
                id="note-channel"
                className="select"
                value={channel}
                onChange={(e) => setChannel(e.target.value as DirectiveChannel)}
              >
                <option value="visual">visual</option>
                <option value="copy">copy</option>
                <option value="both">both</option>
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor="note-polarity">
                Direction
              </label>
              <select
                id="note-polarity"
                className="select"
                value={polarity}
                onChange={(e) => setPolarity(e.target.value as DirectivePolarity)}
              >
                <option value="avoid">avoid</option>
                <option value="prefer">prefer</option>
              </select>
            </div>
          </>
        )}
      </div>
      <div className="field">
        <label className="label" htmlFor="note-body">
          Note
        </label>
        <textarea
          id="note-body"
          className="textarea"
          value={body}
          placeholder="What did you learn, decide, or want changed?"
          onChange={(e) => setBody(e.target.value)}
        />
      </div>
      <div className="composer-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSubmit}
          onClick={submit}
        >
          {submitting ? "Adding…" : "Add note"}
        </button>
      </div>

      {showMemory && <MemoryPanel memory={memory} />}
    </div>
  );
}
