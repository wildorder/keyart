/**
 * The studio's gap/request board — the human review-and-curation surface over
 * the surface-manifest demand record (WS-08, surface-manifest). Renders
 * `null` when `surface === null` (no manifest — byte-identical to the studio
 * before this WS). Otherwise every ACTIVE slot with its kind + status chip,
 * gaps first; `origin: "request"` rows show "requested N×"; `kind: "other"`
 * rows flag as taxonomy demand; each asset gap gets a Generate control via the
 * preserved `useAction` idiom (no completion handler of this component's own —
 * only the hook's own `onDone` is passed through, same as `AssetShelf`); and
 * per-row curation (edit criticality/context, non-destructive retire) plus a
 * single-slot add form, both through the validated versioned `/api/surface`
 * routes with teaching rejections surfaced verbatim.
 */
import React, { useState } from "react";
import type { DashboardSurface, DashboardSurfaceSlot } from "../types";
import {
  orderSurfaceSlots,
  requestLine,
  statusChipClass,
  statusLabel,
  isGenerateTarget,
  pendingHint,
  parseListInput,
  parseSizesInput,
  scannedSlotCount,
} from "../surface-board-helpers.js";
import {
  postJson,
  patchJson,
  deleteJson,
  isVersionConflict,
  VERSION_CONFLICT_MESSAGE,
} from "../hooks";
import {
  surfaceFillRequest,
  surfaceAddRequest,
  surfaceEditRequest,
  surfaceRetireRequest,
  surfaceBulkRetireRequest,
} from "../direction-actions.js";
import { useToasts } from "./Toasts";
import { JobProgress, useAction } from "./JobProgress";
import { AssetImage } from "./AssetImage";

const SLOT_KINDS = ["icon", "illustration", "color-role", "type-role", "other"] as const;
const SITS_ON_OPTIONS = [
  "background",
  "surface",
  "text",
  "muted",
  "primary",
  "secondary",
] as const;

/** Builds the optional `SlotContext` object from the shared edit/add fields —
 * omitted entirely when every field is blank (never sent as `{}`). */
function buildContext(fields: {
  sitsOn: string;
  tone: string;
  note: string;
  sizes: string;
  usedIn: string;
}): Record<string, unknown> | undefined {
  const context: Record<string, unknown> = {
    ...(fields.sitsOn ? { sitsOn: fields.sitsOn } : {}),
    ...(fields.tone.trim() ? { tone: fields.tone.trim() } : {}),
    ...(fields.note.trim() ? { note: fields.note.trim() } : {}),
  };
  const sizes = parseSizesInput(fields.sizes);
  if (sizes) context.sizes = sizes;
  const usedIn = parseListInput(fields.usedIn);
  if (usedIn) context.usedIn = usedIn;
  return Object.keys(context).length > 0 ? context : undefined;
}

export function SurfaceBoard({
  surface,
  reload,
}: {
  surface: DashboardSurface | null;
  reload: () => void;
}): JSX.Element | null {
  if (surface === null) return null;

  const ordered = orderSurfaceSlots(surface.slots);
  const scannedCount = scannedSlotCount(surface.slots);

  return (
    <section className="surface-board">
      <h2>App surface</h2>
      <p className="section-note">
        The app-surface demand record — every icon, illustration, color, and type
        slot the approved brand needs, and what&apos;s bound, derived, or still a
        gap.
      </p>

      {ordered.length === 0 ? (
        <div className="empty-state">No active surface slots yet.</div>
      ) : (
        <div className="surface-board__rows">
          {ordered.map((slot) => (
            <SurfaceSlotRow
              key={slot.id}
              slot={slot}
              version={surface.version}
              reload={reload}
            />
          ))}
        </div>
      )}

      {scannedCount > 0 && (
        <BulkRetireScanned count={scannedCount} version={surface.version} reload={reload} />
      )}

      <AddSlotForm version={surface.version} reload={reload} />
    </section>
  );
}

/** The confirm-gated "Retire scanned slots" control (WS-07,
 * surface-scan-quality) — the studio's bulk bad-scan-recovery gesture, the
 * HTTP twin of `surface retire --origin scan`. A SYNCHRONOUS form write (no
 * `useAction`, no `JobProgress`, no job kind), mirroring `SurfaceSlotRow`'s
 * destructive-confirm idiom verbatim. `origin=scan` is hard-coded — no origin
 * picker (that would offer a destructive affordance for `authored`, which
 * nothing asks for). */
function BulkRetireScanned({
  count,
  version,
  reload,
}: {
  count: number;
  version: number;
  reload: () => void;
}): JSX.Element {
  const { pushToast } = useToasts();
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleError = (e: unknown, fallback: string): void => {
    if (isVersionConflict(e)) {
      pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
      reload();
    } else {
      pushToast({ kind: "error", message: e instanceof Error ? e.message : fallback });
    }
  };

  const confirmRetire = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const req = surfaceBulkRetireRequest({ expectedVersion: version });
      const result = await deleteJson<{ retiredCount: number }>(req.path, req.body);
      pushToast({
        kind: "success",
        message:
          result.retiredCount > 0
            ? `Retired ${result.retiredCount} scanned slot(s).`
            : "No active scanned slots to retire.",
      });
      setConfirming(false);
      reload();
    } catch (e) {
      handleError(e, "Could not retire the scanned slots.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="surface-board__bulk">
      {!confirming ? (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirming(true)}>
          Retire scanned slots ({count})
        </button>
      ) : (
        <div className="lifecycle-confirm surface-board__bulk-actions">
          <p className="lifecycle-confirm__copy">
            Retire all {count} scan-authored slot(s) — they leave the board, bind, and
            gap report. Authored and requested slots are untouched. History is kept.
          </p>
          <div className="lifecycle-confirm__actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={submitting}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={submitting}
              onClick={confirmRetire}
            >
              {submitting ? "Retiring…" : "Retire"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function SurfaceSlotRow({
  slot,
  version,
  reload,
}: {
  slot: DashboardSurfaceSlot;
  version: number;
  reload: () => void;
}): JSX.Element {
  const { pushToast } = useToasts();
  const fillAction = useAction(reload);

  const [editing, setEditing] = useState(false);
  const [confirmingRetire, setConfirmingRetire] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [criticality, setCriticality] = useState<DashboardSurfaceSlot["criticality"]>(
    slot.criticality,
  );
  const [sitsOn, setSitsOn] = useState("");
  const [tone, setTone] = useState("");
  const [note, setNote] = useState("");
  const [sizes, setSizes] = useState("");
  const [usedIn, setUsedIn] = useState("");

  const handleError = (e: unknown, fallback: string): void => {
    if (isVersionConflict(e)) {
      pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
      reload();
    } else {
      pushToast({ kind: "error", message: e instanceof Error ? e.message : fallback });
    }
  };

  const saveEdit = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const req = surfaceEditRequest(slot.id, {
        criticality,
        context: buildContext({ sitsOn, tone, note, sizes, usedIn }),
        expectedVersion: version,
      });
      await patchJson(req.path, req.body);
      pushToast({ kind: "success", message: "Saved slot." });
      setEditing(false);
      reload();
    } catch (e) {
      handleError(e, "Could not save this slot.");
    } finally {
      setSubmitting(false);
    }
  };

  const confirmRetire = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const req = surfaceRetireRequest(slot.id, { expectedVersion: version });
      await deleteJson(req.path, req.body);
      pushToast({ kind: "success", message: "Retired slot." });
      setConfirmingRetire(false);
      reload();
    } catch (e) {
      handleError(e, "Could not retire this slot.");
    } finally {
      setSubmitting(false);
    }
  };

  const showGenerate = isGenerateTarget(slot);
  const hint = pendingHint(slot);
  const request = requestLine(slot);

  return (
    <div className="surface-board__row">
      <div className="surface-board__row-main">
        <code className="surface-board__id">{slot.id}</code>
        <span className="surface-board__kind">{slot.kind}</span>
        <span className={statusChipClass(slot.status)}>{statusLabel(slot.status)}</span>
        <span className="badge">{slot.criticality}</span>
        {slot.taxonomyDemand && (
          <span className="surface-board__taxonomy">taxonomy demand</span>
        )}
      </div>

      {slot.file ? (
        <AssetImage
          className="surface-board__value-swatch"
          path={slot.file}
          alt={slot.id}
          version={slot.assetId}
        />
      ) : slot.value ? (
        slot.kind === "color-role" ? (
          <span
            className="surface-board__value-swatch"
            style={{ background: slot.value }}
            title={slot.value}
          />
        ) : (
          <span className="surface-board__value-text">{slot.value}</span>
        )
      ) : null}

      {request && <p className="surface-board__request">{request}</p>}
      {hint && <p className="surface-board__hint">{hint}</p>}

      <div className="surface-board__row-actions">
        {showGenerate && (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={fillAction.running}
              onClick={() => {
                const req = surfaceFillRequest(slot.id);
                fillAction.start(req.path, req.body);
              }}
            >
              {fillAction.running ? "Generating…" : "Generate"}
            </button>
            <JobProgress jobId={fillAction.jobId} onDone={fillAction.onDone} />
          </>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setEditing((o) => !o);
            setConfirmingRetire(false);
          }}
        >
          Edit
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            setConfirmingRetire((o) => !o);
            setEditing(false);
          }}
        >
          Retire
        </button>
      </div>

      {editing && (
        <div className="entry-edit">
          <div className="entry-edit__row">
            <select
              className="select severity-select"
              aria-label="Criticality"
              value={criticality}
              onChange={(e) =>
                setCriticality(e.target.value as DashboardSurfaceSlot["criticality"])
              }
            >
              <option value="preferred">preferred</option>
              <option value="required">required</option>
            </select>
            <select
              className="select"
              aria-label="Sits on"
              value={sitsOn}
              onChange={(e) => setSitsOn(e.target.value)}
            >
              <option value="">— sits on (optional) —</option>
              {SITS_ON_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <input
            className="input"
            placeholder="tone (e.g. friendly, rounded)"
            value={tone}
            onChange={(e) => setTone(e.target.value)}
          />
          <input
            className="input"
            placeholder="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <input
            className="input"
            placeholder="sizes, comma-separated (e.g. 16, 24)"
            value={sizes}
            onChange={(e) => setSizes(e.target.value)}
          />
          <input
            className="input"
            placeholder="used in, comma-separated (e.g. nav, empty-state)"
            value={usedIn}
            onChange={(e) => setUsedIn(e.target.value)}
          />
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
              disabled={submitting}
              onClick={saveEdit}
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {confirmingRetire && (
        <div className="lifecycle-confirm">
          <p className="lifecycle-confirm__copy">
            Retire this slot — it leaves the board, bind, and gap report. History
            is kept.
          </p>
          <div className="lifecycle-confirm__actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={submitting}
              onClick={() => setConfirmingRetire(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={submitting}
              onClick={confirmRetire}
            >
              {submitting ? "Retiring…" : "Retire"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The bottom-of-board single-slot add form (`.global-form`-styled). Creates
 * exactly one slot — bulk/JSON manifest authorship stays Lane-2 agent work. */
function AddSlotForm({
  version,
  reload,
}: {
  version: number;
  reload: () => void;
}): JSX.Element {
  const { pushToast } = useToasts();
  const [id, setId] = useState("");
  const [kind, setKind] = useState<(typeof SLOT_KINDS)[number]>("icon");
  const [description, setDescription] = useState("");
  const [criticality, setCriticality] = useState<"required" | "preferred">("preferred");
  const [sitsOn, setSitsOn] = useState("");
  const [tone, setTone] = useState("");
  const [note, setNote] = useState("");
  const [sizes, setSizes] = useState("");
  const [usedIn, setUsedIn] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const canSubmit = id.trim().length > 0 && description.trim().length > 0 && !submitting;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const context = buildContext({ sitsOn, tone, note, sizes, usedIn });
      const req = surfaceAddRequest({
        slot: {
          id: id.trim(),
          kind,
          description: description.trim(),
          criticality,
          ...(context ? { context } : {}),
        },
        expectedVersion: version,
      });
      await postJson(req.path, req.body);
      pushToast({ kind: "success", message: "Added slot." });
      setId("");
      setDescription("");
      setSitsOn("");
      setTone("");
      setNote("");
      setSizes("");
      setUsedIn("");
      reload();
    } catch (e) {
      if (isVersionConflict(e)) {
        pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
        reload();
      } else {
        setFormError(e instanceof Error ? e.message : "Could not add this slot.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="global-form surface-board__form">
      <h3>Add a slot</h3>
      <div className="field">
        <label className="label" htmlFor="surface-slot-id">
          Slot id
        </label>
        <input
          id="surface-slot-id"
          className="input"
          value={id}
          placeholder="e.g. icon.checkout"
          onChange={(e) => setId(e.target.value)}
        />
      </div>
      <div className="field">
        <label className="label" htmlFor="surface-slot-description">
          Description
        </label>
        <input
          id="surface-slot-description"
          className="input"
          value={description}
          placeholder="What is this slot for?"
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="global-form-actions">
        <select
          className="select"
          aria-label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as (typeof SLOT_KINDS)[number])}
        >
          {SLOT_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select
          className="select severity-select"
          aria-label="Criticality"
          value={criticality}
          onChange={(e) => setCriticality(e.target.value as "required" | "preferred")}
        >
          <option value="preferred">preferred</option>
          <option value="required">required</option>
        </select>
      </div>
      <div className="entry-edit__row">
        <select
          className="select"
          aria-label="Sits on"
          value={sitsOn}
          onChange={(e) => setSitsOn(e.target.value)}
        >
          <option value="">— sits on (optional) —</option>
          {SITS_ON_OPTIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <input
          className="input"
          placeholder="tone"
          value={tone}
          onChange={(e) => setTone(e.target.value)}
        />
      </div>
      <input
        className="input"
        placeholder="note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <input
        className="input"
        placeholder="sizes, comma-separated (e.g. 16, 24)"
        value={sizes}
        onChange={(e) => setSizes(e.target.value)}
      />
      <input
        className="input"
        placeholder="used in, comma-separated (e.g. nav, empty-state)"
        value={usedIn}
        onChange={(e) => setUsedIn(e.target.value)}
      />
      {formError && <p className="surface-board__form-error">{formError}</p>}
      <div className="global-form-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSubmit}
          onClick={submit}
        >
          {submitting ? "Adding…" : "Add slot"}
        </button>
      </div>
    </div>
  );
}
