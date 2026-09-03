import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { type ConnectHandler, fullPath, sendJson, resolveUnderCwd } from "./server-api.js";
import { CommandError } from "../errors.js";

/**
 * The raw request pathname (query stripped), deliberately NOT run through
 * `fullPath`'s `new URL()` parse: WHATWG URL parsing collapses `..` dot
 * segments (RFC 3986 5.2.4) before our own traversal check ever sees them,
 * which would silently neutralize the very attack {@link resolveUnderCwd} is
 * meant to catch and refuse with an explicit 403. Node's raw `req.url` is
 * never dot-segment-normalized by the HTTP parser, so reading it directly
 * (and decoding only afterward, per step 3) keeps a literal `../` or an
 * encoded `%2e%2e%2f` intact all the way to the containment check.
 */
function rawPathname(req: { originalUrl?: string; url?: string }): string {
  const raw = req.originalUrl ?? req.url ?? "/";
  const qIndex = raw.indexOf("?");
  return qIndex === -1 ? raw : raw.slice(0, qIndex);
}

/** One middleware mounted at a path prefix — the `viteServer.middlewares.use(prefix, h)` shape. */
export interface Mount {
  prefix: string;
  handler: ConnectHandler;
}

/** True iff `pathname` is at or under `prefix` ("/api" matches "/api" and "/api/x", not "/apix"). */
export function matchesPrefix(pathname: string, prefix: string): boolean {
  if (prefix === "/") return true;
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/**
 * Composes connect-style middleware into a `node:http` request listener — the
 * ~30 lines that replace connect/express/sirv. Deliberately does NOT rewrite
 * `req.url` (unlike connect): every handler in this codebase resolves its path
 * through `fullPath(req)` against the FULL `/api/...` path, so leaving the url
 * intact is what makes them mount verbatim in both runtimes.
 *
 * A handler that calls `next()` yields to the next matching mount; falling off
 * the end is a 404. A synchronous throw (or a `next(err)`) is a 500 — nothing
 * is allowed to take the process down.
 */
export function createRequestListener(
  mounts: Mount[],
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const pathname = fullPath(req);
    const matching = mounts.filter((m) => matchesPrefix(pathname, m.prefix));
    let i = 0;
    const next = (err?: unknown): void => {
      if (err !== undefined) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const mount = matching[i++];
      if (mount === undefined) {
        sendJson(res, 404, { error: `Not found: ${pathname}` });
        return;
      }
      try {
        mount.handler(req, res, next);
      } catch (e) {
        next(e);
      }
    };
    next();
  };
}

// ---------------------------------------------------------------------------
// Static file handler
// ---------------------------------------------------------------------------

/** MIME types the studio bundle needs. Deliberately separate from server-api's
 *  image-only CONTENT_TYPES, which serves user assets rather than the bundle. */
const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export function staticContentTypeFor(ext: string): string {
  return STATIC_CONTENT_TYPES[ext.toLowerCase()] ?? "application/octet-stream";
}

/** True iff `abs` (already `fs.realpath`-resolved) stays at or under `realRoot`. */
function isContainedRealpath(abs: string, realRoot: string): boolean {
  return abs === realRoot || abs.startsWith(realRoot + path.sep);
}

async function serveFile(
  res: ServerResponse,
  method: string,
  abs: string,
  isAsset: boolean,
): Promise<void> {
  const stat = await fs.stat(abs);
  res.setHeader("Content-Type", staticContentTypeFor(path.extname(abs)));
  res.setHeader("Content-Length", String(stat.size));
  res.setHeader(
    "Cache-Control",
    isAsset ? "public, max-age=31536000, immutable" : "no-cache",
  );
  res.statusCode = 200;
  if (method === "HEAD") {
    res.end();
    return;
  }
  const body = await fs.readFile(abs);
  res.end(body);
}

async function serveIndexFallback(res: ServerResponse, method: string, root: string): Promise<void> {
  const indexPath = path.join(root, "index.html");
  try {
    await serveFile(res, method, indexPath, false);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

/**
 * Traversal-contained static file handler over `opts.root` (the built studio
 * bundle), with an SPA fallback to `index.html` for non-`/api` GETs. See
 * step 2 of the workstream spec for the exact behavior ladder.
 */
export function createStaticFileHandler(opts: { root: string }): ConnectHandler {
  const { root } = opts;

  return (req, res, next) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      next();
      return;
    }

    const pathname = rawPathname(req);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      next();
      return;
    }

    void (async () => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathname);
      } catch {
        sendJson(res, 400, { error: "Bad request" });
        return;
      }

      // Strip exactly one leading "/". What remains must be RELATIVE under
      // BOTH platforms' rules — checked explicitly against posix AND win32
      // (not just the host platform's), because e.g. "C:/Windows/win.ini" is
      // absolute on Windows but a legal relative segment on Linux: without the
      // cross-platform check the same URL would 403 on one OS and fall through
      // to the SPA fallback on the other. Refusing both forms everywhere keeps
      // the handler's security behavior byte-identical across platforms.
      const relative = decoded.startsWith("/") ? decoded.slice(1) : decoded;
      if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) {
        sendJson(res, 403, { error: "Forbidden path" });
        return;
      }

      let abs: string;
      try {
        abs = resolveUnderCwd(root, relative);
      } catch (e) {
        if (e instanceof CommandError) {
          sendJson(res, 403, { error: "Forbidden path" });
          return;
        }
        throw e;
      }

      const realRoot = await fs.realpath(root);
      let realAbs: string | undefined;
      try {
        realAbs = await fs.realpath(abs);
      } catch {
        realAbs = undefined;
      }

      if (realAbs !== undefined) {
        if (!isContainedRealpath(realAbs, realRoot)) {
          sendJson(res, 403, { error: "Forbidden path" });
          return;
        }

        const stat = await fs.stat(realAbs);
        if (stat.isFile()) {
          const relFromRoot = path.relative(root, abs);
          const isAsset = relFromRoot.split(path.sep)[0] === "assets";
          await serveFile(res, method, realAbs, isAsset);
          return;
        }
      }

      // Missing file, or a directory: SPA fallback.
      await serveIndexFallback(res, method, root);
    })().catch((e: unknown) => {
      next(e);
    });
  };
}

// ---------------------------------------------------------------------------
// Bundle presence check
// ---------------------------------------------------------------------------

/** Absolute path to the shipped studio bundle, resolved from this module's location. */
export function bundleRoot(moduleDir: string): string {
  // dist/commands/serve.js → dist/ui ; also correct for dist/ui/static-server.js callers
  return path.resolve(moduleDir, "../ui");
}

export const STUDIO_BUNDLE_MISSING_MESSAGE =
  "The studio bundle is missing (no dist/ui/index.html).\n" +
  "Run `npm run build` to build it, or use `keyart serve --dev` in a repo clone.";

/** Throws a teaching CommandError when the prebuilt studio is absent. */
export async function assertBundlePresent(root: string): Promise<void> {
  try {
    await fs.access(path.join(root, "index.html"));
  } catch {
    throw new CommandError(STUDIO_BUNDLE_MISSING_MESSAGE);
  }
}
