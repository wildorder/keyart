/**
 * Structured brief editor (WS-05). The direction's `brief` is a STRUCTURED,
 * versioned record — this edits FIELDS (grouped by section: identity / strategy /
 * personality / aesthetic intent / grounding / notes), not raw markdown. Scalars
 * are text inputs, arrays are comma "tag" inputs, and `audiences` is a small
 * repeater. Saving dispatches a `BrandBriefPatch` to the versioned
 * `PATCH /api/directions/:id/brief` (409-safe, `briefWriteRequest`) via core;
 * the read-only markdown
 * PREVIEW renders the `renderedBrief` projection (never an editable source, so
 * the old H1/H3 heading collision is gone — this panel owns the single "Brief"
 * `<h3>` and the projection emits no H1).
 *
 * The optional "Paste a description → propose fields" affordance POSTs to
 * `/brief/map` (the WS-03 mapper), previews the proposed field diff + hex-lock
 * suggestions, and applies on confirm (field PATCH + a color-lock per hex). With
 * no key the proposal is empty (dryRun) and manual field entry always works.
 * Aesthetic-intent fields are SOFT intent (words) — a typed hex is gently hinted
 * to route to a lock, never stored as a brief field (SC-06).
 */
import React, { useEffect, useRef, useState } from "react";
import type { Audience, BrandBrief, DashboardDirection } from "../types";
import {
  patchJson,
  postJson,
  isVersionConflict,
  VERSION_CONFLICT_MESSAGE,
} from "../hooks";
import {
  briefColorLockRequest,
  briefMapRequest,
  briefWriteRequest,
} from "../direction-actions.js";
import {
  emptyBrief,
  toPatch,
  briefEquals,
  hasHex,
  splitTags,
  joinTags,
  type BriefMapProposal,
} from "../brief-form";
import { useToasts } from "./Toasts";
import { Markdown } from "./Markdown";

/** The `PATCH /brief` response — re-seeds the form without a full reload. */
interface BriefWriteResult {
  brief: BrandBrief;
  renderedBrief: string;
  version: number;
}

export function BriefEditor({
  direction,
  reload,
  variant,
}: {
  direction: DashboardDirection;
  reload: () => void;
  variant?: "drawer";
}) {
  const { pushToast } = useToasts();
  const initial = direction.brief ?? emptyBrief();
  const [form, setForm] = useState<BrandBrief>(initial);
  const [saved, setSaved] = useState<BrandBrief>(initial);
  const [version, setVersion] = useState(direction.version);
  // Preview (rendered projection) is the default view; the field form is opt-in.
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // The rendered markdown projection to preview. Seeded from the payload; updated
  // from every write response so the preview never lags the fields.
  const [rendered, setRendered] = useState(direction.renderedBrief);

  // Map affordance state.
  const [ramble, setRamble] = useState("");
  const [proposing, setProposing] = useState(false);
  const [proposal, setProposal] = useState<BriefMapProposal | null>(null);

  const dirty = !briefEquals(form, saved);
  // Track the live dirty flag across a direction switch so we can warn before
  // discarding it (state itself resets to the newly-selected direction's brief).
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Re-seed when the focused direction changes; warn if edits are being dropped.
  useEffect(() => {
    if (dirtyRef.current) {
      pushToast({
        kind: "info",
        message: "Unsaved brief edits were discarded when you switched directions.",
      });
    }
    const next = direction.brief ?? emptyBrief();
    setForm(next);
    setSaved(next);
    setVersion(direction.version);
    setRendered(direction.renderedBrief);
    setEditing(false);
    setProposal(null);
    setRamble("");
    // Only re-run on direction identity — not on every brief re-fetch, which
    // would otherwise stomp in-progress edits. `pushToast` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [direction.id]);

  /** Apply a write result to local state (re-seed form + preview + version). */
  const seedFrom = (result: BriefWriteResult) => {
    setForm(result.brief);
    setSaved(result.brief);
    setVersion(result.version);
    setRendered(result.renderedBrief);
  };

  const setField = <K extends keyof BrandBrief>(key: K, value: BrandBrief[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
  };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const req = briefWriteRequest(direction.id, toPatch(form), version);
      const result = await patchJson<BriefWriteResult>(req.path, req.body);
      seedFrom(result);
      setEditing(false);
      pushToast({ kind: "success", message: "Brief saved." });
      reload();
    } catch (e) {
      if (isVersionConflict(e)) {
        pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
        reload();
      } else {
        pushToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not save brief.",
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const propose = async () => {
    if (proposing || ramble.trim() === "") return;
    setProposing(true);
    try {
      const req = briefMapRequest(direction.id, ramble);
      const result = await postJson<BriefMapProposal>(req.path, req.body);
      setProposal(result);
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Could not map the description.",
      });
    } finally {
      setProposing(false);
    }
  };

  const applyProposal = async () => {
    if (saving || proposal === null) return;
    setSaving(true);
    try {
      const hasFields = Object.keys(proposal.patch).length > 0;
      let result: BriefWriteResult | null = null;
      if (hasFields) {
        const req = briefWriteRequest(direction.id, proposal.patch, version);
        result = await patchJson<BriefWriteResult>(req.path, req.body);
      }
      // Each pasted hex routes to an attributed color LOCK — never a brief field.
      for (const lock of proposal.hexLocks) {
        const lockReq = briefColorLockRequest(direction.id, lock.hex, lock.note);
        await postJson(lockReq.path, lockReq.body);
      }
      if (result) seedFrom(result);
      setProposal(null);
      setRamble("");
      const lockNote =
        proposal.hexLocks.length > 0
          ? ` ${proposal.hexLocks.length} color${
              proposal.hexLocks.length === 1 ? "" : "s"
            } locked.`
          : "";
      pushToast({
        kind: "success",
        message: `${hasFields ? "Fields applied." : "No field changes."}${lockNote}`,
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
      setSaving(false);
    }
  };

  return (
    <div className={`brief-editor${variant === "drawer" ? " brief-editor--drawer" : ""}`}>
      <div className="brief-editor-head">
        <h3>Brief</h3>
        <div className="brief-editor-controls">
          {dirty && (
            <span className="dirty-dot" title="Unsaved changes">
              ● unsaved
            </span>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setEditing((e) => !e)}
          >
            {editing ? "Preview" : "Edit fields"}
          </button>
          {editing && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={saving || !dirty}
              onClick={save}
            >
              {saving ? "Saving…" : "Save brief"}
            </button>
          )}
        </div>
      </div>

      {editing ? (
        <BriefForm form={form} setField={setField}>
          <MapAffordance
            ramble={ramble}
            setRamble={setRamble}
            proposing={proposing}
            proposal={proposal}
            onPropose={propose}
            onApply={applyProposal}
            onDismiss={() => setProposal(null)}
            applying={saving}
          />
        </BriefForm>
      ) : rendered.trim() ? (
        // Plain rendered markdown projection — fully selectable, never editable.
        <Markdown className="brief-text">{rendered}</Markdown>
      ) : (
        <button
          type="button"
          className="brief-preview-empty"
          onClick={() => setEditing(true)}
        >
          Nothing here yet — click to fill in the brief.
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field form
// ---------------------------------------------------------------------------

function BriefForm({
  form,
  setField,
  children,
}: {
  form: BrandBrief;
  setField: <K extends keyof BrandBrief>(key: K, value: BrandBrief[K]) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="brief-form">
      {children}

      <FormSection title="Identity">
        <ScalarField
          label="One-liner"
          value={form.oneLiner}
          onChange={(v) => setField("oneLiner", v)}
        />
        <TagField
          label="Aliases"
          items={form.aliases}
          onChange={(v) => setField("aliases", v)}
        />
        <TagField
          label="Never call it"
          items={form.neverCallIt}
          onChange={(v) => setField("neverCallIt", v)}
        />
      </FormSection>

      <FormSection title="Strategy">
        <ScalarField
          label="Problem"
          multiline
          value={form.problem}
          onChange={(v) => setField("problem", v)}
        />
        <ScalarField
          label="Positioning"
          multiline
          value={form.positioning}
          onChange={(v) => setField("positioning", v)}
        />
        <AudienceRepeater
          audiences={form.audiences}
          onChange={(v) => setField("audiences", v)}
        />
        <TagField
          label="Differentiate from"
          items={form.differentiateFrom}
          onChange={(v) => setField("differentiateFrom", v)}
        />
      </FormSection>

      <FormSection title="Personality">
        <TagField
          label="Tone"
          items={form.tone}
          onChange={(v) => setField("tone", v)}
        />
        <TagField
          label="Values"
          items={form.values}
          onChange={(v) => setField("values", v)}
        />
        <ScalarField
          label="Voice"
          value={form.voice}
          onChange={(v) => setField("voice", v)}
        />
      </FormSection>

      <FormSection
        title="Aesthetic intent"
        note="Soft intent — words that steer generation, never exact hex codes or font families."
      >
        <ScalarField
          label="Color intent"
          value={form.colorIntent}
          onChange={(v) => setField("colorIntent", v)}
          hexHint
        />
        <ScalarField
          label="Type intent"
          value={form.typeIntent}
          onChange={(v) => setField("typeIntent", v)}
          hexHint
        />
        <ScalarField
          label="Mood & imagery"
          value={form.moodImagery}
          onChange={(v) => setField("moodImagery", v)}
        />
        <ScalarField
          label="Mascot"
          value={form.mascot}
          onChange={(v) => setField("mascot", v)}
        />
      </FormSection>

      <FormSection title="Grounding">
        <TagField
          label="Inspirations"
          items={form.inspirations}
          onChange={(v) => setField("inspirations", v)}
        />
        <TagField
          label="Constraints"
          items={form.constraints}
          onChange={(v) => setField("constraints", v)}
        />
        <TagField
          label="Surfaces"
          items={form.surfaces}
          onChange={(v) => setField("surfaces", v)}
        />
      </FormSection>

      <FormSection title="Notes">
        <ScalarField
          label="Other notes"
          multiline
          value={form.otherNotes}
          onChange={(v) => setField("otherNotes", v)}
        />
      </FormSection>
    </div>
  );
}

function FormSection({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="brief-form-section">
      <legend>{title}</legend>
      {note && <p className="brief-form-note">{note}</p>}
      {children}
    </fieldset>
  );
}

function ScalarField({
  label,
  value,
  onChange,
  multiline,
  hexHint,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string) => void;
  multiline?: boolean;
  hexHint?: boolean;
}) {
  const showHexHint = hexHint === true && hasHex(value);
  return (
    <label className="brief-field">
      <span className="brief-field-label">{label}</span>
      {multiline ? (
        <textarea
          className="textarea brief-field-input"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          type="text"
          className="input brief-field-input"
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {showHexHint && (
        <span className="brief-field-hint">
          That looks like an exact color — lock it as a brand color (paste it into
          the description mapper below) rather than storing a hex here.
        </span>
      )}
    </label>
  );
}

function TagField({
  label,
  items,
  onChange,
}: {
  label: string;
  items: string[];
  onChange: (items: string[]) => void;
}) {
  return (
    <label className="brief-field">
      <span className="brief-field-label">
        {label} <span className="brief-field-sub">(comma-separated)</span>
      </span>
      <input
        type="text"
        className="input brief-field-input"
        value={joinTags(items)}
        onChange={(e) => onChange(splitTags(e.target.value))}
      />
    </label>
  );
}

function AudienceRepeater({
  audiences,
  onChange,
}: {
  audiences: Audience[];
  onChange: (audiences: Audience[]) => void;
}) {
  const update = (i: number, patch: Partial<Audience>) => {
    onChange(audiences.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  };
  const remove = (i: number) => {
    onChange(audiences.filter((_, idx) => idx !== i));
  };
  const add = () => {
    onChange([...audiences, { who: "" }]);
  };

  return (
    <div className="brief-field brief-audiences">
      <span className="brief-field-label">Audiences</span>
      {audiences.map((a, i) => (
        <div key={i} className="brief-audience-row">
          <input
            type="text"
            className="input"
            placeholder="Who"
            value={a.who}
            onChange={(e) => update(i, { who: e.target.value })}
          />
          <input
            type="text"
            className="input"
            placeholder="Context (optional)"
            value={a.context ?? ""}
            onChange={(e) => update(i, { context: e.target.value })}
          />
          <input
            type="text"
            className="input"
            placeholder="Need (optional)"
            value={a.need ?? ""}
            onChange={(e) => update(i, { need: e.target.value })}
          />
          <button
            type="button"
            className="btn btn-ghost"
            aria-label="Remove audience"
            onClick={() => remove(i)}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost" onClick={add}>
        + Add audience
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Map affordance
// ---------------------------------------------------------------------------

function MapAffordance({
  ramble,
  setRamble,
  proposing,
  proposal,
  onPropose,
  onApply,
  onDismiss,
  applying,
}: {
  ramble: string;
  setRamble: (value: string) => void;
  proposing: boolean;
  proposal: BriefMapProposal | null;
  onPropose: () => void;
  onApply: () => void;
  onDismiss: () => void;
  applying: boolean;
}) {
  const fieldEntries = proposal ? Object.entries(proposal.patch) : [];
  const emptyProposal =
    proposal !== null &&
    fieldEntries.length === 0 &&
    proposal.hexLocks.length === 0;

  return (
    <div className="brief-map">
      <span className="brief-field-label">Paste a description → propose fields</span>
      <textarea
        className="textarea brief-field-input"
        placeholder="Paste a ramble about the brand — audience, tone, aesthetic — and propose structured fields…"
        value={ramble}
        onChange={(e) => setRamble(e.target.value)}
      />
      <div className="brief-map-controls">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={proposing || ramble.trim() === ""}
          onClick={onPropose}
        >
          {proposing ? "Proposing…" : "Propose fields"}
        </button>
      </div>

      {proposal && (
        <div className="brief-map-proposal">
          {proposal.dryRun && (
            <p className="brief-form-note">
              No API key — no fields were proposed. Edit the fields directly below.
            </p>
          )}
          {proposal.notes && <p className="brief-form-note">{proposal.notes}</p>}

          {fieldEntries.length > 0 && (
            <>
              <p className="brief-field-label">Proposed fields</p>
              <ul className="brief-map-diff">
                {fieldEntries.map(([key, value]) => (
                  <li key={key}>
                    <strong>{key}:</strong> {formatProposedValue(value)}
                  </li>
                ))}
              </ul>
            </>
          )}

          {proposal.hexLocks.length > 0 && (
            <>
              <p className="brief-field-label">Colors to lock (not brief fields)</p>
              <ul className="brief-map-diff">
                {proposal.hexLocks.map((lock) => (
                  <li key={lock.hex}>
                    <span
                      className="brief-swatch"
                      style={{ backgroundColor: lock.hex }}
                    />{" "}
                    {lock.hex}
                    {lock.note ? ` — ${lock.note}` : ""}
                  </li>
                ))}
              </ul>
            </>
          )}

          {emptyProposal && (
            <p className="brief-form-note">
              Nothing to apply — edit the fields directly.
            </p>
          )}

          <div className="brief-map-controls">
            <button
              type="button"
              className="btn btn-primary"
              disabled={applying || emptyProposal}
              onClick={onApply}
            >
              {applying ? "Applying…" : "Apply"}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Render a proposed patch value (string or string[] or audiences) for preview. */
function formatProposedValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((v) =>
        typeof v === "string"
          ? v
          : v && typeof v === "object" && "who" in v
            ? String((v as { who: unknown }).who)
            : JSON.stringify(v),
      )
      .join(", ");
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}
