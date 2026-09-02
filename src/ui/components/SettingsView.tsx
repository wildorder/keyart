/**
 * Project settings — a studio front-end over the same config the `keyart
 * init` wizard builds. Reads `GET /api/settings` on mount and saves via
 * `PUT /api/settings`:
 *
 *  - Project    → name / type / framework, written to `keyart.config.ts`.
 *  - Models     → text / vision / image model ids (blank = keep current).
 *  - OpenAI key → written to `.env.local`; the current key is shown only as a
 *    masked hint (never the raw value), and a blank field leaves it untouched.
 *
 * Saving without a key still rewrites the config; a key that lands in a
 * non-gitignored `.env.local` surfaces a warning toast (the save still succeeds).
 */
import React, { useEffect, useState } from "react";
import type { SettingsData } from "../types";
import { putJson } from "../hooks";
import { settingsReadRequest, settingsUpdateRequest } from "../direction-actions.js";
import { useToasts } from "./Toasts";

interface FormState {
  name: string;
  type: string;
  framework: string;
  text: string;
  vision: string;
  image: string;
  apiKey: string;
}

function toForm(data: SettingsData): FormState {
  return {
    name: data.project.name,
    type: data.project.type,
    framework: data.project.framework,
    text: data.models.text,
    vision: data.models.vision,
    image: data.models.image,
    apiKey: "",
  };
}

export function SettingsView() {
  const { pushToast } = useToasts();
  const [data, setData] = useState<SettingsData | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(settingsReadRequest().path)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<SettingsData>;
      })
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setForm(toForm(d));
        setLoadError(null);
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => (f === null ? f : { ...f, [key]: value }));

  const save = async () => {
    if (form === null || saving) return;
    setSaving(true);
    try {
      const apiKey = form.apiKey.trim();
      const req = settingsUpdateRequest({
        project: { name: form.name, type: form.type, framework: form.framework },
        models: { text: form.text, vision: form.vision, image: form.image },
        ...(apiKey !== "" ? { openaiApiKey: apiKey } : {}),
      });
      const result = await putJson<SettingsData & { keyUpdated: boolean }>(
        req.path,
        req.body,
      );
      const nextData: SettingsData = {
        project: result.project,
        models: result.models,
        frameworkChoices: data?.frameworkChoices ?? [],
        openaiKey: result.openaiKey,
        envLocalGitignored: result.envLocalGitignored,
      };
      setData(nextData);
      setForm(toForm(nextData));
      pushToast({ kind: "success", message: "Settings saved." });
      if (result.keyUpdated && !result.envLocalGitignored) {
        pushToast({
          kind: "error",
          message:
            "API key saved, but .env.local is NOT gitignored — add it to .gitignore so your key is not committed.",
        });
      }
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : "Could not save settings.",
      });
    } finally {
      setSaving(false);
    }
  };

  if (loadError !== null) {
    return (
      <section id="settings" className="section">
        <h2>Settings</h2>
        <div className="empty-state">Could not load settings: {loadError}</div>
      </section>
    );
  }

  if (data === null || form === null) {
    return (
      <section id="settings" className="section">
        <h2>Settings</h2>
        <div className="empty-state">Loading settings…</div>
      </section>
    );
  }

  return (
    <section id="settings" className="section">
      <h2>Settings</h2>
      <p className="section-note">
        Configure this project the same way <code>keyart init</code> does —
        the project details, which OpenAI models to use, and your API key.
      </p>

      {/* Project ---------------------------------------------------------- */}
      <div className="settings-group">
        <h3>Project</h3>
        <div className="field">
          <label className="label" htmlFor="settings-name">
            Project name
          </label>
          <input
            id="settings-name"
            className="input"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="settings-type">
            Project type
          </label>
          <input
            id="settings-type"
            className="input"
            value={form.type}
            placeholder="e.g. prototype"
            onChange={(e) => set("type", e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="settings-framework">
            Framework
          </label>
          <select
            id="settings-framework"
            className="select"
            value={form.framework}
            onChange={(e) => set("framework", e.target.value)}
          >
            {/* Include the current value even if it's not a catalog choice. */}
            {(data.frameworkChoices.includes(form.framework)
              ? data.frameworkChoices
              : [form.framework, ...data.frameworkChoices]
            ).map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Models ----------------------------------------------------------- */}
      <div className="settings-group">
        <h3>Models</h3>
        <p className="field-hint">
          OpenAI model ids. Leave a field as-is to keep the current model.
        </p>
        <div className="field">
          <label className="label" htmlFor="settings-text">
            Text model
          </label>
          <input
            id="settings-text"
            className="input"
            value={form.text}
            onChange={(e) => set("text", e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="settings-vision">
            Vision model
          </label>
          <input
            id="settings-vision"
            className="input"
            value={form.vision}
            onChange={(e) => set("vision", e.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="settings-image">
            Image model
          </label>
          <input
            id="settings-image"
            className="input"
            value={form.image}
            onChange={(e) => set("image", e.target.value)}
          />
        </div>
      </div>

      {/* API key ---------------------------------------------------------- */}
      <div className="settings-group">
        <h3>OpenAI API key</h3>
        <p className="field-hint">
          {data.openaiKey.configured ? (
            <>
              A key is configured (<code>{data.openaiKey.hint}</code>). Live model
              calls are enabled.
            </>
          ) : (
            <>
              No key set — commands run in <strong>dry-run</strong> mode
              (placeholders, no network). Add a key to enable live output.
            </>
          )}
        </p>
        {!data.envLocalGitignored && (
          <p className="field-error">
            Warning: <code>.env.local</code> is not gitignored — a saved key
            could be committed. Add <code>.env.local</code> to{" "}
            <code>.gitignore</code> first.
          </p>
        )}
        <div className="field">
          <label className="label" htmlFor="settings-apikey">
            {data.openaiKey.configured ? "Replace API key" : "Set API key"}
          </label>
          <input
            id="settings-apikey"
            className="input"
            type="password"
            autoComplete="off"
            value={form.apiKey}
            placeholder={
              data.openaiKey.configured
                ? "Enter a new key to replace the current one"
                : "sk-…"
            }
            onChange={(e) => set("apiKey", e.target.value)}
          />
          <p className="field-hint">
            Written to <code>.env.local</code>. Leave blank to keep the current
            key.
          </p>
        </div>
      </div>

      <div className="settings-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving}
          onClick={save}
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </section>
  );
}
