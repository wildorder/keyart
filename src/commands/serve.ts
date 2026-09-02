import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadDashboardData } from "../ui/api.js";
import {
  createLocalOnlyGuard,
  createWriteApi,
  createTokensApi,
  createAssetServer,
  createUploadApi,
  createElementFeedbackApi,
  createActionsApi,
  createAssetActionsApi,
  createAssetPackApi,
  createJobsApi,
  createReconciliationApi,
  createSurfaceActionsApi,
  createSurfaceApi,
} from "../ui/server-api.js";
import { createSettingsApi } from "../ui/settings-api.js";
import { createArtifactStore } from "../store/artifact-store.js";
import { createJobStore, type JobStore } from "../ui/jobs.js";
import { createChatApi } from "../ui/chat-api.js";
import { loadEnvFiles } from "../env.js";
import { CommandError } from "../errors.js";
import {
  createRequestListener,
  createStaticFileHandler,
  bundleRoot,
  assertBundlePresent,
  type Mount,
} from "../ui/static-server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** The two Vite build-time modules `serve` needs, resolved at call time. */
export interface ViteDeps {
  createServer: typeof import("vite").createServer;
  react: typeof import("@vitejs/plugin-react").default;
}

/** Teaching error for an unresolvable vite toolchain (exported for tests). */
export const VITE_MISSING_MESSAGE =
  "The Keyart studio needs the Vite toolchain, which ships only with a repo checkout.\n" +
  "Clone the repo and install it:\n" +
  "  git clone https://github.com/wildorder/keyart.git && cd keyart && npm install\n" +
  "Every other Keyart command works from an installed package without it.";

/** Teaching error for `--dev` outside a repo checkout (no `src/ui`). */
export const DEV_UI_MISSING_MESSAGE =
  "`keyart serve --dev` needs a repo clone — src/ui was not found.\n" +
  "  git clone https://github.com/wildorder/keyart.git && cd keyart && npm install\n" +
  "Without a clone, run `keyart serve` (the prebuilt studio).";

/**
 * Resolves `vite` + `@vitejs/plugin-react` DYNAMICALLY.
 *
 * Both are devDependencies, so they are absent from an installed package. A
 * module-scope `import` of either kills the whole ESM chain before commander
 * ever parses argv — i.e. every command, not just `serve`. Importing them here
 * follows the Playwright precedent in `src/audit/capture-screenshot.ts`: an
 * unresolvable module becomes a teaching CommandError, never a raw
 * ERR_MODULE_NOT_FOUND stack trace.
 *
 * `importer` is injected only by tests, so the failure path is actually
 * exercised (both modules are present in a repo checkout).
 */
export async function loadViteDeps(
  importer: (specifier: string) => Promise<unknown> = (specifier) =>
    import(/* @vite-ignore */ specifier),
): Promise<ViteDeps> {
  try {
    const vite = (await importer("vite")) as typeof import("vite");
    const plugin = (await importer("@vitejs/plugin-react")) as {
      default: typeof import("@vitejs/plugin-react").default;
    };
    return { createServer: vite.createServer, react: plugin.default ?? (plugin as never) };
  } catch {
    throw new CommandError(VITE_MISSING_MESSAGE);
  }
}

/**
 * Every /api mount, in the EXACT order the vite runtime mounts them. The
 * local-only guard is index 0 and must stay there. Shared verbatim by both
 * runtimes (static mode composes it directly; dev mode loops it onto
 * `viteServer.middlewares.use`), so the two runtimes cannot drift apart.
 */
export function createApiMounts(opts: { cwd: string; jobs: JobStore }): Mount[] {
  const { cwd, jobs } = opts;
  const artifacts = createArtifactStore(cwd);

  async function handleAuditScreenshot(
    _req: Parameters<Mount["handler"]>[0],
    res: Parameters<Mount["handler"]>[1],
    next: Parameters<Mount["handler"]>[2],
  ): Promise<void> {
    try {
      const data = await loadDashboardData(cwd);
      if (!data.latestAudit?.screenshotPath) {
        res.statusCode = 404;
        res.end("No screenshot available");
        return;
      }
      // The handle resolves strictly under cwd (403 CommandError on escape).
      const screenshotPath = artifacts.resolveHandle(data.latestAudit.screenshotPath);
      const file = await fs.readFile(screenshotPath);
      res.setHeader("Content-Type", "image/png");
      res.end(file);
    } catch (err) {
      if (err instanceof CommandError && err.exitCode === 403) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }
      next();
    }
  }

  async function handleDashboard(
    _req: Parameters<Mount["handler"]>[0],
    res: Parameters<Mount["handler"]>[1],
  ): Promise<void> {
    try {
      const data = await loadDashboardData(cwd);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(data));
    } catch (e) {
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }

  return [
    { prefix: "/api", handler: createLocalOnlyGuard() },

    // Reconciliation list GETs must come before createWriteApi, which owns
    // the /api/concepts prefix for writes but next()s all GETs.
    { prefix: "/api", handler: createReconciliationApi({ cwd }) },

    { prefix: "/api", handler: createWriteApi({ cwd }) },

    // WS-06: server-side palette reroll (culori stays server-side) + the
    // curated font catalog. Mounted at /api behind the local-only guard;
    // it calls next() on any non-matching request so read/write/asset
    // middleware below still run.
    { prefix: "/api", handler: createTokensApi() },

    // Settings: read/write `keyart.config.ts` (project + models) and
    // the `.env.local` API key over the SAME builder the CLI init wizard
    // uses. Mounted at /api behind the local-only guard; it calls next()
    // on any non-/api/settings request so the middleware below still run.
    { prefix: "/api", handler: createSettingsApi({ cwd }) },

    // WS-02 (writable studio): traversal-safe asset serving + multipart
    // uploads. Mounted after the local-only guard (above), so both inherit it.
    { prefix: "/api/asset", handler: createAssetServer({ cwd }) },
    { prefix: "/api/uploads", handler: createUploadApi({ cwd }) },

    // Element feedback (studio crop UI): keep→AssetRef, discard→feedback
    // thumbnail, eyedropper hex→color lock. Serve-only — no MCP dispatch.
    { prefix: "/api/element-feedback", handler: createElementFeedbackApi({ cwd }) },

    // WS-08 (studio-surface-board): the surface-fill action, mounted
    // BEFORE createAssetActionsApi/createActionsApi (which 404 unknown
    // POST segments). Shares the single `jobs` store; kind "surface".
    { prefix: "/api/actions", handler: createSurfaceActionsApi({ cwd, jobs }) },

    // WS-05 (asset-extraction): the two long-running asset actions, mounted
    // BEFORE createActionsApi (which 404s unknown POST segments). Shares
    // the single `jobs` store.
    { prefix: "/api/actions", handler: createAssetActionsApi({ cwd, jobs }) },

    // WS-03: fire-and-poll long-running actions + job status. Both mount
    // behind the local-only guard (above) and share the single `jobs`
    // store, so a job kicked off by one request is pollable by later ones.
    { prefix: "/api/actions", handler: createActionsApi({ cwd, jobs }) },
    { prefix: "/api/jobs", handler: createJobsApi({ jobs }) },

    // WS-08 (studio-surface-board): slot curation (add/edit/retire) —
    // validated, versioned writes through createSurfaceCore. Not owned by
    // createWriteApi's OWNED_PREFIXES, so non-GET /api/surface/* requests
    // flow through to this mount.
    { prefix: "/api/surface", handler: createSurfaceApi({ cwd }) },

    // WS-03: the writable studio's chat surface — three routes reusing the
    // WS-02 agent loop verbatim, behind the SAME local-only guard and the
    // SAME shared `jobs` store. Never MCP-dispatchable; adds no command.
    { prefix: "/api/chat", handler: createChatApi({ cwd, jobs }) },

    // WS-05 (asset-extraction): the synchronous, keyless pack — no job,
    // deterministic and fast.
    { prefix: "/api/asset-pack", handler: createAssetPackApi({ cwd }) },

    { prefix: "/api/audit-screenshot", handler: (req, res, next) => void handleAuditScreenshot(req, res, next) },
    { prefix: "/api/dashboard", handler: (req, res) => void handleDashboard(req, res) },
  ];
}

export async function runServe(opts: {
  cwd: string;
  port?: number;
  dev?: boolean;
}): Promise<void> {
  const port = opts.port ?? 4317;
  const cwd = path.resolve(opts.cwd);

  // Load `.env` / `.env.keyart` / `.env.local` into process.env at startup, so
  // an OPENAI_API_KEY stored in `.env.local` (where `init` persists it) is visible
  // to the studio — the chat agent gates on `hasApiKey()`. Parity with every other
  // command (explore/regenerate/doctor/mcp all call this); a real inherited env var
  // is never overwritten.
  loadEnvFiles(cwd);

  // One in-process job store shared across every request for the life of the
  // server, so a job started by one request is pollable by later ones.
  const jobs = createJobStore();

  if (opts.dev === true) {
    await runDevServer({ cwd, port, jobs });
    return;
  }

  await runStaticServer({ cwd, port, jobs });
}

/** Static mode (the default): node:http fronted by the in-house composer, serving the prebuilt `dist/ui` bundle. */
async function runStaticServer(opts: { cwd: string; port: number; jobs: JobStore }): Promise<void> {
  const { cwd, port, jobs } = opts;

  const root = bundleRoot(__dirname);
  await assertBundlePresent(root);

  const mounts: Mount[] = [
    ...createApiMounts({ cwd, jobs }),
    { prefix: "/", handler: createStaticFileHandler({ root }) },
  ];
  const server = http.createServer(createRequestListener(mounts));

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new CommandError(`Port ${port} is already in use.`));
        return;
      }
      reject(err);
    });
    server.listen(port, "127.0.0.1", resolve);
  });

  console.log(`Keyart studio: http://localhost:${port}`);
  console.log("Press Ctrl+C to stop.");
}

/**
 * Resolves the `src/ui` root (contains `index.html`, `main.tsx`, etc.) that
 * `--dev` boots Vite against, probing both the compiled-dist and source-tree
 * layouts. `moduleDir` is this module's own directory (`__dirname` in
 * production; injected by tests). Neither candidate existing means there is
 * no repo checkout to fork against — a teaching error, not a Vite crash.
 */
export async function resolveDevUiRoot(moduleDir: string): Promise<string> {
  const fromDist = path.resolve(moduleDir, "../../src/ui");
  const fromSrc = path.resolve(moduleDir, "../ui");
  for (const candidate of [fromDist, fromSrc]) {
    try {
      await fs.access(path.join(candidate, "index.html"));
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new CommandError(DEV_UI_MISSING_MESSAGE);
}

/** Dev mode (`--dev`): today's Vite dev server against `src/ui`, byte-identical in behavior. */
async function runDevServer(opts: { cwd: string; port: number; jobs: JobStore }): Promise<void> {
  const { cwd, port, jobs } = opts;

  const { createServer, react } = await loadViteDeps();
  const uiRoot = await resolveDevUiRoot(__dirname);

  const mounts = createApiMounts({ cwd, jobs });

  const server = await createServer({
    root: uiRoot,
    configFile: false,
    server: {
      port,
      strictPort: true,
      host: "127.0.0.1",
    },
    plugins: [
      react(),
      {
        name: "keyart-api",
        configureServer(viteServer) {
          // Local-only, method-aware write layer. The studio is no longer
          // read-only: mutating /api/* requests dispatch to the same core
          // command functions the CLI uses. The local-only guard (DNS-
          // rebinding defense) is mount index 0 and runs first.
          for (const mount of mounts) {
            viteServer.middlewares.use(mount.prefix, mount.handler);
          }
        },
      },
    ],
  });

  await server.listen();

  // The studio accepts local writes (create/edit concepts, notes, rules,
  // promote) in addition to reads; it binds 127.0.0.1 with a strict port.
  console.log(`Keyart studio (dev): http://localhost:${port}`);
  console.log("Press Ctrl+C to stop.");
}
