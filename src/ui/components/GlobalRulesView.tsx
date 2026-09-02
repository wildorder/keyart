/**
 * Global brand: the project-wide authority layer. It leads with the approved
 * direction it points at (consolidated here from the old standalone "Approved
 * Direction" section — the pointer and the visual it references now live
 * together), then the hard/guideline rules, then the writable authoring forms:
 *
 *  - Add rule    → `POST /api/rules`   ({ text, severity }) authors a global rule.
 *  - Promote     → `globalPromoteRequest` (`POST /api/promote`, `directionId`
 *                  only — WS-05's contracted signature) lifts ONE direction
 *                  learning to global, by free text or by selecting a memory
 *                  entry (entryId).
 *
 * Global hard rules override direction feedback everywhere and survive
 * rebrands — the copy makes that explicit. A 409 surfaces the standard
 * reload-and-retry.
 */
import React, { useMemo, useState } from "react";
import type {
  ApprovedDirection,
  DashboardDirection,
  DashboardGlobal,
  DashboardRule,
  DirectiveChannel,
  DirectivePolarity,
  RuleSeverity,
} from "../types";
import { formatDate } from "../format";
import {
  postJson,
  patchJson,
  deleteJson,
  isVersionConflict,
  VERSION_CONFLICT_MESSAGE,
} from "../hooks";
import { DirectionCard } from "./DirectionCard";
import { useToasts } from "./Toasts";
import { ruleLifecycleActionsFor } from "./lifecycle-actions.js";
import {
  globalPromoteRequest,
  ruleAddRequest,
  ruleEditRequest,
  ruleRemoveRequest,
} from "../direction-actions.js";

export function GlobalRulesView({
  global,
  approved,
  directions,
  reload,
}: {
  global: DashboardGlobal;
  approved: ApprovedDirection | null;
  directions: DashboardDirection[];
  reload: () => void;
}) {
  const hardRules = global.rules.filter((r) => r.severity === "hard");
  const guidelineRules = global.rules.filter((r) => r.severity === "guideline");

  return (
    <section id="global" className="section global-section">
      <h2>Approved Brand</h2>
      <p className="section-note">
        The project-wide brand — the approved direction plus rules that apply to
        every direction. Hard rules override direction feedback everywhere and
        survive rebrands; guidelines are advisory.
      </p>

      {/* Approved direction — the visual the global pointer references. */}
      <div className="global-approved">
        <h3>Approved Direction</h3>
        {approved ? (
          <>
            {approved.provenance && (
              <p className="provenance">
                from direction &quot;{approved.provenance.directionId}&quot;, version{" "}
                {approved.provenance.versionId}, approved{" "}
                {formatDate(approved.provenance.approvedAt)}
              </p>
            )}
            <DirectionCard direction={approved} isApproved />
          </>
        ) : global.approvedPointer ? (
          <p className="pointer-line">
            Approved: direction &quot;{global.approvedPointer.directionId}&quot; /
            version {global.approvedPointer.versionId} — approved{" "}
            {formatDate(global.approvedPointer.approvedAt)}
          </p>
        ) : (
          <div className="empty-state">
            No direction approved yet. Approve a direction to set the global brand.
          </div>
        )}
      </div>

      {/* Rules */}
      <div className="global-rules">
        <h3>Rules</h3>
        {global.rules.length > 0 ? (
          <div className="rule-list">
            {[...hardRules, ...guidelineRules].map((rule) => (
              <div key={rule.id} className="rule-row">
                <span className={`badge badge-${rule.severity}`}>{rule.severity}</span>
                {rule.channel && (
                  <span className="directive-tag">{rule.channel} · {rule.polarity ?? "prefer"}</span>
                )}
                <div className="rule-text">{rule.text}</div>
                <div className="rule-meta">
                  {rule.author}/{rule.source} · {formatDate(rule.date)}
                </div>
                <RuleActions rule={rule} reload={reload} />
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            No global rules yet. Add one below, or promote a direction learning.
          </div>
        )}
      </div>

      {/* WS-06 authoring forms */}
      <div className="global-forms">
        <AddRuleForm reload={reload} />
        <PromoteForm directions={directions} reload={reload} />
      </div>
    </section>
  );
}

/**
 * Per-rule Edit / Remove controls, gated by `ruleLifecycleActionsFor`. A HARD
 * rule's remove is force-gated (extra confirm copy + `force: true`); a
 * severity change to/from hard force-gates the edit save the same way.
 */
function RuleActions({ rule, reload }: { rule: DashboardRule; reload: () => void }) {
  const { pushToast } = useToasts();
  const actions = ruleLifecycleActionsFor(rule);

  const [editing, setEditing] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [text, setText] = useState(rule.text);
  const [severity, setSeverity] = useState<RuleSeverity>(rule.severity);

  if (!actions.canEdit && !actions.canRemove) return null;

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
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    setSubmitting(true);
    const needsForce = rule.severity === "hard" || severity === "hard";
    try {
      const req = ruleEditRequest(rule.id, {
        text: trimmed,
        severity,
        ...(needsForce ? { force: true as const } : {}),
      });
      await patchJson(req.path, req.body);
      pushToast({ kind: "success", message: "Saved rule." });
      setEditing(false);
      reload();
    } catch (e) {
      handleError(e, "Could not save this rule.");
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const req = ruleRemoveRequest(rule.id, {
        ...(actions.forceRequired ? { force: true as const } : {}),
      });
      await deleteJson(req.path, req.body);
      pushToast({ kind: "success", message: "Removed rule." });
      setConfirmingRemove(false);
      reload();
    } catch (e) {
      handleError(e, "Could not remove this rule.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="rule-actions">
      <div className="rule-actions__buttons">
        {actions.canEdit && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setEditing((o) => !o);
              setConfirmingRemove(false);
            }}
          >
            Edit
          </button>
        )}
        {actions.canRemove && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setConfirmingRemove((o) => !o);
              setEditing(false);
            }}
          >
            Remove
          </button>
        )}
      </div>

      {editing && (
        <div className="entry-edit rule-edit">
          <input
            className="input"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <select
            className="select severity-select"
            aria-label="Rule severity"
            value={severity}
            onChange={(e) => setSeverity(e.target.value as RuleSeverity)}
          >
            <option value="guideline">guideline</option>
            <option value="hard">hard</option>
          </select>
          {(rule.severity === "hard" || severity === "hard") && (
            <p className="lifecycle-confirm__copy lifecycle-confirm__copy--force">
              This is a HARD rule — changing it changes the brand everywhere.
            </p>
          )}
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
              disabled={submitting || text.trim().length === 0}
              onClick={saveEdit}
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      {confirmingRemove && (
        <div className={`lifecycle-confirm${actions.forceRequired ? " lifecycle-confirm--force" : ""}`}>
          <p className="lifecycle-confirm__copy">
            Remove this rule — it will stop applying everywhere. History is kept.
          </p>
          {actions.forceRequired && (
            <p className="lifecycle-confirm__copy lifecycle-confirm__copy--force">
              This is a HARD rule — removing it changes the brand everywhere.
            </p>
          )}
          <div className="lifecycle-confirm__actions">
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={submitting}
              onClick={() => setConfirmingRemove(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={submitting}
              onClick={remove}
            >
              {submitting ? "Removing…" : "Remove"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Author a new global rule via `POST /api/rules`. */
function AddRuleForm({ reload }: { reload: () => void }) {
  const { pushToast } = useToasts();
  const [text, setText] = useState("");
  const [severity, setSeverity] = useState<RuleSeverity>("guideline");
  const [channel, setChannel] = useState<DirectiveChannel>("visual");
  const [polarity, setPolarity] = useState<DirectivePolarity>("avoid");
  const [submitting, setSubmitting] = useState(false);

  const trimmed = text.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const req = ruleAddRequest({ text: trimmed, severity, channel, polarity });
      await postJson(req.path, req.body);
      pushToast({ kind: "success", message: `Added ${severity} rule.` });
      setText("");
      reload();
    } catch (e) {
      if (isVersionConflict(e)) {
        pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
        reload();
      } else {
        pushToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not add rule.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="global-form">
      <h3>Add a global rule</h3>
      <p className="section-note">
        Applies to every direction. Choose <strong>hard</strong> to override
        direction feedback everywhere. Visual directives reach the image
        prompts; copy-only rules stay in the text lane.
      </p>
      <div className="field">
        <label className="label" htmlFor="rule-text">
          Rule
        </label>
        <input
          id="rule-text"
          className="input"
          value={text}
          placeholder="e.g. Never use pure black (#000) for body text"
          onChange={(e) => setText(e.target.value)}
        />
      </div>
      <div className="global-form-actions">
        <select
          className="select severity-select"
          aria-label="Rule severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as RuleSeverity)}
        >
          <option value="guideline">guideline</option>
          <option value="hard">hard</option>
        </select>
        <select
          className="select"
          aria-label="Applies to"
          value={channel}
          onChange={(e) => setChannel(e.target.value as DirectiveChannel)}
        >
          <option value="visual">visual</option>
          <option value="copy">copy</option>
          <option value="both">both</option>
        </select>
        <select
          className="select"
          aria-label="Direction"
          value={polarity}
          onChange={(e) => setPolarity(e.target.value as DirectivePolarity)}
        >
          <option value="avoid">avoid</option>
          <option value="prefer">prefer</option>
        </select>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSubmit}
          onClick={submit}
        >
          {submitting ? "Adding…" : "Add rule"}
        </button>
      </div>
    </div>
  );
}

/** Lift one direction learning to global via `globalPromoteRequest`
 * (`POST /api/promote` — `directionId` only; WS-05's contracted signature,
 * never re-widened). */
function PromoteForm({
  directions,
  reload,
}: {
  directions: DashboardDirection[];
  reload: () => void;
}) {
  const { pushToast } = useToasts();
  const [directionId, setDirectionId] = useState(directions[0]?.id ?? "");
  const [mode, setMode] = useState<"text" | "entry">("text");
  const [text, setText] = useState("");
  const [entryId, setEntryId] = useState("");
  const [severity, setSeverity] = useState<RuleSeverity>("guideline");
  const [submitting, setSubmitting] = useState(false);

  const selected = useMemo(
    () => directions.find((d) => d.id === directionId) ?? null,
    [directions, directionId],
  );
  // Promote lifts a direction *learning* — offer this direction's learning entries.
  const learnings = useMemo(
    () => (selected?.memory ?? []).filter((m) => m.kind === "learning"),
    [selected],
  );

  const trimmed = text.trim();
  const hasPayload =
    mode === "text" ? trimmed.length > 0 : entryId.length > 0;
  const canSubmit = directionId.length > 0 && hasPayload && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const req = globalPromoteRequest({
        directionId,
        severity,
        ...(mode === "text" ? { text: trimmed } : { entryId }),
      });
      await postJson(req.path, req.body);
      pushToast({ kind: "success", message: "Promoted learning to global." });
      setText("");
      setEntryId("");
      reload();
    } catch (e) {
      if (isVersionConflict(e)) {
        pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
        reload();
      } else {
        pushToast({
          kind: "error",
          message: e instanceof Error ? e.message : "Could not promote learning.",
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (directions.length === 0) {
    return (
      <div className="global-form">
        <h3>Promote a learning</h3>
        <div className="empty-state">Create a direction first, then promote its learnings.</div>
      </div>
    );
  }

  return (
    <div className="global-form">
      <h3>Promote a learning</h3>
      <p className="section-note">
        Lift one direction learning into the global brand. Promoting as{" "}
        <strong>hard</strong> makes it override direction feedback everywhere and
        survive rebrands.
      </p>

      <div className="field">
        <label className="label" htmlFor="promote-direction">
          Direction
        </label>
        <select
          id="promote-direction"
          className="select"
          value={directionId}
          onChange={(e) => {
            setDirectionId(e.target.value);
            setEntryId("");
          }}
        >
          {directions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} ({d.id})
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label className="label">Source</label>
        <div className="radio-row">
          <label className="radio-option">
            <input
              type="radio"
              name="promote-mode"
              checked={mode === "text"}
              onChange={() => setMode("text")}
            />
            New learning text
          </label>
          <label className="radio-option">
            <input
              type="radio"
              name="promote-mode"
              checked={mode === "entry"}
              disabled={learnings.length === 0}
              onChange={() => setMode("entry")}
            />
            Existing learning
            {learnings.length === 0 && " (none yet)"}
          </label>
        </div>
      </div>

      {mode === "text" ? (
        <div className="field">
          <label className="label" htmlFor="promote-text">
            Learning
          </label>
          <input
            id="promote-text"
            className="input"
            value={text}
            placeholder="e.g. Warm neutrals read as premium for this audience"
            onChange={(e) => setText(e.target.value)}
          />
        </div>
      ) : (
        <div className="field">
          <label className="label" htmlFor="promote-entry">
            Learning entry
          </label>
          <select
            id="promote-entry"
            className="select"
            value={entryId}
            onChange={(e) => setEntryId(e.target.value)}
          >
            <option value="">— choose a learning —</option>
            {learnings.map((m) => (
              <option key={m.id} value={m.id}>
                {m.body.length > 80 ? `${m.body.slice(0, 80)}…` : m.body}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="global-form-actions">
        <select
          className="select severity-select"
          aria-label="Promote severity"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as RuleSeverity)}
        >
          <option value="guideline">guideline</option>
          <option value="hard">hard</option>
        </select>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canSubmit}
          onClick={submit}
        >
          {submitting ? "Promoting…" : "Promote to global"}
        </button>
      </div>
    </div>
  );
}
