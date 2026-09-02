/**
 * The per-signal Edit / Promote / Delete menu mounted on each active memory-
 * entry row (`MemoryPanel` full + rail variants). A thin front-end over the
 * WS-05 lifecycle routes — validation (up-ladder-only, version guard) is owned
 * by the core; this component sends the affordance-gated controls and surfaces
 * the resulting `CommandError` / `VersionConflictError`. Mirrors
 * `ReconciliationPanel`'s per-row submit-with-toast pattern.
 */
import React, { useState } from "react";
import type {
  DashboardMemoryEntry,
  DirectiveChannel,
  DirectivePolarity,
  RuleSeverity,
} from "../types";
import {
  patchJson,
  postJson,
  deleteJson,
  isVersionConflict,
  VERSION_CONFLICT_MESSAGE,
} from "../hooks";
import { useToasts } from "./Toasts";
import { lifecycleActionsFor } from "./lifecycle-actions.js";
import {
  memoryDeleteRequest,
  memoryEditRequest,
  memoryPromoteRequest,
} from "../direction-actions.js";

const SCOPE_LABELS: Record<"global", string> = {
  global: "the global brand",
};

export function MemoryEntryActions({
  entry,
  directionId,
  expectedVersion,
  reload,
  variant = "full",
}: {
  entry: DashboardMemoryEntry;
  directionId: string;
  expectedVersion: number;
  reload: () => void;
  variant?: "full" | "rail";
}) {
  const { pushToast } = useToasts();
  const actions = lifecycleActionsFor(entry);

  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [editBody, setEditBody] = useState(entry.body);
  const [editChannel, setEditChannel] = useState<DirectiveChannel>(
    entry.channel ?? "visual",
  );
  const [editPolarity, setEditPolarity] = useState<DirectivePolarity>(
    entry.polarity ?? "avoid",
  );

  // Promote is up-ladder to global ONLY — scope is location now.
  const [promoteSeverity, setPromoteSeverity] = useState<RuleSeverity>("guideline");

  if (!actions.canEdit && !actions.canDelete && actions.promoteScopes.length === 0) {
    return null;
  }

  const closeAll = () => {
    setMenuOpen(false);
    setEditing(false);
    setPromoting(false);
    setConfirmingDelete(false);
  };

  const handleError = (e: unknown, fallback: string) => {
    if (isVersionConflict(e)) {
      pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
      reload();
    } else {
      pushToast({ kind: "error", message: e instanceof Error ? e.message : fallback });
    }
  };

  const saveEdit = async () => {
    if (submitting) return;
    const trimmed = editBody.trim();
    if (trimmed.length === 0) return;
    setSubmitting(true);
    try {
      const req = memoryEditRequest(directionId, entry.id, {
        body: trimmed,
        channel: editChannel,
        polarity: editPolarity,
        expectedVersion,
      });
      await patchJson(req.path, req.body);
      pushToast({ kind: "success", message: "Saved." });
      closeAll();
      reload();
    } catch (e) {
      handleError(e, "Could not save the edit.");
    } finally {
      setSubmitting(false);
    }
  };

  const confirmPromote = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const req = memoryPromoteRequest(directionId, entry.id, {
        severity: promoteSeverity,
        expectedVersion,
      });
      await postJson(req.path, req.body);
      pushToast({ kind: "success", message: `Promoted to ${SCOPE_LABELS.global}.` });
      closeAll();
      reload();
    } catch (e) {
      handleError(e, "Could not promote this entry.");
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const req = memoryDeleteRequest(directionId, entry.id, expectedVersion);
      await deleteJson(req.path, req.body);
      pushToast({ kind: "success", message: "Retired." });
      closeAll();
      reload();
    } catch (e) {
      handleError(e, "Could not retire this entry.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={`entry-actions${variant === "rail" ? " entry-actions--rail" : ""}`}>
      <button
        type="button"
        className="btn btn-ghost btn-sm entry-actions__toggle"
        aria-label="Entry actions"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
      >
        {variant === "rail" ? "···" : "Actions"}
      </button>

      {menuOpen && (
        <div className="entry-actions__menu">
          {actions.canEdit && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setEditing((o) => !o);
                setPromoting(false);
                setConfirmingDelete(false);
              }}
            >
              Edit
            </button>
          )}
          {actions.promoteScopes.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setPromoting((o) => !o);
                setEditing(false);
                setConfirmingDelete(false);
              }}
            >
              Promote
            </button>
          )}
          {actions.canDelete && (
            <button
              type="button"
              className="btn btn-ghost btn-sm entry-actions__delete-trigger"
              onClick={() => {
                setConfirmingDelete((o) => !o);
                setEditing(false);
                setPromoting(false);
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}

      {editing && (
        <div className="entry-edit">
          <textarea
            className="textarea entry-edit__body"
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
          />
          <div className="entry-edit__row">
            <select
              className="select"
              aria-label="Channel"
              value={editChannel}
              onChange={(e) => setEditChannel(e.target.value as DirectiveChannel)}
            >
              <option value="visual">visual</option>
              <option value="copy">copy</option>
              <option value="both">both</option>
            </select>
            <select
              className="select"
              aria-label="Polarity"
              value={editPolarity}
              onChange={(e) => setEditPolarity(e.target.value as DirectivePolarity)}
            >
              <option value="avoid">avoid</option>
              <option value="prefer">prefer</option>
            </select>
          </div>
          <div className="entry-edit__actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={submitting}
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={submitting || editBody.trim().length === 0}
              onClick={saveEdit}
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {promoting && (
        <div className="promote-picker">
          <p className="promote-picker__copy">
            Promote straight to {SCOPE_LABELS.global} — the only rung.
          </p>
          <select
            className="select"
            aria-label="Promote severity"
            value={promoteSeverity}
            onChange={(e) => setPromoteSeverity(e.target.value as RuleSeverity)}
          >
            <option value="guideline">guideline</option>
            <option value="hard">hard</option>
          </select>
          <div className="promote-picker__actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={submitting}
              onClick={() => setPromoting(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={submitting}
              onClick={confirmPromote}
            >
              {submitting ? "Promoting…" : "Promote"}
            </button>
          </div>
        </div>
      )}

      {confirmingDelete && (
        <div className="lifecycle-confirm">
          <p className="lifecycle-confirm__copy">
            Retire this — it will stop influencing every future generation. History is kept.
          </p>
          <div className="lifecycle-confirm__actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={submitting}
              onClick={() => setConfirmingDelete(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={submitting}
              onClick={confirmDelete}
            >
              {submitting ? "Retiring…" : "Retire"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
