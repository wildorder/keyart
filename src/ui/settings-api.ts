/**
 * The studio Settings surface: a local-only read/write layer over the same
 * config + env the `keyart init` config builder writes.
 *
 *  - GET  /api/settings — the current `project` + `models` (from
 *    `keyart.config.ts`), the framework choices, and the API-key STATUS
 *    (configured?  + a masked hint — never the raw key) plus whether
 *    `.env.local` is gitignored.
 *  - PUT  /api/settings — merges `{ project?, models? }` into the loaded config
 *    and rewrites `keyart.config.ts` (preserving every other field), and
 *    writes a non-empty `openaiApiKey` to `.env.local` (updating this process's
 *    env so live calls work without a restart).
 *
 * The raw API key is ACCEPTED on PUT only and is NEVER returned by GET — reads
 * only ever expose {@link maskSecret}'d hints. Config is re-read with a busted
 * import cache so a save is reflected without restarting the long-running server.
 */
import path from "node:path";
import { loadConfig } from "../config.js";
import { writeTextFile } from "../fs.js";
import { loadEnvFiles, upsertEnvFile, isGitignored } from "../env.js";
import { hasApiKey } from "../openai.js";
import { maskSecret } from "../secret-hint.js";
import {
  renderConfigFromObject,
  FRAMEWORK_CHOICES,
} from "../init/config-template.js";
import type { KeyartConfig } from "../types.js";
import {
  type ConnectHandler,
  fullPath,
  readJsonBody,
  sendJson,
  toHttpError,
} from "./server-api.js";

const ENV_LOCAL = ".env.local";

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/** A trimmed non-empty string, or undefined (so a blank field keeps the current value). */
function nonEmpty(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** The masked-key status block returned to the client (never the raw key). */
function keyStatus(): { configured: boolean; hint: string } {
  return {
    configured: hasApiKey(),
    hint: maskSecret(process.env.OPENAI_API_KEY ?? ""),
  };
}

/**
 * `GET /api/settings` + `PUT /api/settings`, mounted at `/api` behind the shared
 * local-only guard. Non-matching requests fall through via `next()`.
 */
export function createSettingsApi(opts: { cwd: string }): ConnectHandler {
  const { cwd } = opts;

  return (req, res, next) => {
    const method = req.method ?? "GET";
    if (fullPath(req) !== "/api/settings") {
      next();
      return;
    }

    if (method === "GET") {
      void handleGet(cwd, res).catch((err) => {
        const { status, body } = toHttpError(err);
        sendJson(res, status, body);
      });
      return;
    }

    if (method === "PUT") {
      void handlePut(cwd, req, res).catch((err) => {
        const { status, body } = toHttpError(err);
        sendJson(res, status, body);
      });
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
  };
}

async function handleGet(
  cwd: string,
  res: Parameters<ConnectHandler>[1],
): Promise<void> {
  // Fold any `.env*` key into process.env so the masked hint reflects a key set
  // via file (real env always wins; already-set values are left untouched).
  loadEnvFiles(cwd);
  const config = await loadConfig(cwd, { bustCache: true });
  sendJson(res, 200, {
    project: config.project,
    models: config.models,
    frameworkChoices: FRAMEWORK_CHOICES,
    openaiKey: keyStatus(),
    envLocalGitignored: await isGitignored(cwd, ENV_LOCAL),
  });
}

async function handlePut(
  cwd: string,
  req: Parameters<ConnectHandler>[0],
  res: Parameters<ConnectHandler>[1],
): Promise<void> {
  const body = asRecord(await readJsonBody(req));
  const config = await loadConfig(cwd, { bustCache: true });

  const projectPatch = asRecord(body.project);
  const modelsPatch = asRecord(body.models);

  const next: KeyartConfig = {
    ...config,
    project: {
      name: nonEmpty(projectPatch.name) ?? config.project.name,
      type: nonEmpty(projectPatch.type) ?? config.project.type,
      framework: nonEmpty(projectPatch.framework) ?? config.project.framework,
    },
    models: {
      text: nonEmpty(modelsPatch.text) ?? config.models.text,
      vision: nonEmpty(modelsPatch.vision) ?? config.models.vision,
      image: nonEmpty(modelsPatch.image) ?? config.models.image,
    },
  };

  await writeTextFile(
    path.join(cwd, "keyart.config.ts"),
    renderConfigFromObject(next),
  );

  // The raw key is accepted here (never returned). A blank field leaves the
  // existing key untouched — the UI only sends this when the user typed one.
  const apiKey = nonEmpty(body.openaiApiKey);
  let keyUpdated = false;
  if (apiKey !== undefined) {
    await upsertEnvFile(path.join(cwd, ENV_LOCAL), { OPENAI_API_KEY: apiKey });
    // Reflect it in THIS process so explore/approve/audit go live immediately.
    process.env.OPENAI_API_KEY = apiKey;
    keyUpdated = true;
  }

  // The write always succeeds; `envLocalGitignored: false` lets the client warn
  // (without failing the save) when a just-written key would be committed.
  sendJson(res, 200, {
    ok: true,
    project: next.project,
    models: next.models,
    keyUpdated,
    openaiKey: keyStatus(),
    envLocalGitignored: await isGitignored(cwd, ENV_LOCAL),
  });
}
