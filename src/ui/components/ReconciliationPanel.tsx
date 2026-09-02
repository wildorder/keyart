/**
 * Per-direction reconciliation panel. Lists detected contradictions via
 * `reconciliationReadRequest` (`GET /api/directions/:id/reconciliation` —
 * fetched by `fetchReconcileList`, called straight from the mount effect) and
 * resolves each via `reconciliationResolveRequest`
 * (`POST .../reconciliation/resolve` — keep / retire / promote).
 *
 * Versioned + 409-safe: every resolve sends `expectedMemoryVersion` (and
 * `expectedGlobalVersion` for promote); a stale write loses with
 * VERSION_CONFLICT_MESSAGE + a refetch. Hard-rule sides are never auto-
 * overridden — only "keep" is offered for live-vs-hardrule contradictions.
 * Retire is non-destructive (the entry stays, marked retiredAt). Local-only:
 * the serve local-only guard blocks any non-local request (403).
 */
import React, { useCallback, useEffect, useState } from "react";
import type {
  Contradiction,
  ReconcileAction,
  ReconciliationListResponse,
  RuleSeverity,
} from "../types";
import { isVersionConflict, VERSION_CONFLICT_MESSAGE } from "../hooks";
import {
  reconciliationReadRequest,
  reconciliationResolveRequest,
} from "../direction-actions.js";
import { useToasts } from "./Toasts";

async function fetchReconcileList(directionId: string): Promise<ReconciliationListResponse> {
  const req = reconciliationReadRequest(directionId);
  const res = await fetch(req.path);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) msg = body.error;
    } catch {
      // ignore parse failure
    }
    throw new Error(msg);
  }
  return (await res.json()) as ReconciliationListResponse;
}

/** The resolve body shape sent to `POST .../reconciliation/resolve`. */
interface ResolvePayload {
  contradiction: Contradiction;
  action: ReconcileAction;
  winner: "subject" | "conflictsWith";
  severity?: RuleSeverity;
  expectedMemoryVersion: number;
  expectedGlobalVersion: number;
}

/** Carry a prepared resolve request descriptor's bytes to the server. */
async function postResolve(req: { method: string; path: string; body?: unknown }): Promise<unknown> {
  const res = await fetch(req.path, {
    method: req.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req.body),
  });
  if (!res.ok) {
    let body: { error?: string; code?: string } = {};
    try {
      body = (await res.json()) as { error?: string; code?: string };
    } catch {
      // ignore parse failure
    }
    const err = new Error(body.error ?? `HTTP ${res.status}`);
    (err as unknown as { code?: string }).code = body.code;
    throw err;
  }
  return res.json();
}

function isVersionConflictErr(e: unknown): boolean {
  if (e instanceof Error) {
    return (e as unknown as { code?: string }).code === "version_conflict";
  }
  return isVersionConflict(e);
}

/** True when the contradiction involves a hard rule (the hard side cannot be overridden). */
function isHardRuleContradiction(c: Contradiction): boolean {
  return (
    c.kind === "live-vs-hardrule" ||
    c.subject.source === "hard-rule" ||
    c.conflictsWith.source === "hard-rule"
  );
}

function ContradictionRow({
  contradiction,
  directionId,
  memoryVersion,
  globalVersion,
  onResolved,
}: {
  contradiction: Contradiction;
  directionId: string;
  memoryVersion: number;
  globalVersion: number;
  onResolved: () => void;
}) {
  const { pushToast } = useToasts();
  const [submitting, setSubmitting] = useState(false);
  const [promoteSeverity, setPromoteSeverity] = useState<RuleSeverity>("guideline");

  const isHard = isHardRuleContradiction(contradiction);

  const submitResolve = useCallback(
    async (req: { method: string; path: string; body?: unknown }, action: ReconcileAction) => {
      if (submitting) return;
      setSubmitting(true);
      try {
        await postResolve(req);
        pushToast({ kind: "success", message: `Resolved: ${action}.` });
        onResolved();
      } catch (e) {
        if (isVersionConflictErr(e)) {
          pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
          onResolved(); // refetch — parent handles the reload
        } else {
          pushToast({
            kind: "error",
            message: e instanceof Error ? e.message : "Could not resolve contradiction.",
          });
        }
      } finally {
        setSubmitting(false);
      }
    },
    [pushToast, onResolved, submitting],
  );

  const resolveBody = (
    action: ReconcileAction,
    winner: "subject" | "conflictsWith" = "subject",
  ): ResolvePayload => ({
    contradiction,
    action,
    winner,
    severity: action === "promote" ? promoteSeverity : undefined,
    expectedMemoryVersion: memoryVersion,
    expectedGlobalVersion: globalVersion,
  });

  // Named per-action handlers — each BUILDS its resolve request via the pure
  // builder (the control-bound wiring shape) and hands the bytes down.
  const resolveKeep = (): void => {
    const req = reconciliationResolveRequest(
      directionId,
      resolveBody("keep") as unknown as Record<string, unknown>,
    );
    void submitResolve(req, "keep");
  };
  const resolveRetire = (): void => {
    const req = reconciliationResolveRequest(
      directionId,
      resolveBody("retire", "conflictsWith") as unknown as Record<string, unknown>,
    );
    void submitResolve(req, "retire");
  };
  const resolvePromote = (): void => {
    const req = reconciliationResolveRequest(
      directionId,
      resolveBody("promote") as unknown as Record<string, unknown>,
    );
    void submitResolve(req, "promote");
  };

  return (
    <div className={`reconcile-row reconcile-kind-${contradiction.kind}`}>
      <div className="reconcile-header">
        <span className={`badge badge-reconcile-${contradiction.severity}`}>
          {contradiction.kind}
        </span>
        {isHard && (
          <span className="reconcile-hard-note">
            Hard rule wins — cannot be auto-overridden.
          </span>
        )}
      </div>
      <div className="reconcile-sides">
        <div className="reconcile-subject">
          <span className="reconcile-label">Subject</span>
          <span className="reconcile-text">{contradiction.subject.text}</span>
          <span className="reconcile-source">({contradiction.subject.source})</span>
        </div>
        <div className="reconcile-vs">vs.</div>
        <div className="reconcile-conflicts-with">
          <span className="reconcile-label">Conflicts with</span>
          <span className="reconcile-text">{contradiction.conflictsWith.text}</span>
          <span className="reconcile-source">({contradiction.conflictsWith.source})</span>
        </div>
      </div>
      <div className="reconcile-explanation">{contradiction.explanation}</div>
      <div className="reconcile-actions">
        {/* keep is always available */}
        <button
          type="button"
          className="btn btn-sm"
          disabled={submitting}
          onClick={resolveKeep}
        >
          Keep both
        </button>
        {/* retire + promote are only offered for non-hard-rule sides */}
        {!isHard && (
          <>
            <button
              type="button"
              className="btn btn-sm btn-warning"
              disabled={submitting}
              onClick={resolveRetire}
            >
              Retire stale
            </button>
            <span className="reconcile-promote-group">
              <select
                className="select select-sm"
                aria-label="Promote severity"
                value={promoteSeverity}
                onChange={(e) => setPromoteSeverity(e.target.value as RuleSeverity)}
                disabled={submitting}
              >
                <option value="guideline">guideline</option>
                <option value="hard">hard</option>
              </select>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={submitting}
                onClick={resolvePromote}
              >
                Promote to global
              </button>
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export function ReconciliationPanel({
  directionId,
  reload,
  variant,
}: {
  directionId: string;
  reload: () => void;
  variant?: "setup";
}) {
  const [list, setList] = useState<ReconciliationListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // The automatic (effect-origin) read: the effect calls `fetchReconcileList`
  // directly — the one-hop shape the effect-wiring analyzer proves.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchReconcileList(directionId)
      .then((data) => {
        if (!cancelled) setList(data);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not load contradictions.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [directionId, nonce]);

  const handleResolved = useCallback(() => {
    setNonce((n) => n + 1);
    reload();
  }, [reload]);

  return (
    <div className={`reconciliation-panel${variant === "setup" ? " reconciliation-panel--setup" : ""}`}>
      <h3>Contradictions</h3>
      {loading && <div className="reconcile-loading">Checking for contradictions…</div>}
      {error && <div className="reconcile-error">{error}</div>}
      {!loading && !error && list && (
        list.report.items.length === 0 ? (
          <div className="empty-state">No contradictions detected.</div>
        ) : (
          <div className="reconcile-list">
            {list.report.items.map((c) => (
              <ContradictionRow
                key={c.id}
                contradiction={c}
                directionId={directionId}
                memoryVersion={list.memoryVersion}
                globalVersion={list.globalVersion}
                onResolved={handleResolved}
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}
