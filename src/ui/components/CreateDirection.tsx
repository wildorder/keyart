/**
 * The authored form ("Author" in the NewDirectionModal): host-agent-style
 * authored content, field-by-field or paste-JSON. Posts
 * `authoredCreateRequest` to `POST /api/directions/:sourceId/create`
 * (synchronous, keyless — mirrors the CLI's `direction create '<json>'
 * --from <id>` re-spell) and reloads the gallery on success. A 400 validation
 * error from the core is shown inline.
 *
 * Colors and fonts are NOT authored here — they are generated/extracted.
 */
import React, { useState } from "react";
import type { DashboardDirection, CreateDirectionResult } from "../types.js";
import { authoredCreateRequest } from "../direction-actions.js";
import { postJson, ApiError } from "../hooks.js";

interface Props {
  /** Every visible direction — the seed ("from") choices. */
  directions: DashboardDirection[];
  /** The default seed direction the authored create is seeded by. */
  sourceId: string;
  reload: () => void;
  /** When true, render the form body without the toggle button (always-open). */
  alwaysOpen?: boolean;
  /** Called after a successful create, before reload(). Used by NewDirectionModal. */
  onSuccess?: () => void;
}

type Mode = "fields" | "json";

export function CreateDirection({ directions, sourceId, reload, alwaysOpen, onSuccess }: Props) {
  const [open, setOpen] = useState(alwaysOpen ?? false);
  const [seed, setSeed] = useState(sourceId);
  const [mode, setMode] = useState<Mode>("fields");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- Fields mode state ---
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const [positioning, setPositioning] = useState("");
  const [mood, setMood] = useState("");
  const [composition, setComposition] = useState("");
  const [layout, setLayout] = useState("");
  const [imagery, setImagery] = useState("");
  const [texture, setTexture] = useState("");
  const [rhythm, setRhythm] = useState("");
  const [rules, setRules] = useState("");
  const [antiRules, setAntiRules] = useState("");
  const [headline, setHeadline] = useState("");
  const [subheadline, setSubheadline] = useState("");
  const [cta, setCta] = useState("");
  const [styleTilePrompt, setStyleTilePrompt] = useState("");
  const [homepageMockupPrompt, setHomepageMockupPrompt] = useState("");

  // --- JSON mode state ---
  const [jsonText, setJsonText] = useState("");

  function resetForm() {
    setName("");
    setSummary("");
    setPositioning("");
    setMood("");
    setComposition("");
    setLayout("");
    setImagery("");
    setTexture("");
    setRhythm("");
    setRules("");
    setAntiRules("");
    setHeadline("");
    setSubheadline("");
    setCta("");
    setStyleTilePrompt("");
    setHomepageMockupPrompt("");
    setJsonText("");
    setError(null);
  }

  function buildPayload(): unknown {
    if (mode === "json") {
      return JSON.parse(jsonText);
    }
    const lines = (text: string) =>
      text
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    const payload: Record<string, unknown> = {
      name,
      summary,
      character: {
        ...(mood.trim() ? { mood: mood.trim() } : {}),
        ...(composition.trim() ? { composition: composition.trim() } : {}),
        ...(layout.trim() ? { layout: layout.trim() } : {}),
        ...(imagery.trim() ? { imagery: imagery.trim() } : {}),
        ...(texture.trim() ? { texture: texture.trim() } : {}),
        ...(rhythm.trim() ? { rhythm: rhythm.trim() } : {}),
      },
      usage: {
        rules: lines(rules),
        antiRules: lines(antiRules),
      },
      copyExamples: {
        headline: headline.trim(),
        subheadline: subheadline.trim(),
        cta: cta.trim(),
      },
    };
    if (positioning.trim()) payload.positioning = positioning.trim();
    if (styleTilePrompt.trim()) payload.styleTilePrompt = styleTilePrompt.trim();
    if (homepageMockupPrompt.trim()) payload.homepageMockupPrompt = homepageMockupPrompt.trim();
    return payload;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    let payload: unknown;
    try {
      payload = buildPayload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid JSON — check syntax");
      return;
    }

    setCreating(true);
    try {
      const req = authoredCreateRequest(seed || sourceId, payload);
      await postJson<CreateDirectionResult>(req.path, req.body);
      resetForm();
      setOpen(false);
      onSuccess?.();
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="create-direction">
      {!alwaysOpen && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            setOpen((o) => !o);
            if (open) resetForm();
          }}
        >
          {open ? "Cancel" : "Create a direction manually"}
        </button>
      )}

      {open && (
        <form className="create-direction-form" onSubmit={handleSubmit}>
          <p className="field-hint create-direction-hint">
            Colors and fonts are NOT authored here — describe the feeling; pin
            exact colors with a color-lock. Tokens are generated.
          </p>

          <div className="field">
            <label className="label" htmlFor="create-direction-seed">
              Seeded by
            </label>
            <select
              id="create-direction-seed"
              className="select"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
            >
              {directions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.id})
                </option>
              ))}
            </select>
          </div>

          <div className="create-direction-mode action-row">
            <button
              type="button"
              className={`btn ${mode === "fields" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setMode("fields")}
            >
              Fields
            </button>
            <button
              type="button"
              className={`btn ${mode === "json" ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setMode("json")}
            >
              Paste JSON
            </button>
          </div>

          {mode === "json" ? (
            <div className="create-direction-json">
              <label className="explore-guidance">
                <span className="explore-guidance-label">JSON payload</span>
                <textarea
                  className="textarea"
                  value={jsonText}
                  onChange={(e) => setJsonText(e.target.value)}
                  placeholder={`{\n  "name": "...",\n  "summary": "...",\n  "character": {},\n  "usage": { "rules": [], "antiRules": [] },\n  "copyExamples": {}\n}`}
                  rows={12}
                />
                <span className="field-hint">
                  Paste a complete authored direction object. <code>tokens</code>{" "}
                  are not accepted — they are generated.
                </span>
              </label>
            </div>
          ) : (
            <div className="create-direction-fields">
              <label className="explore-guidance">
                <span className="explore-guidance-label">Name *</span>
                <input
                  type="text"
                  className="textarea"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Bold & Modern"
                  required
                />
              </label>

              <label className="explore-guidance">
                <span className="explore-guidance-label">Summary *</span>
                <textarea
                  className="textarea"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="One-sentence characterisation of this direction."
                  rows={2}
                  required
                />
              </label>

              <label className="explore-guidance">
                <span className="explore-guidance-label">Positioning (optional)</span>
                <textarea
                  className="textarea"
                  value={positioning}
                  onChange={(e) => setPositioning(e.target.value)}
                  placeholder="How this direction is positioned in the market or relative to competitors."
                  rows={2}
                />
              </label>

              <fieldset className="create-direction-fieldset">
                <legend className="explore-guidance-label">Character (optional evocative descriptors — no hex codes or font names)</legend>
                {(
                  [
                    ["Mood", mood, setMood, "confident and editorial"],
                    ["Composition", composition, setComposition, "clean asymmetric grid"],
                    ["Layout", layout, setLayout, "generous whitespace, strong hierarchy"],
                    ["Imagery", imagery, setImagery, "abstract textures, bold shapes"],
                    ["Texture", texture, setTexture, "smooth, minimal"],
                    ["Rhythm", rhythm, setRhythm, "deliberate, measured pacing"],
                  ] as [string, string, React.Dispatch<React.SetStateAction<string>>, string][]
                ).map(([label, value, setter, placeholder]) => (
                  <label key={label} className="explore-guidance">
                    <span className="explore-guidance-label">{label}</span>
                    <input
                      type="text"
                      className="textarea"
                      value={value}
                      onChange={(e) => setter(e.target.value)}
                      placeholder={placeholder}
                    />
                  </label>
                ))}
              </fieldset>

              <label className="explore-guidance">
                <span className="explore-guidance-label">Usage rules (one per line)</span>
                <textarea
                  className="textarea"
                  value={rules}
                  onChange={(e) => setRules(e.target.value)}
                  placeholder={"Use bold headlines\nMaintain generous whitespace"}
                  rows={3}
                />
                <span className="field-hint">
                  When and how to apply this direction.
                </span>
              </label>

              <label className="explore-guidance">
                <span className="explore-guidance-label">Anti-rules (one per line)</span>
                <textarea
                  className="textarea"
                  value={antiRules}
                  onChange={(e) => setAntiRules(e.target.value)}
                  placeholder={"Avoid decorative ornaments\nDo not use more than two type sizes"}
                  rows={3}
                />
                <span className="field-hint">
                  What to avoid with this direction.
                </span>
              </label>

              <fieldset className="create-direction-fieldset">
                <legend className="explore-guidance-label">Copy examples (optional)</legend>
                {(
                  [
                    ["Headline", headline, setHeadline, "Make it count"],
                    ["Subheadline", subheadline, setSubheadline, "Design that works as hard as you do"],
                    ["CTA", cta, setCta, "Get started"],
                  ] as [string, string, React.Dispatch<React.SetStateAction<string>>, string][]
                ).map(([label, value, setter, placeholder]) => (
                  <label key={label} className="explore-guidance">
                    <span className="explore-guidance-label">{label}</span>
                    <input
                      type="text"
                      className="textarea"
                      value={value}
                      onChange={(e) => setter(e.target.value)}
                      placeholder={placeholder}
                    />
                  </label>
                ))}
              </fieldset>

              <label className="explore-guidance">
                <span className="explore-guidance-label">Style tile prompt (optional)</span>
                <textarea
                  className="textarea"
                  value={styleTilePrompt}
                  onChange={(e) => setStyleTilePrompt(e.target.value)}
                  placeholder="Describe the visual direction for the style tile. Leave blank to auto-generate."
                  rows={2}
                />
              </label>

              <label className="explore-guidance">
                <span className="explore-guidance-label">Homepage mockup prompt (optional)</span>
                <textarea
                  className="textarea"
                  value={homepageMockupPrompt}
                  onChange={(e) => setHomepageMockupPrompt(e.target.value)}
                  placeholder="Describe the homepage layout. Leave blank to auto-generate."
                  rows={2}
                />
              </label>
            </div>
          )}

          {error && <p className="action-error">{error}</p>}

          <div className="action-row">
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? "Creating…" : "Create direction"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
