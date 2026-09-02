import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import busboy from "busboy";
import { loadConfig, directionsRoot } from "../config.js";
import { CommandError } from "../errors.js";
import { VersionConflictError } from "../store/versioned-store.js";
import { ensureDir, pathExists, readTextFile, writeJsonFile } from "../fs.js";
import { createDirectionCore } from "../direction/core.js";
import { renderBrief } from "../direction/render-brief.js";
import { BrandBriefSchema, type BrandBriefPatch } from "../direction/schema.js";
import { proposeBriefPatch } from "../direction/brief-map.js";
import {
  runDirection,
  runDirectionNew,
  runDirectionFork,
  runRule,
  runPromote,
  runReconcileResolve,
  ReconciliationPartialError,
} from "../commands/direction.js";
import { createBrandCore } from "../brand/core.js";
import { PromotePartialError } from "../brand/promote-to-global.js";
import type { Contradiction } from "../brand/conflict-guard.js";
import type { ReconcileAction } from "../direction/reconcile.js";
import type { RuleSeverity } from "../brand/schema.js";
import { runExplore } from "../commands/explore.js";
import { runApprove } from "../commands/approve.js";
import { runAudit } from "../commands/audit.js";
import { runRegenerateVisuals } from "../commands/regenerate-visuals.js";
import {
  runEditDirection,
  runSaveVariant,
  type DirectionEdits,
} from "../commands/edit-direction.js";
import { createAuthoredDirection } from "../explore/create-direction.js";
import { rerollPalette } from "../brand/palette.js";
import { FONT_PAIRINGS } from "../brand/fonts.js";
import type { AssetRef, ReferenceIntent } from "../direction/schema.js";
import type { DirectionTokens, PaletteRole, PaletteToken } from "../types.js";
import type { JobStore } from "./jobs.js";
import { runAssetExtract, runAssetRegenerate } from "../asset/extract.js";
import { runAssetPack } from "../asset/pack.js";
import {
  listAssetIds,
  readAssetIndex,
  retireExtractedAsset,
} from "../asset/asset-store.js";
import { AssetSourceImageSchema, type AssetSourceImage } from "../asset/schema.js";
import { createSurfaceCore, SLOT_ORIGINS, type SlotOrigin, type SlotPatch } from "../surface/store.js";
import { isSlotRetired, type SlotKind, type SurfaceSlot } from "../surface/schema.js";
import { runSurfaceFill } from "../surface/fill.js";
import {
  runSurfaceScan,
  surfaceScanDir,
  candidateToSlot,
  type ScanProposal,
} from "../surface/scan.js";

/**
 * Connect-style middleware handler. Vite mounts these via
 * `viteServer.middlewares.use(path, handler)`.
 *
 * NOTE: connect rewrites `req.url` to be relative to the mount point, but
 * preserves the full original path on `req.originalUrl`. Every path/query parse
 * in this module MUST go through {@link fullPath} / {@link fullUrl} so matching
 * works against the true `/api/...` path regardless of the mount prefix.
 */
export type ConnectHandler = (
  req: IncomingMessage & { originalUrl?: string },
  res: ServerResponse,
  next: (err?: unknown) => void,
) => void;

const DEFAULT_BODY_LIMIT = 1_000_000;
const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

// ---------------------------------------------------------------------------
// Request/response helpers
// ---------------------------------------------------------------------------

/** Full request URL (never the connect prefix-stripped `req.url`). */
export function fullUrl(req: { originalUrl?: string; url?: string }): URL {
  return new URL(req.originalUrl ?? req.url ?? "/", "http://localhost");
}

/** Full request pathname (see {@link fullUrl}). */
export function fullPath(req: { originalUrl?: string; url?: string }): string {
  return fullUrl(req).pathname;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export function toHttpError(err: unknown): {
  status: number;
  body: { error: string; code?: string };
} {
  if (err instanceof VersionConflictError) {
    return { status: 409, body: { error: err.message, code: "version_conflict" } };
  }
  if (err instanceof ReconciliationPartialError) {
    return { status: 409, body: { error: err.message, ...err.payload } };
  }
  if (err instanceof PromotePartialError) {
    // The residual second-write race on `direction memory promote --to global`
    // (WS-03's seam): the global rule committed but retiring the source memory
    // entry raced. Honest by construction — never a rollback/atomicity claim.
    const payload = {
      code: "promote_partial" as const,
      committed: err.committed,
      ruleId: err.ruleId,
      globalVersion: err.globalVersion,
      expectedMemoryVersion: err.expectedMemoryVersion,
      actualMemoryVersion: err.actualMemoryVersion,
      retryable: err.retryable,
    };
    return { status: 409, body: { error: err.message, ...payload } };
  }
  if (err instanceof CommandError) {
    // A CommandError may carry an HTTP status in `exitCode` (e.g. 403 from
    // `resolveUnderCwd`, 413 from `readJsonBody`). Honor it when it is a valid
    // HTTP status; otherwise the default CLI exit code (1) maps to 400.
    const status =
      err.exitCode >= 400 && err.exitCode <= 599 ? err.exitCode : 400;
    return { status, body: { error: err.message } };
  }
  return {
    status: 500,
    body: { error: err instanceof Error ? err.message : String(err) },
  };
}

/**
 * Reads and JSON-parses a request body. Enforces a byte cap (default 1 MB),
 * throwing a 413 `CommandError` when exceeded. An empty body parses to `{}`.
 * Invalid JSON throws a 400 `CommandError`.
 */
export function readJsonBody(
  req: IncomingMessage,
  opts?: { limit?: number },
): Promise<unknown> {
  const limit = opts?.limit ?? DEFAULT_BODY_LIMIT;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > limit) {
        aborted = true;
        reject(new CommandError("Request body too large", 413));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (raw === "") {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new CommandError("Invalid JSON body"));
      }
    });

    req.on("error", (err) => {
      if (aborted) return;
      aborted = true;
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Local-only guard
// ---------------------------------------------------------------------------

/** Extracts the hostname from a `Host`/`Origin`-style header value. */
function hostnameOf(header: string): string | null {
  const value = header.trim();
  if (value === "") return null;
  // Bracketed IPv6, e.g. "[::1]:4317" or "[::1]".
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    return close === -1 ? value : value.slice(0, close + 1);
  }
  // "host:port" — strip the port (IPv4/hostname only; IPv6 handled above).
  const colon = value.indexOf(":");
  return colon === -1 ? value : value.slice(0, colon);
}

function isLocalHostname(hostname: string | null): boolean {
  if (hostname === null) return false;
  return LOCAL_HOSTNAMES.has(hostname);
}

/**
 * True iff the request originates from localhost. A missing `Host` is rejected;
 * a missing `Origin` is allowed (non-browser/local tools), but a present
 * `Origin` must also be local (DNS-rebinding defense).
 */
export function isLocalHost(
  hostHeader?: string,
  originHeader?: string,
): boolean {
  if (hostHeader === undefined || !isLocalHostname(hostnameOf(hostHeader))) {
    return false;
  }
  if (originHeader !== undefined) {
    let originHost: string | null;
    try {
      originHost = new URL(originHeader).hostname;
    } catch {
      return false;
    }
    // URL.hostname returns bracket-less IPv6 (e.g. "::1"); normalize the
    // bracketed form too.
    if (!isLocalHostname(originHost) && !isLocalHostname(`[${originHost}]`)) {
      return false;
    }
  }
  return true;
}

/**
 * Middleware rejecting any non-local request (bad `Host` or cross-origin
 * `Origin`) with a 403; local requests fall through via `next()`.
 */
export function createLocalOnlyGuard(): ConnectHandler {
  return (req, res, next) => {
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (!isLocalHost(host, typeof origin === "string" ? origin : undefined)) {
      sendJson(res, 403, {
        error: "Forbidden — the Keyart studio only accepts local requests.",
      });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Write-route middleware
// ---------------------------------------------------------------------------

/** Route prefixes WS-01 owns; a mutating request under these that matches no
 * route is a 404. Anything else falls through to downstream middleware. */
const OWNED_PREFIXES = ["/api/directions", "/api/rules", "/api/promote"];

/**
 * The canonical `"<METHOD> <path-template>"` list for every resource + fork +
 * create route (WS-18). The route-table test asserts directly over this: no
 * template contains the `directions` segment twice, and none contains the old
 * parent segment.
 */
export const RESOURCE_ROUTE_TEMPLATES: readonly string[] = [
  "POST /api/directions",
  "POST /api/directions/:sourceId/create",
  "POST /api/directions/:sourceId/fork",
  "POST /api/directions/:id/versions",
  "PUT /api/directions/:id",
  "POST /api/directions/:id/feedback",
  "PATCH /api/directions/:id/brief",
  "POST /api/directions/:id/brief/map",
  "POST /api/directions/:id/brief/lock",
  "GET /api/directions/:id/reconciliation",
  "POST /api/directions/:id/reconciliation/resolve",
  "PATCH /api/directions/:id/memory/:entryId",
  "DELETE /api/directions/:id/memory/:entryId",
  "POST /api/directions/:id/memory/:entryId/promote",
  "DELETE /api/directions/:id/assets",
  "DELETE /api/directions/:id/extracted-assets/:assetId",
];

function isOwnedPath(pathname: string): boolean {
  return OWNED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}

/** cwd-relative, forward-slash path (matches the command result contract). */
function relTo(cwd: string, abs: string): string {
  return path.relative(path.resolve(cwd), abs).split(path.sep).join("/");
}

const FEEDBACK_RE = /^\/api\/directions\/([^/]+)\/feedback$/;
const BRIEF_RE = /^\/api\/directions\/([^/]+)\/brief$/;
const BRIEF_MAP_RE = /^\/api\/directions\/([^/]+)\/brief\/map$/;
const BRIEF_LOCK_RE = /^\/api\/directions\/([^/]+)\/brief\/lock$/;

/**
 * The canonical whitelist of settable brief field names, derived from
 * {@link BrandBriefSchema} so it can never drift (the same derivation WS-02's
 * `BRAND_BRIEF_FIELDS` and WS-03's mapper use). Deriving locally avoids importing
 * the heavy `src/commands/direction.ts` command module into the server bundle.
 */
const BRIEF_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(BrandBriefSchema.removeDefault().shape),
);
// Authored create + fork: parallel single-source routes (C-4i — the old
// two-level nesting is COLLAPSED, never renamed; no route carries the
// `directions` segment twice).
const CREATE_RE = /^\/api\/directions\/([^/]+)\/create$/;
const FORK_RE = /^\/api\/directions\/([^/]+)\/fork$/;
// Version-addressed direction routes: the head is edited in place, and a new
// version is appended under `…/versions` — ONE id, the aggregate root.
const DIRECTION_RE = /^\/api\/directions\/([^/]+)$/;
const DIRECTION_VERSIONS_RE = /^\/api\/directions\/([^/]+)\/versions$/;
const RECONCILIATION_RE = /^\/api\/directions\/([^/]+)\/reconciliation$/;
const RECONCILIATION_RESOLVE_RE = /^\/api\/directions\/([^/]+)\/reconciliation\/resolve$/;

// Memory/asset/rule lifecycle routes (WS-05: EDIT/PROMOTE/DELETE) — thin
// adapters over the WS-02/WS-03 core + the WS-04 `runDirection`/`runRule`
// orchestrators. MEMORY_PROMOTE_RE is checked before MEMORY_ENTRY_RE.
const MEMORY_ENTRY_RE = /^\/api\/directions\/([^/]+)\/memory\/([^/]+)$/;
const MEMORY_PROMOTE_RE = /^\/api\/directions\/([^/]+)\/memory\/([^/]+)\/promote$/;
const ASSETS_RE = /^\/api\/directions\/([^/]+)\/assets$/;
const RULE_RE = /^\/api\/rules\/([^/]+)$/;
// WS-05 (asset-extraction): retire an extracted asset — the non-destructive
// `retiredAt` marker. Lives inside dispatch() (not a later mount) because
// /api/directions is an OWNED_PREFIXES prefix; an unmatched owned path 404s.
const EXTRACTED_ASSET_RE = /^\/api\/directions\/([^/]+)\/extracted-assets\/([^/]+)$/;

function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/**
 * Shallow-parse a `tokens` object off a request body. Only the coarse shape is
 * checked here (palette array + typography + shape objects); the authoritative
 * validation (seven roles, catalog fonts, valid hexes) lives in the core's
 * `applyEdits`/`validateTokens`, so a malformed token set is rejected there with
 * a descriptive CommandError rather than silently dropped.
 */
function parseTokens(v: unknown): DirectionTokens | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (
    !Array.isArray(o.palette) ||
    !o.typography ||
    typeof o.typography !== "object" ||
    !o.shape ||
    typeof o.shape !== "object"
  ) {
    return undefined;
  }
  return o as unknown as DirectionTokens;
}

/** Build a {@link DirectionEdits} from a request body (string/array/token fields). */
function parseDirectionEdits(body: Record<string, unknown>): DirectionEdits {
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;
  const arr = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  const copyRaw =
    body.copyExamples && typeof body.copyExamples === "object"
      ? (body.copyExamples as Record<string, unknown>)
      : undefined;
  // The studio sends nested structured `character` (six optional strings) +
  // `usage` ({rules,antiRules}) objects — the WS-05 replacement for the old
  // freeform visualStyle/designRules/antiRules edit fields.
  const charRaw =
    body.character && typeof body.character === "object"
      ? (body.character as Record<string, unknown>)
      : undefined;
  const usageRaw =
    body.usage && typeof body.usage === "object"
      ? (body.usage as Record<string, unknown>)
      : undefined;
  return {
    name: str(body.name),
    summary: str(body.summary),
    positioning: str(body.positioning),
    character: charRaw
      ? {
          mood: str(charRaw.mood),
          composition: str(charRaw.composition),
          layout: str(charRaw.layout),
          imagery: str(charRaw.imagery),
          texture: str(charRaw.texture),
          rhythm: str(charRaw.rhythm),
        }
      : undefined,
    usage: usageRaw
      ? {
          rules: arr(usageRaw.rules) ?? [],
          antiRules: arr(usageRaw.antiRules) ?? [],
        }
      : undefined,
    styleTilePrompt: str(body.styleTilePrompt),
    homepageMockupPrompt: str(body.homepageMockupPrompt),
    copyExamples: copyRaw
      ? {
          headline: str(copyRaw.headline),
          subheadline: str(copyRaw.subheadline),
          cta: str(copyRaw.cta),
        }
      : undefined,
    tokens: parseTokens(body.tokens),
  };
}

/**
 * The write API: thin adapters over the already-tested core command functions.
 * No business logic is duplicated here — routes parse a JSON body and dispatch.
 */
export function createWriteApi(opts: { cwd: string }): ConnectHandler {
  const { cwd } = opts;

  return (req, res, next) => {
    const method = req.method ?? "GET";
    // Read endpoints are handled downstream (dashboard/audit-screenshot).
    if (method === "GET" || method === "HEAD") {
      next();
      return;
    }

    const pathname = fullPath(req);

    // Not a WS-01-owned path (e.g. /api/uploads, /api/actions/*) — let the
    // downstream middleware (WS-02/03) handle it.
    if (!isOwnedPath(pathname)) {
      next();
      return;
    }

    void dispatch(method, pathname, req, res, cwd).catch((err) => {
      const { status, body } = toHttpError(err);
      sendJson(res, status, body);
    });
  };
}

async function dispatch(
  method: string,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  cwd: string,
): Promise<void> {
  // POST /api/directions — the draft-aware create route: mints a DRAFT
  // (record + brief.md + empty memory.yaml, zero versions) via WS-15's
  // runDirectionNew. 201 with the draft summary.
  if (method === "POST" && pathname === "/api/directions") {
    const body = asRecord(await readJsonBody(req));
    const result = await runDirectionNew({
      cwd,
      name: body.name as string | undefined,
      describe: body.describe as string | undefined,
    });
    sendJson(res, 201, result);
    return;
  }

  // POST /api/directions/:id/feedback
  const feedbackMatch = pathname.match(FEEDBACK_RE);
  if (feedbackMatch && method === "POST") {
    const id = decodeURIComponent(feedbackMatch[1]);
    const body = asRecord(await readJsonBody(req));
    const result = await runDirection({
      cwd,
      verb: "feedback",
      id,
      body: body.body as string | undefined,
      kind: body.kind as string | undefined,
      author: body.author as string | undefined,
      force: body.force as boolean | undefined,
      source: "serve",
      channel: body.channel as string | undefined,
      polarity: body.polarity as string | undefined,
    });
    sendJson(res, 200, result);
    return;
  }

  // POST /api/directions/:id/brief/map — the OPTIONAL "map a ramble → propose
  // fields" affordance. Returns the WS-03 mapper's PROPOSAL (patch + hexLocks +
  // dryRun) WITHOUT applying it; the client previews and the user confirms. With
  // no key the proposal is empty (dryRun) — this NEVER throws/500s (SC-09).
  // Checked BEFORE BRIEF_RE (its path is a superset that BRIEF_RE would not match
  // anyway, but keep the specific routes first).
  const briefMapMatch = pathname.match(BRIEF_MAP_RE);
  if (briefMapMatch && method === "POST") {
    const id = decodeURIComponent(briefMapMatch[1]);
    const body = asRecord(await readJsonBody(req));
    const freeform = typeof body.freeform === "string" ? body.freeform : "";
    const config = await loadConfig(cwd);
    const core = createDirectionCore(cwd, config);
    const current = await core.getBrief(id); // 400 (CommandError) for a missing direction
    const proposal = await proposeBriefPatch({
      model: config.models.text,
      freeform,
      current,
    });
    sendJson(res, 200, proposal);
    return;
  }

  // POST /api/directions/:id/brief/lock — apply a proposed (or hand-picked) hex as
  // an attributed direction color LOCK via core (a `decision` memory entry). This is
  // where a hex the user typed into the form routes — NEVER stored as a brief
  // field (SC-06). No existing color-lock route is reachable from this brief flow
  // (`/api/element-feedback` is the crop-UI multipart path), so this is the
  // explicit JSON lock endpoint the map/lock affordance uses.
  const briefLockMatch = pathname.match(BRIEF_LOCK_RE);
  if (briefLockMatch && method === "POST") {
    const id = decodeURIComponent(briefLockMatch[1]);
    const body = asRecord(await readJsonBody(req));
    // A present-but-invalid hex is a 400; absent ⇒ null (a lock needs a hex).
    const hex = normalizeHex(typeof body.hex === "string" ? body.hex : undefined);
    if (hex === null) {
      throw new CommandError("A color lock requires a `hex` color.");
    }
    const note =
      typeof body.note === "string" && body.note.trim() !== ""
        ? body.note.trim()
        : undefined;
    const config = await loadConfig(cwd);
    const core = createDirectionCore(cwd, config);
    // direction-local by construction (WS-04 moodboard/brief invariant)
    await core.recordColorLock(id, {
      hex,
      author: "serve",
      source: "serve",
      ...(note ? { note } : {}),
    });
    sendJson(res, 201, { ok: true, id, hex });
    return;
  }

  // PATCH /api/directions/:id/brief — the versioned field write. Body is the
  // canonical wrapper `{ patch: BrandBriefPatch; expectedVersion? }` (NOT a bare
  // patch). Dispatches to `core.setBriefFields` (which rewrites the `brief.md`
  // projection), so no raw-markdown overwrite path remains. Unknown fields → 400;
  // a stale `expectedVersion` surfaces as 409 via `toHttpError`.
  const briefMatch = pathname.match(BRIEF_RE);
  if (briefMatch && method === "PATCH") {
    const id = decodeURIComponent(briefMatch[1]);
    const body = asRecord(await readJsonBody(req));
    const patch = body.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw new CommandError(
        "Brief PATCH requires a `patch` object of brief fields.",
      );
    }
    const unknown = Object.keys(patch).filter((k) => !BRIEF_FIELDS.has(k));
    if (unknown.length > 0) {
      throw new CommandError(
        `Unknown brief field(s): ${unknown.join(", ")}. Valid fields: ${[
          ...BRIEF_FIELDS,
        ].join(", ")}.`,
      );
    }
    const expectedVersion =
      typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;
    const config = await loadConfig(cwd);
    const core = createDirectionCore(cwd, config);
    const record = await core.setBriefFields(id, patch as BrandBriefPatch, {
      expectedVersion,
    });
    // Re-seed the client without a full reload: the structured brief, its
    // markdown projection, and the new version (for the next optimistic write).
    sendJson(res, 200, {
      brief: record.brief,
      renderedBrief: renderBrief(record.brief),
      version: record.version,
    });
    return;
  }

  // POST /api/directions/:sourceId/create — mint a NEW authored direction at v1
  // seeded by :sourceId, mirroring the CLI's `direction create '<json>' --from
  // <id>` (SC-08 re-spell). The raw body is passed straight to the core
  // (createAuthoredDirection is the single validation owner).
  const createMatch = pathname.match(CREATE_RE);
  if (createMatch && method === "POST") {
    const sourceId = decodeURIComponent(createMatch[1]);
    const content = await readJsonBody(req);
    const result = await createAuthoredDirection({
      cwd,
      directionId: sourceId,
      content,
    });
    sendJson(res, 201, { ...result, sourceId });
    return;
  }

  // POST /api/directions/:sourceId/fork — keyless copy of the source's brief +
  // moodboard into N drafts via WS-04's runDirectionFork.
  const forkMatch = pathname.match(FORK_RE);
  if (forkMatch && method === "POST") {
    const sourceId = decodeURIComponent(forkMatch[1]);
    const body = asRecord(await readJsonBody(req));
    const result = await runDirectionFork({
      cwd,
      sourceId,
      name: body.name as string | undefined,
      count: body.count as number | undefined,
      withMemory: body.withMemory as boolean | undefined,
    });
    sendJson(res, 201, result);
    return;
  }

  // POST /api/directions/:id/versions — append the edited fields
  // as a NEW version of the direction (the head advances). This same handler
  // backs RESTORE: the studio posts a chosen old version's content as the `edits`
  // body, which is appended verbatim as the new head. Checked BEFORE the in-place
  // route since its path is a superset.
  const versionsMatch = pathname.match(DIRECTION_VERSIONS_RE);
  if (versionsMatch && method === "POST") {
    // ONE id — the aggregate root that owns the version (C-4i collapse).
    const directionId = decodeURIComponent(versionsMatch[1]);
    const body = asRecord(await readJsonBody(req));
    const result = await runSaveVariant({
      cwd,
      directionId,
      edits: parseDirectionEdits(body),
    });
    sendJson(res, 201, result);
    return;
  }

  // PUT /api/directions/:id — in-place edit of the head version.
  const directionMatch = pathname.match(DIRECTION_RE);
  if (directionMatch && method === "PUT") {
    // ONE id — the aggregate root (C-4i collapse).
    const directionId = decodeURIComponent(directionMatch[1]);
    const body = asRecord(await readJsonBody(req));
    const result = await runEditDirection({
      cwd,
      directionId,
      edits: parseDirectionEdits(body),
    });
    sendJson(res, 200, result);
    return;
  }

  // POST /api/rules
  if (method === "POST" && pathname === "/api/rules") {
    const body = asRecord(await readJsonBody(req));
    const result = await runRule({
      cwd,
      verb: "add",
      text: body.text as string | undefined,
      severity: body.severity as string | undefined,
      author: body.author as string | undefined,
      force: body.force as boolean | undefined,
      source: "serve",
      channel: body.channel as string | undefined,
      polarity: body.polarity as string | undefined,
    });
    sendJson(res, 201, result);
    return;
  }

  // POST /api/promote — source is derived in core as promote:<id>; NOT passed here.
  if (method === "POST" && pathname === "/api/promote") {
    const body = asRecord(await readJsonBody(req));
    const result = await runPromote({
      cwd,
      directionId: body.directionId as string | undefined,
      text: body.text as string | undefined,
      entryId: body.entryId as string | undefined,
      severity: body.severity as string | undefined,
      author: body.author as string | undefined,
      force: body.force as boolean | undefined,
    });
    sendJson(res, 201, result);
    return;
  }

  // POST /api/directions/:id/reconciliation/resolve
  const reconcileResolveMatch = pathname.match(RECONCILIATION_RESOLVE_RE);
  if (reconcileResolveMatch && method === "POST") {
    const directionId = decodeURIComponent(reconcileResolveMatch[1]);
    const body = asRecord(await readJsonBody(req));
    const result = await runReconcileResolve({
      cwd,
      directionId,
      contradiction: body.contradiction as Contradiction,
      action: body.action as ReconcileAction,
      winner: (body.winner as "subject" | "conflictsWith") ?? "subject",
      severity: body.severity as RuleSeverity | undefined,
      expectedMemoryVersion:
        typeof body.expectedMemoryVersion === "number"
          ? body.expectedMemoryVersion
          : undefined,
      expectedGlobalVersion:
        typeof body.expectedGlobalVersion === "number"
          ? body.expectedGlobalVersion
          : undefined,
      force: body.force as boolean | undefined,
      author: "serve",
      source: "serve",
    });
    sendJson(res, 200, { ...result, directionId });
    return;
  }

  // POST /api/directions/:id/memory/:entryId/promote — checked BEFORE
  // MEMORY_ENTRY_RE since its path is a superset. Promote is up-only to global:
  // it dispatches to the `promoteEntryToGlobal` seam via the SAME `runDirection`
  // orchestrator the CLI/MCP use.
  const memoryPromoteMatch = pathname.match(MEMORY_PROMOTE_RE);
  if (memoryPromoteMatch && method === "POST") {
    const id = decodeURIComponent(memoryPromoteMatch[1]);
    const entryId = decodeURIComponent(memoryPromoteMatch[2]);
    const body = asRecord(await readJsonBody(req));
    const to = body.to as string | undefined;
    if (to !== "global") {
      throw new CommandError('Promote requires `to`: "global" (the only rung).');
    }
    const result = await runDirection({
      cwd,
      verb: "memory",
      memoryAction: "promote",
      id,
      entryId,
      to,
      severity: body.severity as string | undefined,
      expectedMemoryVersion:
        typeof body.expectedVersion === "number" ? body.expectedVersion : undefined,
      expectedGlobalVersion:
        typeof body.expectedGlobalVersion === "number"
          ? body.expectedGlobalVersion
          : undefined,
      force: body.force as boolean | undefined,
      author: "serve",
      source: "serve",
    });
    sendJson(res, 200, result.memoryActionResult);
    return;
  }

  // PATCH/DELETE /api/directions/:id/memory/:entryId — EDIT (supersede) / DELETE
  // (retire). Both dispatch to the shared `runDirection` memory-lifecycle
  // orchestrator (WS-04), which itself dispatches to the WS-02 core — no
  // business logic lives here.
  const memoryEntryMatch = pathname.match(MEMORY_ENTRY_RE);
  if (memoryEntryMatch && method === "PATCH") {
    const id = decodeURIComponent(memoryEntryMatch[1]);
    const entryId = decodeURIComponent(memoryEntryMatch[2]);
    const body = asRecord(await readJsonBody(req));
    const result = await runDirection({
      cwd,
      verb: "memory",
      memoryAction: "edit",
      id,
      entryId,
      body: body.body as string | undefined,
      channel: body.channel as string | undefined,
      polarity: body.polarity as string | undefined,
      expectedMemoryVersion:
        typeof body.expectedVersion === "number" ? body.expectedVersion : undefined,
      force: body.force as boolean | undefined,
      author: "serve",
      source: "serve",
    });
    sendJson(res, 200, result.memoryActionResult);
    return;
  }
  if (memoryEntryMatch && method === "DELETE") {
    const id = decodeURIComponent(memoryEntryMatch[1]);
    const entryId = decodeURIComponent(memoryEntryMatch[2]);
    const body = asRecord(await readJsonBody(req));
    // A body-less DELETE (no fetch `body` option) still carries its guards via
    // query params.
    const q = fullUrl(req).searchParams;
    const reason =
      typeof body.reason === "string" ? body.reason : q.get("reason") ?? undefined;
    const expectedVersion =
      typeof body.expectedVersion === "number"
        ? body.expectedVersion
        : q.has("expectedVersion")
          ? Number(q.get("expectedVersion"))
          : undefined;
    const force =
      typeof body.force === "boolean"
        ? body.force
        : q.has("force")
          ? q.get("force") === "true"
          : undefined;
    const result = await runDirection({
      cwd,
      verb: "memory",
      memoryAction: "delete",
      id,
      entryId,
      reason,
      expectedMemoryVersion: expectedVersion,
      force,
      author: "serve",
      source: "serve",
    });
    sendJson(res, 200, result.memoryActionResult);
    return;
  }

  // DELETE /api/directions/:id/assets — retire a kept-crop AssetRef. No CLI/MCP
  // orchestrator exists for this (out of WS-04's scope), so this dispatches
  // straight to the WS-02 core method.
  const assetsMatch = pathname.match(ASSETS_RE);
  if (assetsMatch && method === "DELETE") {
    const id = decodeURIComponent(assetsMatch[1]);
    const body = asRecord(await readJsonBody(req));
    const assetPath = typeof body.path === "string" ? body.path : undefined;
    if (assetPath === undefined || assetPath === "") {
      throw new CommandError("Asset removal requires a `path`.");
    }
    const config = await loadConfig(cwd);
    const core = createDirectionCore(cwd, config);
    const record = await core.retireAsset(
      id,
      { path: assetPath, author: "serve", source: "serve" },
      {
        expectedVersion:
          typeof body.expectedVersion === "number" ? body.expectedVersion : undefined,
        force: body.force as boolean | undefined,
      },
    );
    const asset = record.assets.find((a) => a.path === assetPath);
    sendJson(res, 200, { ok: true, directionId: id, asset, version: record.version });
    return;
  }

  // DELETE/PATCH /api/rules/:ruleId — remove (retire) / edit (supersede) a
  // global rule. Both dispatch to the shared `runRule` orchestrator (WS-04);
  // the hard-rule `force` gate lives in `BrandCore.removeRule`/`editRule` (WS-03).
  const ruleMatch = pathname.match(RULE_RE);
  if (ruleMatch && method === "DELETE") {
    const ruleId = decodeURIComponent(ruleMatch[1]);
    const body = asRecord(await readJsonBody(req));
    const result = await runRule({
      cwd,
      verb: "remove",
      ruleId,
      author: "serve",
      source: "serve",
      expectedVersion:
        typeof body.expectedVersion === "number" ? body.expectedVersion : undefined,
      force: body.force as boolean | undefined,
    });
    sendJson(res, 200, { ok: true, rule: result.rule });
    return;
  }
  if (ruleMatch && method === "PATCH") {
    const ruleId = decodeURIComponent(ruleMatch[1]);
    const body = asRecord(await readJsonBody(req));
    const text = body.text as string | undefined;
    const severity = body.severity as string | undefined;
    if (text === undefined && severity === undefined) {
      throw new CommandError("Rule edit requires `text` and/or `severity`.");
    }
    // `runRule`'s edit path maps its `body` field onto the rule's `text`
    // (the CLI/MCP `--body` flag does the same) — not `text` (add-only).
    const result = await runRule({
      cwd,
      verb: "edit",
      ruleId,
      body: text,
      severity,
      author: "serve",
      source: "serve",
      expectedVersion:
        typeof body.expectedVersion === "number" ? body.expectedVersion : undefined,
      force: body.force as boolean | undefined,
    });
    sendJson(res, 200, { ok: true, rule: result.rule });
    return;
  }

  // DELETE /api/directions/:id/extracted-assets/:assetId — retire (WS-05:
  // asset-extraction). Thin adapter over the WS-01 store: idempotent,
  // non-destructive (retiredAt marker only — no file deleted). Unknown
  // direction/asset → 404 explicitly (not toHttpError's default 400).
  const extractedAssetMatch = pathname.match(EXTRACTED_ASSET_RE);
  if (extractedAssetMatch && method === "DELETE") {
    const directionId = decodeURIComponent(extractedAssetMatch[1]);
    const assetId = decodeURIComponent(extractedAssetMatch[2]);
    const config = await loadConfig(cwd);
    try {
      await createDirectionCore(cwd, config).get(directionId);
    } catch {
      sendJson(res, 404, { error: `Direction not found: ${directionId}` });
      return;
    }
    const directionDir = path.join(directionsRoot(cwd, config), directionId);
    if (!(await listAssetIds(directionDir)).includes(assetId)) {
      sendJson(res, 404, { error: `Extracted asset not found: ${assetId}` });
      return;
    }
    await retireExtractedAsset(directionDir, assetId);
    const index = await readAssetIndex(directionDir, assetId);
    sendJson(res, 200, {
      ok: true,
      directionId,
      assetId,
      retiredAt: index.retiredAt,
      head: index.head,
      versionCount: index.versions.length,
    });
    return;
  }

  // Owned prefix but no route matched → 404.
  sendJson(res, 404, { error: "Unknown endpoint" });
}

// ---------------------------------------------------------------------------
// Asset serving + uploads (WS-02)
// ---------------------------------------------------------------------------

/**
 * The single path-traversal chokepoint shared by asset serving and uploads.
 * Resolves `requested` against `cwd` and returns the absolute path only when it
 * stays at or under `cwd`; any escape throws a 403 `CommandError`.
 */
export function resolveUnderCwd(cwd: string, requested: string): string {
  const root = path.resolve(cwd);
  const abs = path.resolve(cwd, requested);
  if (abs === root || abs.startsWith(root + path.sep)) {
    return abs;
  }
  throw new CommandError("Forbidden path", 403);
}

/**
 * Reduces an uploaded filename to a safe basename: strips any directory
 * component, replaces every character outside `[A-Za-z0-9._-]` with `-`,
 * collapses repeated dashes, strips leading dots/dashes, and falls back to
 * `upload-<timestamp>` when nothing usable remains. Never yields a path
 * separator, so the result can only land inside its intended directory.
 */
export function sanitizeUploadName(name: string): string {
  const base = path.basename(name);
  let safe = base
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+/, "");
  if (safe === "") {
    safe = `upload-${Date.now()}`;
  }
  return safe;
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

/** Image extensions Keyart is willing to serve/accept (keys of {@link CONTENT_TYPES}). */
const IMAGE_EXTS = new Set(Object.keys(CONTENT_TYPES));

/** MIME type for a file extension (lower-cased), defaulting to a binary blob. */
export function contentTypeFor(ext: string): string {
  return CONTENT_TYPES[ext.toLowerCase()] ?? "application/octet-stream";
}

/**
 * Serves image files resolved strictly under `cwd` via `GET /api/asset?path=`.
 * Mounted at `/api/asset`, so `req.url` is prefix-stripped — the query is read
 * from the full original URL and the method is the only guard. Returns 400 for
 * a missing `?path=`, 403 for a traversing path, 415 for a non-image extension,
 * and 404 for a file that is not on disk.
 */
export function createAssetServer(opts: { cwd: string }): ConnectHandler {
  const { cwd } = opts;

  return (req, res, next) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      next();
      return;
    }

    void (async () => {
      const pathParam = fullUrl(req).searchParams.get("path");
      if (pathParam === null || pathParam === "") {
        sendJson(res, 400, { error: "Missing ?path=" });
        return;
      }

      const abs = resolveUnderCwd(cwd, decodeURIComponent(pathParam));
      const ext = path.extname(abs).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) {
        sendJson(res, 415, { error: "Only image assets can be served." });
        return;
      }
      if (!(await pathExists(abs))) {
        sendJson(res, 404, { error: "Asset not found" });
        return;
      }

      const file = await fs.readFile(abs);
      res.setHeader("Content-Type", contentTypeFor(ext));
      res.setHeader("Cache-Control", "no-store");
      if (method === "HEAD") {
        res.end();
      } else {
        res.end(file);
      }
    })().catch((err) => {
      const { status, body } = toHttpError(err);
      sendJson(res, status, body);
    });
  };
}

interface UploadedFile {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  truncated: boolean;
}

interface ParsedMultipart {
  directionId: string | null;
  /** Reference intent for the uploaded files; defaults to "inspire" (WS-05). */
  intent: ReferenceIntent;
  /**
   * Every scalar field, trimmed and keyed by name (`directionId`/`intent` are also
   * surfaced as the convenience keys above). Lets element-feedback read
   * `verb`/`hex`/`note`/etc. off the SAME parse without a second parser.
   */
  fields: Record<string, string>;
  files: UploadedFile[];
}

/** Coerce a raw multipart `intent` field to a valid {@link ReferenceIntent}
 * (defaults to "inspire"; an unrecognized value also falls back to "inspire"). */
function parseIntent(raw: string | null): ReferenceIntent {
  return raw === "extract" ? "extract" : "inspire";
}

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB per file

/** True iff the part looks like an image by MIME type or file extension. */
function isImageUpload(mimeType: string, filename: string): boolean {
  if (mimeType.toLowerCase().startsWith("image/")) return true;
  return IMAGE_EXTS.has(path.extname(filename).toLowerCase());
}

/** Buffers every field/file of a multipart request, awaiting busboy completion. */
function parseMultipart(
  req: IncomingMessage,
): Promise<ParsedMultipart> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { fileSize: MAX_UPLOAD_BYTES },
      });
    } catch (err) {
      reject(err);
      return;
    }

    let directionId: string | null = null;
    let intentRaw: string | null = null;
    const fields: Record<string, string> = {};
    const files: UploadedFile[] = [];

    bb.on("field", (name, value) => {
      const trimmed = value.trim();
      fields[name] = trimmed;
      if (name === "directionId") {
        // Direction is the aggregate root — the one target field (WS-18).
        directionId = trimmed === "" ? null : trimmed;
      } else if (name === "intent") {
        intentRaw = trimmed === "" ? null : trimmed;
      }
    });

    bb.on("file", (_name, stream, info) => {
      const chunks: Buffer[] = [];
      let truncated = false;
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("limit", () => {
        truncated = true;
      });
      stream.on("end", () => {
        files.push({
          filename: info.filename,
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks),
          truncated,
        });
      });
    });

    bb.on("error", reject);
    bb.on("close", () =>
      resolve({ directionId, intent: parseIntent(intentRaw), fields, files }),
    );

    req.pipe(bb);
  });
}

/** Finds a non-clobbering absolute path under `destDir` by suffixing `-1`, `-2`, … */
async function nonClobberingPath(
  destDir: string,
  safeName: string,
): Promise<string> {
  const ext = path.extname(safeName);
  const stem = safeName.slice(0, safeName.length - ext.length);
  let candidate = path.join(destDir, safeName);
  let n = 0;
  while (await pathExists(candidate)) {
    n += 1;
    candidate = path.join(destDir, `${stem}-${n}${ext}`);
  }
  return candidate;
}

/**
 * `POST /api/uploads` — a `busboy`-parsed multipart endpoint that writes image
 * uploads into `brand/input/references/` (no `directionId`) or a direction's
 * `brand/directions/<id>/assets/` (with `directionId`, registering each file as an
 * `AssetRef`). Filenames are sanitized to safe basenames, never overwrite an
 * existing file, and never escape the destination dir; non-image or oversize
 * uploads are rejected (415 / 413).
 */
export function createUploadApi(opts: { cwd: string }): ConnectHandler {
  const { cwd } = opts;

  return (req, res, next) => {
    if ((req.method ?? "GET") !== "POST") {
      next();
      return;
    }
    void handleUpload(req, res, cwd).catch((err) => {
      const { status, body } = toHttpError(err);
      sendJson(res, status, body);
    });
  };
}

async function handleUpload(
  req: IncomingMessage,
  res: ServerResponse,
  cwd: string,
): Promise<void> {
  const config = await loadConfig(cwd);
  const { directionId, intent, files } = await parseMultipart(req);

  // Validate every part up front — reject before writing anything.
  for (const file of files) {
    if (file.truncated) {
      throw new CommandError("Uploaded file exceeds the 15 MB limit.", 413);
    }
    if (!isImageUpload(file.mimeType, file.filename)) {
      throw new CommandError("Only image uploads are allowed.", 415);
    }
  }

  // Destination — a direction's assets/ (when directionId given) or project references.
  let destDir: string;
  let core: ReturnType<typeof createDirectionCore> | null = null;
  if (directionId !== null) {
    core = createDirectionCore(cwd, config);
    await core.get(directionId); // throws CommandError (400) when the direction is missing
    destDir = path.join(directionsRoot(cwd, config), directionId, "assets");
  } else {
    destDir = path.resolve(cwd, config.brand.references);
  }
  await ensureDir(destDir);

  const written: { path: string; registered: boolean }[] = [];
  for (const file of files) {
    const safeName = sanitizeUploadName(file.filename);
    const finalPath = resolveUnderCwd(
      cwd,
      await nonClobberingPath(destDir, safeName),
    );
    await fs.writeFile(finalPath, file.buffer);

    const rel = relTo(cwd, finalPath);
    let registered = false;
    if (core !== null && directionId !== null) {
      // Carry the upload's intent onto the AssetRef so WS-05 can seed/lock
      // palette+type from "extract" references (vs merely feeding the image
      // model on "inspire").
      const asset: AssetRef = { kind: "image", path: rel, intent };
      await core.addAsset(directionId, asset);
      registered = true;
      // Elevate the upload into attributed direction memory (SC-04) so the
      // moodboard is no longer inert. A note failure must NOT fail the upload —
      // the file is already on disk and registered.
      try {
        await core.recordReferenceNote(directionId, {
          path: rel,
          author: "serve",
          source: "serve",
        });
      } catch (err) {
        console.warn(
          `Uploaded ${rel} but could not record a reference memory note: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    written.push({ path: rel, registered });
  }

  sendJson(res, 201, { ok: true, files: written });
}

// ---------------------------------------------------------------------------
// Element feedback (studio crop UI write path)
// ---------------------------------------------------------------------------

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Strictly validates and normalizes an eyedropper-picked color to a lower-case
 * `#rrggbb`, expanding the `#rgb` short form. Returns `null` when the field is
 * absent/empty; throws a 400 `CommandError` when present-but-invalid (a picked
 * color the studio sent us that we cannot parse is a real error, not a no-op).
 */
function normalizeHex(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const m = raw.trim().match(HEX_RE);
  if (m === null) {
    throw new CommandError(`Invalid hex color: "${raw}". Expected #rgb or #rrggbb.`);
  }
  let body = m[1].toLowerCase();
  if (body.length === 3) {
    body = body
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  return `#${body}`;
}

/** Default body for a discard with no user note. */
function discardBody(note: string | undefined): string {
  const trimmed = note?.trim();
  return trimmed && trimmed !== "" ? trimmed : "Discarded a cropped region";
}

/**
 * `POST /api/element-feedback` — a `busboy`-parsed multipart endpoint the studio
 * crop UI drives. It dispatches a client-produced crop blob + form fields to one
 * of three durable outcomes through the WS-01 core (no model call — pure `fs` +
 * core writes, so it works key-free):
 *
 * - **keep** → writes the crop under the direction's `assets/` and registers a
 *   positive `AssetRef` with the chosen `intent`; an eyedropper `hex` also
 *   records a color-lock `decision`. At least one of {file, hex} is required.
 * - **discard** → writes the crop under `assets/feedback/` and appends an
 *   attributed `feedback` entry carrying the thumbnail as `MemoryEntry.asset`.
 *   NEVER registered as an `AssetRef` (a discard reaches the model only as words).
 *
 * Mirrors {@link createUploadApi}: `next()`s on non-POST; every thrown error maps
 * through {@link toHttpError}. Capture is serve-only — no MCP dispatch path.
 */
export function createElementFeedbackApi(opts: { cwd: string }): ConnectHandler {
  const { cwd } = opts;

  return (req, res, next) => {
    if ((req.method ?? "GET") !== "POST") {
      next();
      return;
    }
    void handleElementFeedback(req, res, cwd).catch((err) => {
      const { status, body } = toHttpError(err);
      sendJson(res, status, body);
    });
  };
}

async function handleElementFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  cwd: string,
): Promise<void> {
  const config = await loadConfig(cwd);
  const { directionId: directionIdFromUpload, intent, fields, files } = await parseMultipart(req);

  // Direction is the aggregate root: the multipart `directionId` field is the
  // one target — no scope field, no legacy route-owner override (WS-18).
  if (directionIdFromUpload === null) {
    throw new CommandError("element-feedback requires a directionId.");
  }
  const targetDirectionId = directionIdFromUpload;
  const core = createDirectionCore(cwd, config);
  await core.get(targetDirectionId); // throws CommandError (400) when the direction is missing.

  // Validate verb.
  const verb = fields.verb;
  if (verb !== "keep" && verb !== "discard") {
    throw new CommandError("verb must be 'keep' or 'discard'.");
  }

  // Validate any provided file up front — reject before writing anything.
  for (const file of files) {
    if (file.truncated) {
      throw new CommandError("Uploaded file exceeds the 15 MB limit.", 413);
    }
    if (!isImageUpload(file.mimeType, file.filename)) {
      throw new CommandError("Only image uploads are allowed.", 415);
    }
  }

  // A present-but-invalid hex is a 400; absent ⇒ null.
  const hex = normalizeHex(fields.hex);
  const note = fields.note?.trim();

  const directionDir = path.join(directionsRoot(cwd, config), targetDirectionId);

  /** Sanitize + non-clobber + traversal-guard a crop into `destDir`; returns the rel path. */
  async function writeCrop(destDir: string, file: UploadedFile): Promise<string> {
    await ensureDir(destDir);
    const safeName = sanitizeUploadName(file.filename);
    const finalPath = resolveUnderCwd(
      cwd,
      await nonClobberingPath(destDir, safeName),
    );
    await fs.writeFile(finalPath, file.buffer);
    return relTo(cwd, finalPath);
  }

  const recorded: { asset?: string; hex?: string } = {};

  if (verb === "discard") {
    // A discard is words + a thumbnail — never a positive reference.
    if (files.length === 0) {
      throw new CommandError("A discard requires a cropped image.");
    }
    const rel = await writeCrop(path.join(directionDir, "assets", "feedback"), files[0]);
    await core.appendFeedback(targetDirectionId, {
      body: discardBody(note),
      author: "serve",
      source: "element-feedback",
      asset: rel,
    });
    recorded.asset = rel;
  } else {
    // keep — at least one of {file, hex} must be present.
    if (files.length === 0 && hex === null) {
      throw new CommandError("A keep requires a cropped image or a hex color.");
    }
    if (files.length > 0) {
      const rel = await writeCrop(path.join(directionDir, "assets"), files[0]);
      await core.addAsset(targetDirectionId, {
        kind: "image",
        path: rel,
        intent,
        ...(note ? { note } : {}),
      });
      recorded.asset = rel;
    }
    if (hex !== null) {
      await core.recordColorLock(targetDirectionId, {
        hex,
        author: "serve",
        source: "element-feedback",
        ...(note ? { note } : {}),
      });
      recorded.hex = hex;
    }
  }

  sendJson(res, 201, {
    ok: true,
    directionId: targetDirectionId,
    verb,
    ...recorded,
  });
}

// ---------------------------------------------------------------------------
// Asset actions + pack (WS-05: asset-extraction)
// ---------------------------------------------------------------------------

const ASSET_SOURCE_IMAGES: readonly string[] = AssetSourceImageSchema.options;

async function handleAssetExtract(
  req: IncomingMessage,
  res: ServerResponse,
  cwd: string,
  jobs: JobStore,
): Promise<void> {
  const { fields, files } = await parseMultipart(req);

  const directionId = fields.directionId?.trim();
  if (!directionId) {
    throw new CommandError("asset-extract requires a directionId.");
  }
  const describe = fields.describe?.trim();
  if (!describe) {
    throw new CommandError("asset-extract requires a describe field.");
  }
  const imageRaw = fields.image?.trim();
  if (imageRaw !== undefined && imageRaw !== "" && !ASSET_SOURCE_IMAGES.includes(imageRaw)) {
    throw new CommandError(
      `Invalid image: ${imageRaw}. Valid images: ${ASSET_SOURCE_IMAGES.join(", ")}.`,
    );
  }
  for (const file of files) {
    if (file.truncated) {
      throw new CommandError("Uploaded file exceeds the 15 MB limit.", 413);
    }
    if (!isImageUpload(file.mimeType, file.filename)) {
      throw new CommandError("Only image uploads are allowed.", 415);
    }
  }

  // Optional crop — the studio's client-side crop, sent under the field name
  // `crop`; the first image file part is taken (parseMultipart does not record
  // per-part field names). Written in the request scope, before the job starts,
  // so a bad crop 4xxs the request instead of failing the job. Deliberately
  // outside extracted-assets/ — never an AssetRef, never mistaken for an
  // assetId by listAssetIds.
  let cropPath: string | undefined;
  if (files.length > 0) {
    const config = await loadConfig(cwd);
    await createDirectionCore(cwd, config).get(directionId); // 400 when the direction is missing
    const destDir = path.join(directionsRoot(cwd, config), directionId, "assets", "extract-crops");
    await ensureDir(destDir);
    const safeName = sanitizeUploadName(files[0].filename);
    const finalPath = resolveUnderCwd(cwd, await nonClobberingPath(destDir, safeName));
    await fs.writeFile(finalPath, files[0].buffer);
    cropPath = relTo(cwd, finalPath);
  }

  const job = jobs.start("asset", () =>
    runAssetExtract({
      cwd,
      directionId,
      describe,
      image: (imageRaw || undefined) as AssetSourceImage | undefined,
      versionId: fields.versionId?.trim() || undefined,
      cropPath,
      name: fields.name?.trim() || undefined,
    }),
  );
  sendJson(res, 202, { jobId: job.id });
}

async function handleAssetRegenerate(
  req: IncomingMessage,
  res: ServerResponse,
  cwd: string,
  jobs: JobStore,
): Promise<void> {
  const body = asRecord(await readJsonBody(req));
  const directionId = typeof body.directionId === "string" ? body.directionId.trim() : "";
  if (!directionId) {
    throw new CommandError("asset-regenerate requires a directionId.");
  }
  const assetId = typeof body.assetId === "string" ? body.assetId.trim() : "";
  if (!assetId) {
    throw new CommandError("asset-regenerate requires an assetId.");
  }
  const tweak = typeof body.tweak === "string" ? body.tweak.trim() : "";
  if (!tweak) {
    throw new CommandError("asset-regenerate requires a tweak.");
  }
  if (body.remember !== undefined && typeof body.remember !== "boolean") {
    throw new CommandError("remember must be a boolean.");
  }

  const job = jobs.start("asset", () =>
    runAssetRegenerate({
      cwd,
      directionId,
      assetId,
      tweak,
      remember: body.remember as boolean | undefined,
      author: "serve",
    }),
  );
  sendJson(res, 202, { jobId: job.id });
}

/**
 * `POST /api/actions/asset-extract|asset-regenerate` — mounted BEFORE
 * `createActionsApi` (which 404s unknown POST segments). The extract route is
 * multipart (the element-feedback busboy precedent); regenerate is plain JSON.
 * Both dispatch as tracked jobs on the shared `JobStore` (kind: "asset" — the
 * merged WS-04 `JobKind` spelling) and return `202 { jobId }` immediately;
 * success/failure surfaces via the unchanged `GET /api/jobs/:id`. Any other
 * path falls through via `next()` so `explore`/`regenerate`/`approve`/`audit`
 * still reach `createActionsApi` untouched.
 */
export function createAssetActionsApi(opts: {
  cwd: string;
  jobs: JobStore;
}): ConnectHandler {
  const { cwd, jobs } = opts;

  return (req, res, next) => {
    if ((req.method ?? "GET") !== "POST") {
      next();
      return;
    }
    const pathname = fullPath(req);
    if (pathname === "/api/actions/asset-extract") {
      void handleAssetExtract(req, res, cwd, jobs).catch((err) => {
        const { status, body } = toHttpError(err);
        sendJson(res, status, body);
      });
      return;
    }
    if (pathname === "/api/actions/asset-regenerate") {
      void handleAssetRegenerate(req, res, cwd, jobs).catch((err) => {
        const { status, body } = toHttpError(err);
        sendJson(res, status, body);
      });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Surface board actions + curation (WS-08: studio-surface-board)
// ---------------------------------------------------------------------------

async function handleSurfaceFill(
  req: IncomingMessage,
  res: ServerResponse,
  cwd: string,
  jobs: JobStore,
): Promise<void> {
  const body = asRecord(await readJsonBody(req));
  const slotId = typeof body.slotId === "string" ? body.slotId.trim() : "";
  if (!slotId) {
    throw new CommandError("surface-fill requires a slotId.");
  }
  // TODO(job-visibility): pass meta { label: "Fill slot: <slotId>" } once
  // jobs.start accepts a third `meta` argument.
  const job = jobs.start("surface", () => runSurfaceFill({ cwd, slot: slotId }));
  sendJson(res, 202, { jobId: job.id });
}

async function handleSurfaceScan(
  req: IncomingMessage,
  res: ServerResponse,
  cwd: string,
  jobs: JobStore,
): Promise<void> {
  const body = asRecord(await readJsonBody(req));
  const urls = body.urls;
  if (
    !Array.isArray(urls) ||
    urls.length === 0 ||
    !urls.every((u) => typeof u === "string" && u.trim() !== "")
  ) {
    throw new CommandError("surface-scan requires a non-empty urls array.");
  }
  // A stray `apply` in the body is ignored — apply is triage's explicit act,
  // never the scan's. Refine composes for free: WS-06 runs the key-gated
  // refinement tier INSIDE runSurfaceScan when a key exists — this route has
  // zero key awareness.
  // TODO(job-visibility): pass meta { label: "Scan surface: <host>" } once
  // jobs.start accepts a third `meta` argument (not yet merged as of this WS).
  const job = jobs.start("surface", () => runSurfaceScan({ cwd, urls: urls as string[] }));
  sendJson(res, 202, { jobId: job.id });
}

/**
 * `POST /api/actions/surface-fill|surface-scan` — mirrors
 * {@link createAssetActionsApi}: `next()`s on non-POST and on any unmatched
 * path (so `explore`/`approve`/etc. still reach `createActionsApi`). Starts a
 * tracked `"surface"` job and responds `202 { jobId }` immediately;
 * core-level/scan rejections (unknown slot, a color/type-role slot, no
 * approved pointer, an unreachable scan URL) surface via the job's `failed`
 * state, not the kickoff response — the actions contract. `surface-fill` is
 * the WS-08 row-scoped Generate button; `surface-scan` (WS-09) is the studio's
 * scan trigger — its 202 response is byte-identical whether or not a key
 * gates WS-06's refinement tier inside the job.
 */
export function createSurfaceActionsApi(opts: {
  cwd: string;
  jobs: JobStore;
}): ConnectHandler {
  const { cwd, jobs } = opts;

  return (req, res, next) => {
    if ((req.method ?? "GET") !== "POST") {
      next();
      return;
    }
    const pathname = fullPath(req);
    if (pathname === "/api/actions/surface-fill") {
      void handleSurfaceFill(req, res, cwd, jobs).catch((err) => {
        const { status, body } = toHttpError(err);
        sendJson(res, status, body);
      });
      return;
    }
    if (pathname === "/api/actions/surface-scan") {
      void handleSurfaceScan(req, res, cwd, jobs).catch((err) => {
        const { status, body } = toHttpError(err);
        sendJson(res, status, body);
      });
      return;
    }
    next();
  };
}

const SURFACE_SLOT_RE = /^\/api\/surface\/slots\/([^/]+)$/;

async function dispatchSurface(
  method: string,
  pathname: string,
  req: IncomingMessage,
  res: ServerResponse,
  cwd: string,
): Promise<void> {
  const config = await loadConfig(cwd);
  const core = createSurfaceCore(cwd, config);

  // POST /api/surface/slots — add a single slot (the `{ slot, expectedVersion?,
  // force? }` brief-PATCH wrapper idiom). `patchSlots` is an upsert, so an id
  // already ACTIVE in the manifest is rejected up front — the add form must
  // never silently replace a row.
  if (method === "POST" && pathname === "/api/surface/slots") {
    const body = asRecord(await readJsonBody(req));
    const rawSlot = body.slot;
    if (!rawSlot || typeof rawSlot !== "object" || Array.isArray(rawSlot)) {
      throw new CommandError("Surface slot add requires a `slot` object.");
    }
    const slotInput = rawSlot as Record<string, unknown>;
    const id = typeof slotInput.id === "string" ? slotInput.id : "";
    if (!id) {
      throw new CommandError("Surface slot add requires `slot.id`.");
    }

    const current = await core.read();
    if (current?.slots.some((s) => s.id === id && !isSlotRetired(s))) {
      throw new CommandError(
        `Slot already exists: ${id} — edit it from its row instead.`,
      );
    }

    // The core stamps provenance — any client-sent origin/attributions are
    // ignored. This is the program's locked studio-add attribution.
    const slot: SurfaceSlot = {
      id,
      kind: slotInput.kind as SlotKind,
      description: typeof slotInput.description === "string" ? slotInput.description : "",
      criticality: slotInput.criticality as SurfaceSlot["criticality"],
      origin: "authored",
      attributions: [{ author: "user", source: "studio", date: new Date().toISOString() }],
      ...(slotInput.context && typeof slotInput.context === "object"
        ? { context: slotInput.context as SurfaceSlot["context"] }
        : {}),
    };

    const expectedVersion =
      typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;
    const manifest = await core.patchSlots([slot], {
      expectedVersion,
      force: body.force as boolean | undefined,
    });
    sendJson(res, 201, { ok: true, slot, version: manifest.version });
    return;
  }

  // POST /api/surface/proposal/apply — WS-09: triage's total-apply write.
  // `acceptedIds` are candidate SIGNATURES (the stable triage key, not
  // `proposedId` — refinable and not guaranteed unique across re-scans).
  // Every non-accepted candidate is REJECTED (a total triage, not a partial
  // save — the checklist's unchecked-means-reject semantics). Accepted
  // candidates merge through the SAME validated `patchSlots` call WS-05's CLI
  // `--apply` uses (`candidateToSlot` — byte-identical `surface-scan:<sig>`
  // attribution, the durable re-scan coverage key). Ordering is all-or-nothing
  // honest: the manifest write happens FIRST; `proposal.json` is rewritten
  // (candidates: [], rejectedSignatures appended + deduped) only after that
  // write succeeds — a teaching rejection or a stale expectedVersion leaves
  // the proposal byte-untouched, so nothing is remembered as rejected that
  // was never actually applied.
  if (method === "POST" && pathname === "/api/surface/proposal/apply") {
    const body = asRecord(await readJsonBody(req));
    const acceptedIdsRaw = body.acceptedIds;
    if (!Array.isArray(acceptedIdsRaw) || acceptedIdsRaw.some((v) => typeof v !== "string")) {
      throw new CommandError("Apply requires an `acceptedIds` array of signature strings.");
    }
    const acceptedIds = acceptedIdsRaw as string[];

    const proposalPath = path.join(surfaceScanDir(cwd, config), "proposal.json");
    if (!(await pathExists(proposalPath))) {
      throw new CommandError("No scan proposal to apply. Run a scan first.");
    }
    const proposal = JSON.parse(await readTextFile(proposalPath)) as ScanProposal;

    const acceptedSet = new Set(acceptedIds);
    const unknown = acceptedIds.filter(
      (sig) => !proposal.candidates.some((c) => c.signature === sig),
    );
    if (unknown.length > 0) {
      throw new CommandError(`Unknown candidate signature(s): ${unknown.join(", ")}.`);
    }

    const accepted = proposal.candidates.filter((c) => acceptedSet.has(c.signature));
    const rejected = proposal.candidates.filter((c) => !acceptedSet.has(c.signature));

    const nowIso = new Date().toISOString();
    const slots: SurfaceSlot[] = accepted.map((c) => candidateToSlot(c, nowIso));

    const expectedVersion =
      typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;
    const manifest = await core.patchSlots(slots, {
      expectedVersion,
      force: body.force as boolean | undefined,
    });

    const rejectedSignatures = [
      ...proposal.rejectedSignatures,
      ...rejected.map((c) => c.signature),
    ].filter((sig, i, arr) => arr.indexOf(sig) === i);

    const nextProposal: ScanProposal = {
      ...proposal,
      candidates: [],
      rejectedSignatures,
    };
    await writeJsonFile(proposalPath, nextProposal);

    sendJson(res, 200, {
      ok: true,
      appliedSlotIds: slots.map((s) => s.id),
      appliedCount: slots.length,
      rejectedCount: rejected.length,
      version: manifest.version,
    });
    return;
  }

  // DELETE /api/surface/slots?origin=<origin> — WS-07 (surface-scan-quality):
  // the origin-scoped bulk retire (the studio's "Retire scanned slots"
  // control — the HTTP twin of `surface retire --origin scan`). Checked
  // BEFORE the per-slot regex below: `SURFACE_SLOT_RE` requires a `:slotId`
  // segment, so `DELETE /api/surface/slots` (no segment) would otherwise fall
  // through to the trailing 404 — this branch is purely additive. `origin` is
  // REQUIRED and validated against the merged origin union (never a
  // hand-written string list) so a bare DELETE can never retire everything.
  // Dispatches through `retireSlotsByOrigin` and nothing else — no manual
  // slot filtering, no second write.
  if (method === "DELETE" && pathname === "/api/surface/slots") {
    const origin = fullUrl(req).searchParams.get("origin");
    if (!origin || !(SLOT_ORIGINS as readonly string[]).includes(origin)) {
      throw new CommandError(
        `Bulk retire requires an ?origin= query parameter. Valid origins: ${SLOT_ORIGINS.join(", ")}.`,
      );
    }
    const body = asRecord(await readJsonBody(req));
    const expectedVersion =
      typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;
    const { manifest, retiredIds, alreadyRetiredCount } = await core.retireSlotsByOrigin(
      origin as SlotOrigin,
      { expectedVersion, force: body.force as boolean | undefined },
    );
    sendJson(res, 200, {
      ok: true,
      origin,
      retiredIds,
      retiredCount: retiredIds.length,
      alreadyRetiredCount,
      version: manifest.version,
    });
    return;
  }

  const slotMatch = pathname.match(SURFACE_SLOT_RE);

  // PATCH /api/surface/slots/:slotId — edit criticality/context ONLY (the
  // studio's curation scope). A body carrying kind/description/id is rejected.
  if (slotMatch && method === "PATCH") {
    const slotId = decodeURIComponent(slotMatch[1]);
    const body = asRecord(await readJsonBody(req));
    const hasCriticality = body.criticality !== undefined;
    const hasContext = body.context !== undefined;
    if (!hasCriticality && !hasContext) {
      throw new CommandError(
        "Surface slot edit requires at least one of: criticality, context.",
      );
    }
    const patch: SlotPatch = {};
    if (hasCriticality) {
      patch.criticality = body.criticality as SurfaceSlot["criticality"];
    }
    if (hasContext) {
      patch.context = body.context as SurfaceSlot["context"];
    }
    const expectedVersion =
      typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;
    const manifest = await core.editSlot(slotId, patch, {
      expectedVersion,
      force: body.force as boolean | undefined,
    });
    const slot = manifest.slots.find((s) => s.id === slotId);
    sendJson(res, 200, { ok: true, slot, version: manifest.version });
    return;
  }

  // DELETE /api/surface/slots/:slotId — the non-destructive retiredAt marker.
  if (slotMatch && method === "DELETE") {
    const slotId = decodeURIComponent(slotMatch[1]);
    const body = asRecord(await readJsonBody(req));
    const expectedVersion =
      typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;
    const { manifest, retiredAt, alreadyRetired } = await core.retireSlot(slotId, {
      expectedVersion,
      force: body.force as boolean | undefined,
    });
    sendJson(res, 200, {
      ok: true,
      slotId,
      retiredAt,
      alreadyRetired,
      version: manifest.version,
    });
    return;
  }

  sendJson(res, 404, { error: "Unknown endpoint" });
}

/**
 * `POST /api/surface/slots`, `PATCH|DELETE /api/surface/slots/:slotId`,
 * `POST /api/surface/proposal/apply` (WS-09), `DELETE /api/surface/slots?origin=`
 * (WS-07, surface-scan-quality) — the studio's slot curation + scan-triage-apply
 * + origin-scoped bulk-retire surface, mounted at `/api/surface`. Every write
 * dispatches through `createSurfaceCore`'s validated, versioned methods: a Zod
 * teaching rejection surfaces verbatim as 400 (`toHttpError`'s `CommandError`
 * mapping), a stale `expectedVersion` as 409 `version_conflict`. GET/HEAD
 * `next()` through (there is no read route here — the board/triage read via
 * `/api/dashboard`); an unmatched write under `/api/surface` 404s.
 */
export function createSurfaceApi(opts: { cwd: string }): ConnectHandler {
  const { cwd } = opts;

  return (req, res, next) => {
    const method = req.method ?? "GET";
    if (method === "GET" || method === "HEAD") {
      next();
      return;
    }
    const pathname = fullPath(req);
    if (!pathname.startsWith("/api/surface")) {
      next();
      return;
    }
    void dispatchSurface(method, pathname, req, res, cwd).catch((err) => {
      const { status, body } = toHttpError(err);
      sendJson(res, status, body);
    });
  };
}

/**
 * `POST /api/asset-pack` — synchronous (the pack is fast, deterministic, and
 * keyless: pure fs + code-rendered SVG/JSON, no model call — deliberately NOT
 * the actions/jobs idiom). Mounted at `/api/asset-pack`; connect's `/`-boundary
 * prefix matching means the existing `/api/asset` mount never swallows it.
 */
export function createAssetPackApi(opts: { cwd: string }): ConnectHandler {
  const { cwd } = opts;
  return (req, res, next) => {
    if ((req.method ?? "GET") !== "POST") {
      next();
      return;
    }
    void (async () => {
      const body = asRecord(await readJsonBody(req));
      const result = await runAssetPack({
        cwd,
        directionId: body.directionId as string | undefined,
      });
      sendJson(res, 201, result);
    })().catch((err) => {
      const { status, body } = toHttpError(err);
      sendJson(res, status, body);
    });
  };
}

// ---------------------------------------------------------------------------
// Actions + jobs (WS-03)
// ---------------------------------------------------------------------------

/**
 * The action-segment set `POST /api/actions/<seg>` accepts. `refine` is gone —
 * feedback regenerates a direction (appending a new version); a non-head version
 * is restored via `POST …/directions/:dirId/versions`, not an action.
 */
const ACTION_KINDS = new Set([
  "explore",
  "approve",
  "audit",
  "regenerate",
]);

/**
 * `POST /api/actions/explore|approve|audit` — starts the matching command as a
 * tracked background job and responds `202 { jobId }` immediately. The command's
 * own success/failure surfaces via the job (poll `GET /api/jobs/:id`), NOT this
 * response — kickoff returns 202 as long as the request body is well-formed.
 * Malformed input → `400`; an unknown action segment → `404`.
 */
export function createActionsApi(opts: {
  cwd: string;
  jobs: JobStore;
}): ConnectHandler {
  const { cwd, jobs } = opts;

  return (req, res, next) => {
    if ((req.method ?? "GET") !== "POST") {
      next();
      return;
    }

    void dispatchAction(req, res, cwd, jobs).catch((err) => {
      const { status, body } = toHttpError(err);
      sendJson(res, status, body);
    });
  };
}

async function dispatchAction(
  req: IncomingMessage,
  res: ServerResponse,
  cwd: string,
  jobs: JobStore,
): Promise<void> {
  const pathname = fullPath(req);
  const segment = pathname.replace(/\/+$/, "").split("/").pop() ?? "";

  if (!ACTION_KINDS.has(segment)) {
    sendJson(res, 404, { error: "Unknown action" });
    return;
  }

  const body = asRecord(await readJsonBody(req));

  if (segment === "explore") {
    // Positional mode: `{ directionId }` generates v1 into that existing draft.
    // Divergent modes: `{ describe | from, count? }` mint N drafts. The legacy
    // legacy parent alias is gone — a body carrying only it is malformed.
    const directionId =
      typeof body.directionId === "string" && body.directionId !== ""
        ? body.directionId
        : undefined;
    const describe =
      typeof body.describe === "string" && body.describe !== ""
        ? body.describe
        : undefined;
    const from =
      typeof body.from === "string" && body.from !== "" ? body.from : undefined;
    if (
      directionId === undefined &&
      describe === undefined &&
      from === undefined
    ) {
      throw new CommandError(
        "Explore requires a `directionId` (generate v1 into an existing draft) or `describe`/`from` (mint N new directions).",
      );
    }
    // Divergent-only; runExplore teaches when it is combined with a positional target.
    const count = typeof body.count === "number" ? body.count : undefined;
    // One-shot steering from the studio's "Guidance for this run" box.
    const instructions =
      typeof body.instructions === "string" ? body.instructions : undefined;
    const job = jobs.start("explore", () =>
      runExplore({ cwd, directionId, describe, from, count, instructions }),
    );
    sendJson(res, 202, { jobId: job.id });
    return;
  }

  if (segment === "regenerate") {
    // Direction-addressed: regenerate reads the direction's HEAD and APPENDS a
    // new version. No `runId` — a stray one in the body is ignored (no run
    // addressing).
    const directionId = body.directionId as string | undefined;
    if (typeof directionId !== "string" || directionId === "") {
      throw new CommandError("Regenerate visuals requires a `directionId`.");
    }
    const tweak = typeof body.tweak === "string" ? body.tweak : undefined;
    // SC-06/SC-08/SC-13: lock roles (incl. a rerolled palette pushed in as
    // `lockedColors`) across the regenerate + a one-shot generic feedback note.
    // Malformed roles/hexes throw a 400 (via `normalizeHex`); absent ⇒ undefined.
    const lockedRoles = parseLockedRoles(body.lockedRoles);
    const lockedColors = parseLockedColors(body.lockedColors);
    const feedback = typeof body.feedback === "string" ? body.feedback : undefined;
    const job = jobs.start("regenerate", () =>
      runRegenerateVisuals({
        cwd,
        directionId,
        tweak,
        lockedRoles: lockedRoles.length > 0 ? lockedRoles : undefined,
        lockedColors: lockedColors.length > 0 ? lockedColors : undefined,
        feedbackNote: feedback,
      }),
    );
    sendJson(res, 202, { jobId: job.id });
    return;
  }

  if (segment === "approve") {
    // Direction-addressed: approve PINS a version (defaults to the head). No
    // `runId` — a stray one in the body is ignored.
    const directionId = body.directionId as string | undefined;
    if (typeof directionId !== "string" || directionId === "") {
      throw new CommandError("Approve requires a `directionId`.");
    }
    const versionId =
      typeof body.versionId === "string" && body.versionId !== ""
        ? body.versionId
        : undefined;
    const force = body.force as boolean | undefined;
    const job = jobs.start("approve", () =>
      runApprove({ cwd, directionId, versionId, force }),
    );
    sendJson(res, 202, { jobId: job.id });
    return;
  }

  // segment === "audit"
  const url = body.url as string | undefined;
  if (typeof url !== "string" || url === "") {
    throw new CommandError("Audit requires a `url`.");
  }
  const job = jobs.start("audit", () => runAudit({ cwd, url }));
  sendJson(res, 202, { jobId: job.id });
}

// ---------------------------------------------------------------------------
// Palette reroll + font catalog (WS-06)
// ---------------------------------------------------------------------------

const PALETTE_ROLES: PaletteRole[] = [
  "primary",
  "secondary",
  "background",
  "surface",
  "text",
  "muted",
];

/** Filter an arbitrary value into a valid PaletteRole[] (drops unknown roles). */
function parseLockedRoles(value: unknown): PaletteRole[] {
  if (!Array.isArray(value)) return [];
  const out: PaletteRole[] = [];
  for (const v of value) {
    if (typeof v === "string" && (PALETTE_ROLES as string[]).includes(v)) {
      out.push(v as PaletteRole);
    }
  }
  return out;
}

/**
 * Parse a `lockedColors` payload into `{ role?, hex }[]`: each entry may be a
 * bare hex string or `{ role?, hex }`. Hexes are strictly validated + normalized
 * via {@link normalizeHex} (a present-but-invalid hex is a 400); an unknown role
 * is dropped (the hex still counts as a role-less lock). Non-array ⇒ `[]`.
 */
function parseLockedColors(
  value: unknown,
): { role?: PaletteRole; hex: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { role?: PaletteRole; hex: string }[] = [];
  for (const entry of value) {
    let rawRole: unknown;
    let rawHex: unknown;
    if (typeof entry === "string") {
      rawHex = entry;
    } else if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      rawRole = e.role;
      rawHex = e.hex;
    } else {
      continue;
    }
    const hex = normalizeHex(typeof rawHex === "string" ? rawHex : undefined);
    if (hex === null) continue;
    const role =
      typeof rawRole === "string" && (PALETTE_ROLES as string[]).includes(rawRole)
        ? (rawRole as PaletteRole)
        : undefined;
    out.push(role ? { role, hex } : { hex });
  }
  return out;
}

/**
 * `GET /api/fonts` (the curated pairing catalog the studio's font selector
 * reads) + `POST /api/palette/reroll` (coolors-style lock + reroll). The reroll
 * runs WS-01's `rerollPalette` SERVER-side so culori never enters the browser
 * bundle; it is pure compute and never touches disk. Both sit behind the shared
 * local-only guard (mounted at `/api`). Non-matching requests fall through.
 */
export function createTokensApi(): ConnectHandler {
  return (req, res, next) => {
    const method = req.method ?? "GET";
    const pathname = fullPath(req);

    if (method === "GET" && pathname === "/api/fonts") {
      sendJson(res, 200, {
        pairings: FONT_PAIRINGS.map((p) => ({
          id: p.id,
          label: p.label,
          heading: p.heading,
          body: p.body,
        })),
      });
      return;
    }

    if (method === "POST" && pathname === "/api/palette/reroll") {
      void handleReroll(req, res).catch((err) => {
        const { status, body } = toHttpError(err);
        sendJson(res, status, body);
      });
      return;
    }

    next();
  };
}

async function handleReroll(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = asRecord(await readJsonBody(req));
  const tokens = body.tokens;
  const palette =
    tokens &&
    typeof tokens === "object" &&
    Array.isArray((tokens as { palette?: unknown }).palette)
      ? ((tokens as { palette: unknown }).palette as PaletteToken[])
      : null;
  if (!palette || palette.length === 0) {
    throw new CommandError("Reroll requires a non-empty `tokens.palette` array.");
  }
  const lockedRoles = parseLockedRoles(body.lockedRoles);
  const seed =
    typeof body.seed === "number" && Number.isFinite(body.seed)
      ? Math.trunc(body.seed)
      : Date.now();
  const result = rerollPalette(palette, lockedRoles, seed);
  sendJson(res, 200, result);
}

const JOB_ID_RE = /^\/api\/jobs\/([^/]+)$/;

/**
 * `GET /api/jobs/:id` — returns the live {@link import("./jobs.js").Job} (200)
 * or `404` when the id is unknown. Reads from the single shared store, so a job
 * started by one request is pollable by subsequent requests.
 */
export function createJobsApi(opts: { jobs: JobStore }): ConnectHandler {
  const { jobs } = opts;

  return (req, res, next) => {
    if ((req.method ?? "GET") !== "GET") {
      next();
      return;
    }

    const match = fullPath(req).match(JOB_ID_RE);
    if (match === null) {
      sendJson(res, 404, { error: "Job not found" });
      return;
    }

    const id = decodeURIComponent(match[1]);
    const job = jobs.get(id);
    if (job === undefined) {
      sendJson(res, 404, { error: "Job not found" });
      return;
    }
    sendJson(res, 200, job);
  };
}

// ---------------------------------------------------------------------------
// Reconciliation list (WS-05) — separate handler because createWriteApi skips GETs
// ---------------------------------------------------------------------------

/**
 * `GET /api/directions/:id/reconciliation` — returns the live contradiction report
 * + current memory/global versions so the client can display contradictions and
 * pass expectedVersion back on resolve. Mounted before createWriteApi so GETs are
 * served (createWriteApi passes all GETs through via next()).
 *
 * `POST /api/directions/:id/reconciliation/resolve` is handled inside the
 * `createWriteApi` dispatch function (under the `/api/directions` owned prefix).
 */
export function createReconciliationApi(opts: { cwd: string }): ConnectHandler {
  const { cwd } = opts;

  return (req, res, next) => {
    const method = req.method ?? "GET";
    const pathname = fullPath(req);

    const listMatch = pathname.match(RECONCILIATION_RE);
    if (listMatch && (method === "GET" || method === "HEAD")) {
      const directionId = decodeURIComponent(listMatch[1]);
      void (async () => {
        const config = await loadConfig(cwd);
        const core = createDirectionCore(cwd, config);
        const brandCore = createBrandCore(cwd, config);
        const [report, mem, global] = await Promise.all([
          core.listContradictions(directionId),
          core.readMemory(directionId),
          brandCore.read(),
        ]);
        sendJson(res, 200, {
          directionId,
          report,
          memoryVersion: mem.version,
          globalVersion: global.version,
        });
      })().catch((err) => {
        const { status, body } = toHttpError(err);
        sendJson(res, status, body);
      });
      return;
    }

    next();
  };
}
