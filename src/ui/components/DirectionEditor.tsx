/**
 * Inline editor for a direction version's text fields. Two save paths:
 *
 *  - Save changes → `PUT /api/directions/:id` edits the direction's HEAD
 *    version in place (`directionEditRequest`).
 *  - Save as new version → `POST /api/directions/:id/versions` appends the
 *    edited fields as a NEW version (the head advances), leaving the prior
 *    versions untouched (append-only history — `directionVariantRequest`).
 *
 * The structured `character` (six evocative fields) and `usage` rules/anti-rules
 * are edited here; usage rules are entered one-per-line. There is deliberately no
 * field to type a hex or font family into character/usage — color and type live
 * only in the tokens editor below (SC-02). The direction's id and generated images
 * are never touched here.
 */
import React, { useEffect, useState } from "react";
import type { DashboardVersion, DirectionCharacter, DirectionTokens } from "../types";
import { postJson, putJson, isVersionConflict, VERSION_CONFLICT_MESSAGE } from "../hooks";
import {
  directionEditRequest,
  directionVariantRequest,
  fontsReadRequest,
} from "../direction-actions.js";
import { PaletteBoard } from "./PaletteBoard";
import { useToasts } from "./Toasts";

/** A curated font pairing, as served by `GET /api/fonts` (culori-free). */
interface FontPairingLite {
  id: string;
  label: string;
  heading: string;
  body: string;
}

const linesToList = (text: string): string[] =>
  text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s !== "");

/** The six structured `character` fields, in editor order (WS-05). Each is an
 * evocative, all-optional prose field — NEVER a hex or font family. */
const CHARACTER_FIELDS: { key: keyof DirectionCharacter; label: string }[] = [
  { key: "mood", label: "Mood" },
  { key: "composition", label: "Composition" },
  { key: "layout", label: "Layout" },
  { key: "imagery", label: "Imagery" },
  { key: "texture", label: "Texture" },
  { key: "rhythm", label: "Rhythm" },
];

export function DirectionEditor({
  directionId,
  version,
  onClose,
  reload,
}: {
  directionId: string;
  version: DashboardVersion;
  onClose: () => void;
  reload: () => void;
}) {
  const { pushToast } = useToasts();
  const [name, setName] = useState(version.name);
  const [summary, setSummary] = useState(version.summary);
  const [positioning, setPositioning] = useState(version.positioning);
  // The structured character fields — a single object edited field-by-field.
  const [character, setCharacter] = useState<DirectionCharacter>(version.character);
  const [rules, setRules] = useState(version.usage.rules.join("\n"));
  const [antiRules, setAntiRules] = useState(version.usage.antiRules.join("\n"));
  const [headline, setHeadline] = useState(version.copyExamples.headline);
  const [subheadline, setSubheadline] = useState(version.copyExamples.subheadline);
  const [cta, setCta] = useState(version.copyExamples.cta);
  const [busy, setBusy] = useState(false);
  // Structured design tokens — edited in place (palette via PaletteBoard, font
  // from the catalog, shape lengths). Absent on legacy prose-only versions, in
  // which case the token editor is not rendered and no tokens are sent.
  const [tokens, setTokens] = useState<DirectionTokens | undefined>(version.tokens);
  const [pairings, setPairings] = useState<FontPairingLite[]>([]);

  // Load the curated font catalog once (server keeps culori out of the bundle).
  useEffect(() => {
    let cancelled = false;
    fetch(fontsReadRequest().path)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (!cancelled) setPairings((d as { pairings?: FontPairingLite[] }).pairings ?? []);
      })
      .catch(() => {
        /* selector simply shows the current pairing when the catalog is unavailable */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setCharacterField = (key: keyof DirectionCharacter, value: string): void =>
    setCharacter((c) => ({ ...c, [key]: value }));

  const payload = () => ({
    name,
    summary,
    positioning,
    character,
    usage: { rules: linesToList(rules), antiRules: linesToList(antiRules) },
    copyExamples: { headline, subheadline, cta },
    ...(tokens ? { tokens } : {}),
  });

  const selectedPairingId = tokens
    ? pairings.find(
        (p) =>
          p.heading === tokens.typography.heading && p.body === tokens.typography.body,
      )?.id ?? ""
    : "";

  const selectPairing = (id: string): void => {
    const pairing = pairings.find((p) => p.id === id);
    if (!pairing || !tokens) return;
    setTokens({
      ...tokens,
      typography: { ...tokens.typography, heading: pairing.heading, body: pairing.body },
    });
  };

  const setShape = (key: "radius" | "spacingUnit", value: string): void => {
    if (!tokens) return;
    setTokens({ ...tokens, shape: { ...tokens.shape, [key]: value } });
  };

  const handleError = (e: unknown): void => {
    if (isVersionConflict(e)) {
      pushToast({ kind: "error", message: VERSION_CONFLICT_MESSAGE });
      reload();
    } else {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Could not save the direction.",
      });
    }
  };

  /** In-place head edit — `PUT /api/directions/:id`. */
  const saveChanges = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const req = directionEditRequest(directionId, payload());
      await putJson(req.path, req.body);
      pushToast({ kind: "success", message: `Updated "${name}".` });
      reload();
      onClose();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  /** Append the edits as a NEW version — `POST /api/directions/:id/versions`. */
  const saveVariant = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const req = directionVariantRequest(directionId, payload());
      await postJson(req.path, req.body);
      pushToast({ kind: "success", message: `Saved a new version of "${name}".` });
      reload();
      onClose();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="direction-editor">
      <div className="field">
        <label className="label" htmlFor={`edit-name-${directionId}`}>Name</label>
        <input
          id={`edit-name-${directionId}`}
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="label" htmlFor={`edit-summary-${directionId}`}>Summary</label>
        <textarea
          id={`edit-summary-${directionId}`}
          className="textarea direction-editor-short"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="label" htmlFor={`edit-positioning-${directionId}`}>Positioning</label>
        <textarea
          id={`edit-positioning-${directionId}`}
          className="textarea direction-editor-short"
          value={positioning}
          onChange={(e) => setPositioning(e.target.value)}
        />
      </div>

      <fieldset className="direction-editor-character">
        <legend className="label">Character</legend>
        <div className="direction-editor-character-grid">
          {CHARACTER_FIELDS.map(({ key, label }) => (
            <div className="field" key={key}>
              <label className="label" htmlFor={`edit-char-${key}-${directionId}`}>
                {label}
              </label>
              <input
                id={`edit-char-${key}-${directionId}`}
                className="input"
                value={character[key] ?? ""}
                onChange={(e) => setCharacterField(key, e.target.value)}
              />
            </div>
          ))}
        </div>
      </fieldset>

      <div className="field">
        <label className="label" htmlFor={`edit-rules-${directionId}`}>
          Usage rules (one per line)
        </label>
        <textarea
          id={`edit-rules-${directionId}`}
          className="textarea"
          value={rules}
          onChange={(e) => setRules(e.target.value)}
        />
      </div>

      <div className="field">
        <label className="label" htmlFor={`edit-anti-${directionId}`}>
          Anti-rules (one per line)
        </label>
        <textarea
          id={`edit-anti-${directionId}`}
          className="textarea"
          value={antiRules}
          onChange={(e) => setAntiRules(e.target.value)}
        />
      </div>

      <div className="direction-editor-copy">
        <div className="field">
          <label className="label" htmlFor={`edit-headline-${directionId}`}>Headline</label>
          <input
            id={`edit-headline-${directionId}`}
            className="input"
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`edit-subhead-${directionId}`}>Subhead</label>
          <input
            id={`edit-subhead-${directionId}`}
            className="input"
            value={subheadline}
            onChange={(e) => setSubheadline(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`edit-cta-${directionId}`}>CTA</label>
          <input
            id={`edit-cta-${directionId}`}
            className="input"
            value={cta}
            onChange={(e) => setCta(e.target.value)}
          />
        </div>
      </div>

      {tokens && (
        <div className="token-editor">
          <span className="token-editor-legend">Design tokens</span>
          <PaletteBoard
            directionId={directionId}
            reload={reload}
            tokens={tokens}
            onChange={setTokens}
            editable
          />
          <div className="token-editor-grid">
            <div className="field">
              <label className="label" htmlFor={`edit-fonts-${directionId}`}>
                Font pairing (catalog)
              </label>
              <select
                id={`edit-fonts-${directionId}`}
                className="input"
                value={selectedPairingId}
                onChange={(e) => selectPairing(e.target.value)}
              >
                {selectedPairingId === "" && (
                  <option value="" disabled>
                    {`${tokens.typography.heading} + ${tokens.typography.body}`}
                  </option>
                )}
                {pairings.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="label" htmlFor={`edit-radius-${directionId}`}>
                Corner radius
              </label>
              <input
                id={`edit-radius-${directionId}`}
                className="input"
                value={tokens.shape.radius}
                onChange={(e) => setShape("radius", e.target.value)}
              />
            </div>
            <div className="field">
              <label className="label" htmlFor={`edit-spacing-${directionId}`}>
                Spacing unit
              </label>
              <input
                id={`edit-spacing-${directionId}`}
                className="input"
                value={tokens.shape.spacingUnit}
                onChange={(e) => setShape("spacingUnit", e.target.value)}
              />
            </div>
          </div>
        </div>
      )}

      <div className="direction-editor-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={saveChanges}
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          title="Append the edits as a new version; leaves the prior versions untouched"
          onClick={saveVariant}
        >
          Save as new version
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
