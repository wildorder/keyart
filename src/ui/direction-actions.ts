/**
 * The ONE module of pure studio action-builders (SC-09) — created by WS-20
 * (studio-actions-stable-routes) with the seventeen builders whose route AND
 * body are both untouched by the remove-concept program, completed by WS-18
 * with the remaining thirty.
 *
 * Every builder is PURE: it returns a {@link StudioRequest} descriptor
 * (`method`, `path`, `body`) and performs no I/O. The existing transport
 * (`postJson` / `putJson` / `patchJson` / `deleteJson` / `fetch` /
 * `useAction.start`) keeps carrying the bytes — call sites become e.g.
 * `postJson(req.path, req.body)`. The request that goes on the wire is
 * byte-identical to what the inline call sites shipped before extraction:
 * conditionally-present body keys (`context`, `force`, `openaiApiKey`,
 * `expectedVersion`) reproduce the same conditional spread, never an explicit
 * `undefined`-valued key.
 *
 * Mirrors the `lifecycle-actions.ts` convention: pure, JSX-free,
 * `.js`-extension imports, consumed by dumb renderers.
 */
import { assetUrl } from "./asset-url.js";
import type {
  DirectionTokens,
  DirectiveChannel,
  DirectivePolarity,
  PaletteRole,
  RuleSeverity,
} from "./types.js";

/** A pure request descriptor — the builder/transport contract (WS-20/WS-18). */
export interface StudioRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Final path, query string and encoding included. */
  path: string;
  /** Absent on GET. */
  body?: unknown;
  /** Multipart scalar fields (element-feedback / uploads / asset-extract) —
   * the file blob rides via the existing transport wrapper, never here. */
  form?: Record<string, string>;
  /** SSE request payload (chat send / resume) — consumed by the chat stream
   * transport as the JSON body. */
  payload?: unknown;
}

// ---------------------------------------------------------------------------
// TIER A — control-bound (event origin)
// ---------------------------------------------------------------------------

/** Generate an asset for a surface gap: `POST /api/actions/surface-fill`. */
export function surfaceFillRequest(slotId: string): StudioRequest {
  return { method: "POST", path: "/api/actions/surface-fill", body: { slotId } };
}

/** Add a single surface slot: `POST /api/surface/slots`. */
export function surfaceAddRequest(args: {
  slot: {
    id: string;
    kind: string;
    description: string;
    criticality: "required" | "preferred";
    context?: Record<string, unknown>;
  };
  expectedVersion?: number;
}): StudioRequest {
  return {
    method: "POST",
    path: "/api/surface/slots",
    body: {
      slot: args.slot,
      ...(args.expectedVersion !== undefined
        ? { expectedVersion: args.expectedVersion }
        : {}),
    },
  };
}

/** Edit a surface slot's curation: `PATCH /api/surface/slots/:slotId`. */
export function surfaceEditRequest(
  slotId: string,
  args: {
    criticality: "required" | "preferred";
    context?: Record<string, unknown>;
    expectedVersion?: number;
  },
): StudioRequest {
  return {
    method: "PATCH",
    path: `/api/surface/slots/${encodeURIComponent(slotId)}`,
    body: {
      criticality: args.criticality,
      ...(args.context !== undefined ? { context: args.context } : {}),
      ...(args.expectedVersion !== undefined
        ? { expectedVersion: args.expectedVersion }
        : {}),
    },
  };
}

/** Non-destructively retire one slot: `DELETE /api/surface/slots/:slotId`. */
export function surfaceRetireRequest(
  slotId: string,
  args: { expectedVersion?: number },
): StudioRequest {
  return {
    method: "DELETE",
    path: `/api/surface/slots/${encodeURIComponent(slotId)}`,
    body: {
      ...(args.expectedVersion !== undefined
        ? { expectedVersion: args.expectedVersion }
        : {}),
    },
  };
}

/**
 * Bulk-retire every ACTIVE scan-authored slot:
 * `DELETE /api/surface/slots?origin=scan`. `origin=scan` is HARD-CODED — the
 * lifecycle-confirm twin of `surface retire --origin scan`.
 */
export function surfaceBulkRetireRequest(args: {
  expectedVersion?: number;
}): StudioRequest {
  return {
    method: "DELETE",
    path: "/api/surface/slots?origin=scan",
    body: {
      ...(args.expectedVersion !== undefined
        ? { expectedVersion: args.expectedVersion }
        : {}),
    },
  };
}

/** Trigger a tracked surface scan: `POST /api/actions/surface-scan`.
 * Takes `urls: string[]` — mirrors the wire shape (the live call site sends an
 * array of one), not a single-URL convenience signature. */
export function scanTriggerRequest(urls: string[]): StudioRequest {
  return { method: "POST", path: "/api/actions/surface-scan", body: { urls } };
}

/** Apply the accepted scan candidates: `POST /api/surface/proposal/apply`. */
export function scanApplyRequest(args: {
  acceptedIds: string[];
  expectedVersion?: number;
}): StudioRequest {
  return {
    method: "POST",
    path: "/api/surface/proposal/apply",
    body: {
      acceptedIds: args.acceptedIds,
      ...(args.expectedVersion !== undefined
        ? { expectedVersion: args.expectedVersion }
        : {}),
    },
  };
}

/** Run an audit against a live URL: `POST /api/actions/audit`. */
export function auditRequest(url: string): StudioRequest {
  return { method: "POST", path: "/api/actions/audit", body: { url } };
}

/** Author a new global rule: `POST /api/rules`. */
export function ruleAddRequest(args: {
  text: string;
  severity: RuleSeverity;
  channel: DirectiveChannel;
  polarity: DirectivePolarity;
}): StudioRequest {
  return {
    method: "POST",
    path: "/api/rules",
    body: {
      text: args.text,
      severity: args.severity,
      channel: args.channel,
      polarity: args.polarity,
    },
  };
}

/** Edit a global rule: `PATCH /api/rules/:id`. `force` is present only when
 * the call site sends it today (a hard rule on either side of the edit). */
export function ruleEditRequest(
  ruleId: string,
  args: { text: string; severity: RuleSeverity; force?: true },
): StudioRequest {
  return {
    method: "PATCH",
    path: `/api/rules/${encodeURIComponent(ruleId)}`,
    body: {
      text: args.text,
      severity: args.severity,
      ...(args.force ? { force: true } : {}),
    },
  };
}

/** Remove a global rule: `DELETE /api/rules/:id`. A HARD rule's remove is
 * force-gated — `force` present only when the call site sends it. */
export function ruleRemoveRequest(
  ruleId: string,
  args: { force?: true },
): StudioRequest {
  return {
    method: "DELETE",
    path: `/api/rules/${encodeURIComponent(ruleId)}`,
    body: { ...(args.force ? { force: true } : {}) },
  };
}

/** Save project settings: `PUT /api/settings`. The `openaiApiKey` key is
 * present only when non-empty — as the live call site ships today. */
export function settingsUpdateRequest(payload: {
  project: { name: string; type: string; framework: string };
  models: { text: string; vision: string; image: string };
  openaiApiKey?: string;
}): StudioRequest {
  return {
    method: "PUT",
    path: "/api/settings",
    body: {
      project: payload.project,
      models: payload.models,
      ...(payload.openaiApiKey !== undefined && payload.openaiApiKey !== ""
        ? { openaiApiKey: payload.openaiApiKey }
        : {}),
    },
  };
}

/** Reroll the unlocked palette roles: `POST /api/palette/reroll`. `seed` is an
 * ARGUMENT — `freshSeed()` stays at the call site; the builder is pure. */
export function paletteRerollRequest(args: {
  tokens: DirectionTokens;
  lockedRoles: PaletteRole[];
  seed: number;
}): StudioRequest {
  return {
    method: "POST",
    path: "/api/palette/reroll",
    body: { tokens: args.tokens, lockedRoles: args.lockedRoles, seed: args.seed },
  };
}

/** Fetch a lightbox image's exact bytes: `GET /api/asset?path=…[&v=…]` — via
 * {@link assetUrl}, so `&v=` is omitted when `version` is nullish. */
export function lightboxAssetRequest(
  path: string,
  version?: number | string,
): StudioRequest {
  return { method: "GET", path: assetUrl(path, version) };
}

// ---------------------------------------------------------------------------
// TIER B — automatic (effect origin)
// ---------------------------------------------------------------------------

/** Read project settings on mount: `GET /api/settings`. */
export function settingsReadRequest(): StudioRequest {
  return { method: "GET", path: "/api/settings" };
}

/** Load the curated font catalog: `GET /api/fonts`. */
export function fontsReadRequest(): StudioRequest {
  return { method: "GET", path: "/api/fonts" };
}

/** Poll a tracked job: `GET /api/jobs/:jobId`. */
export function jobPollRequest(jobId: string): StudioRequest {
  return { method: "GET", path: `/api/jobs/${encodeURIComponent(jobId)}` };
}

// ---------------------------------------------------------------------------
// WS-18's thirty builders — twenty-eight Tier A (control-bound, event origin)
// + two Tier B (automatic, effect origin). Together with WS-20's seventeen
// these are the complete forty-seven-builder roster (SC-09).
// ---------------------------------------------------------------------------

/** One direction path segment, encoded. */
function directionPath(directionId: string): string {
  return `/api/directions/${encodeURIComponent(directionId)}`;
}

// --- Tier A — generation + lifecycle ---------------------------------------

/**
 * Regenerate the direction's head (append a new version):
 * `POST /api/actions/regenerate`. Carries the optional one-shot tweak /
 * feedback note and the lock-and-rotate palette locks.
 */
export function regenerateRequest(
  directionId: string,
  opts: {
    tweak?: string;
    feedback?: string;
    lockedRoles?: PaletteRole[];
    lockedColors?: { role: PaletteRole; hex: string }[];
  } = {},
): StudioRequest {
  return {
    method: "POST",
    path: "/api/actions/regenerate",
    body: {
      directionId,
      ...(opts.tweak ? { tweak: opts.tweak } : {}),
      ...(opts.feedback ? { feedback: opts.feedback } : {}),
      ...(opts.lockedRoles && opts.lockedRoles.length > 0
        ? { lockedRoles: opts.lockedRoles }
        : {}),
      ...(opts.lockedColors && opts.lockedColors.length > 0
        ? { lockedColors: opts.lockedColors }
        : {}),
    },
  };
}

/**
 * The draft empty state's Generate v1 CTA: `POST /api/actions/explore` with a
 * SINGLE existing draft id and NO `count` — positional explore writes v1 into
 * the draft (never `regenerateRequest`, which rejects a zero-version draft).
 */
export function generateV1Request(directionId: string): StudioRequest {
  return {
    method: "POST",
    path: "/api/actions/explore",
    body: { directionId },
  };
}

/**
 * NewDirectionModal's Describe tab: `POST /api/actions/explore` with seed text
 * and NO target id — the divergent mode mints N new drafts + v1 each.
 */
export function divergentExploreRequest(
  describe: string,
  count?: number,
  instructions?: string,
): StudioRequest {
  return {
    method: "POST",
    path: "/api/actions/explore",
    body: {
      describe,
      ...(count !== undefined ? { count } : {}),
      ...(instructions ? { instructions } : {}),
    },
  };
}

/** Approve (pin) a version: `POST /api/actions/approve`. */
export function approveRequest(
  directionId: string,
  versionId?: string,
): StudioRequest {
  return {
    method: "POST",
    path: "/api/actions/approve",
    body: {
      directionId,
      ...(versionId !== undefined ? { versionId } : {}),
    },
  };
}

/**
 * Restore = append a chosen old version's content as the next version:
 * `POST /api/directions/:id/versions`.
 */
export function restoreVersionRequest(
  directionId: string,
  edits: Record<string, unknown>,
): StudioRequest {
  return {
    method: "POST",
    path: `${directionPath(directionId)}/versions`,
    body: edits,
  };
}

/** Fork the source's brief + moodboard into N drafts: `POST /api/directions/:sourceId/fork`. */
export function forkRequest(
  sourceId: string,
  opts: { name?: string; count?: number; withMemory?: boolean } = {},
): StudioRequest {
  return {
    method: "POST",
    path: `${directionPath(sourceId)}/fork`,
    body: {
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.count !== undefined ? { count: opts.count } : {}),
      ...(opts.withMemory ? { withMemory: true } : {}),
    },
  };
}

/**
 * The authored form: `POST /api/directions/:sourceId/create` with the authored
 * content JSON as the whole body (mirrors `direction create '<json>' --from`).
 */
export function authoredCreateRequest(
  sourceId: string,
  content: unknown,
): StudioRequest {
  return {
    method: "POST",
    path: `${directionPath(sourceId)}/create`,
    body: content,
  };
}

// --- Tier A — feedback + assets ---------------------------------------------

/**
 * An element-feedback capture (keep / discard / eyedropper):
 * `POST /api/element-feedback` (multipart). The `form` carries `directionId` +
 * the gesture fields — NO scope field, NO legacy parent id (scope is location).
 * The crop blob rides via the transport wrapper.
 */
export function elementFeedbackRequest(
  fields: Record<string, string> & { directionId: string },
): StudioRequest {
  return { method: "POST", path: "/api/element-feedback", form: fields };
}

/**
 * The studio extract gesture: `POST /api/actions/asset-extract` (multipart via
 * `postAssetExtract`; the crop rides under the `crop` field name).
 */
export function extractAssetRequest(
  fields: Record<string, string> & { directionId: string },
): StudioRequest {
  return { method: "POST", path: "/api/actions/asset-extract", form: fields };
}

/** Export the asset pack: `POST /api/asset-pack` — body carries `directionId` only. */
export function exportAssetPackRequest(directionId: string): StudioRequest {
  return { method: "POST", path: "/api/asset-pack", body: { directionId } };
}

/** Regenerate one extracted asset: `POST /api/actions/asset-regenerate`. */
export function assetRegenerateRequest(
  directionId: string,
  assetId: string,
  tweak: string,
  opts: { remember?: boolean } = {},
): StudioRequest {
  return {
    method: "POST",
    path: "/api/actions/asset-regenerate",
    body: {
      directionId,
      assetId,
      tweak,
      ...(opts.remember ? { remember: true } : {}),
    },
  };
}

/** Retire one extracted asset: `DELETE /api/directions/:id/extracted-assets/:assetId`. */
export function assetRetireRequest(
  directionId: string,
  assetId: string,
): StudioRequest {
  return {
    method: "DELETE",
    path: `${directionPath(directionId)}/extracted-assets/${encodeURIComponent(assetId)}`,
    body: {},
  };
}

/**
 * Upload moodboard images: `POST /api/uploads` (multipart) — the `form`
 * carries `directionId` (+ optional intent); files ride via `uploadFiles`.
 */
export function moodboardUploadRequest(
  directionId: string,
  intent?: "inspire" | "extract",
): StudioRequest {
  return {
    method: "POST",
    path: "/api/uploads",
    form: { directionId, ...(intent ? { intent } : {}) },
  };
}

/** Retire a kept-crop moodboard ref: `DELETE /api/directions/:id/assets`. */
export function moodboardAssetRetireRequest(
  directionId: string,
  assetPath: string,
  expectedVersion?: number,
): StudioRequest {
  return {
    method: "DELETE",
    path: `${directionPath(directionId)}/assets`,
    body: {
      path: assetPath,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    },
  };
}

// --- Tier A — chat -----------------------------------------------------------

/** One chat turn: `POST /api/chat` (SSE) — the direction is REQUIRED in context. */
export function chatSendRequest(payload: {
  sessionId?: string;
  message: string;
  context: { directionId: string; versionId?: string };
}): StudioRequest {
  return { method: "POST", path: "/api/chat", payload };
}

/** Resume a suspended chat turn: `POST /api/chat/:sessionId/approve` (SSE). */
export function chatResumeRequest(
  sessionId: string,
  approve: boolean,
): StudioRequest {
  return {
    method: "POST",
    path: `/api/chat/${encodeURIComponent(sessionId)}/approve`,
    payload: { approve },
  };
}

// --- Tier A — brief + notes + direction edits --------------------------------

/** Versioned brief field write: `PATCH /api/directions/:id/brief` (409-safe). */
export function briefWriteRequest(
  directionId: string,
  patch: Record<string, unknown>,
  expectedVersion?: number,
): StudioRequest {
  return {
    method: "PATCH",
    path: `${directionPath(directionId)}/brief`,
    body: {
      patch,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    },
  };
}

/** Map a ramble → proposed brief patch: `POST /api/directions/:id/brief/map`. */
export function briefMapRequest(
  directionId: string,
  freeform: string,
): StudioRequest {
  return {
    method: "POST",
    path: `${directionPath(directionId)}/brief/map`,
    body: { freeform },
  };
}

/** Apply a hex as an attributed color lock: `POST /api/directions/:id/brief/lock`. */
export function briefColorLockRequest(
  directionId: string,
  hex: string,
  note?: string,
): StudioRequest {
  return {
    method: "POST",
    path: `${directionPath(directionId)}/brief/lock`,
    body: { hex, ...(note ? { note } : {}) },
  };
}

/** A NotesComposer memory note: `POST /api/directions/:id/feedback` — NO scope field. */
export function notesComposerRequest(
  directionId: string,
  entry: {
    body: string;
    kind: "feedback" | "learning" | "decision";
    channel?: DirectiveChannel;
    polarity?: DirectivePolarity;
  },
): StudioRequest {
  return {
    method: "POST",
    path: `${directionPath(directionId)}/feedback`,
    body: {
      body: entry.body,
      kind: entry.kind,
      ...(entry.channel !== undefined ? { channel: entry.channel } : {}),
      ...(entry.polarity !== undefined ? { polarity: entry.polarity } : {}),
    },
  };
}

/** In-place head edit: `PUT /api/directions/:id`. */
export function directionEditRequest(
  directionId: string,
  edits: Record<string, unknown>,
): StudioRequest {
  return { method: "PUT", path: directionPath(directionId), body: edits };
}

/** "Save as a new version": `POST /api/directions/:id/versions`. */
export function directionVariantRequest(
  directionId: string,
  edits: Record<string, unknown>,
): StudioRequest {
  return {
    method: "POST",
    path: `${directionPath(directionId)}/versions`,
    body: edits,
  };
}

/** PaletteBoard's save/locks: `PUT /api/directions/:id` with `{ tokens }`. */
export function paletteSaveRequest(
  directionId: string,
  tokens: DirectionTokens,
): StudioRequest {
  return { method: "PUT", path: directionPath(directionId), body: { tokens } };
}

// --- Tier A — memory lifecycle + promote + reconcile --------------------------

/** Promote a memory entry — up-ladder to global ONLY:
 * `POST /api/directions/:id/memory/:entryId/promote`. */
export function memoryPromoteRequest(
  directionId: string,
  entryId: string,
  opts: { severity?: RuleSeverity; expectedVersion?: number } = {},
): StudioRequest {
  return {
    method: "POST",
    path: `${directionPath(directionId)}/memory/${encodeURIComponent(entryId)}/promote`,
    body: {
      to: "global",
      ...(opts.severity !== undefined ? { severity: opts.severity } : {}),
      ...(opts.expectedVersion !== undefined
        ? { expectedVersion: opts.expectedVersion }
        : {}),
    },
  };
}

/** Supersede (edit) a memory entry: `PATCH /api/directions/:id/memory/:entryId`. */
export function memoryEditRequest(
  directionId: string,
  entryId: string,
  edit: {
    body: string;
    channel?: DirectiveChannel;
    polarity?: DirectivePolarity;
    expectedVersion?: number;
  },
): StudioRequest {
  return {
    method: "PATCH",
    path: `${directionPath(directionId)}/memory/${encodeURIComponent(entryId)}`,
    body: {
      body: edit.body,
      ...(edit.channel !== undefined ? { channel: edit.channel } : {}),
      ...(edit.polarity !== undefined ? { polarity: edit.polarity } : {}),
      ...(edit.expectedVersion !== undefined
        ? { expectedVersion: edit.expectedVersion }
        : {}),
    },
  };
}

/** Retire (delete) a memory entry: `DELETE /api/directions/:id/memory/:entryId`. */
export function memoryDeleteRequest(
  directionId: string,
  entryId: string,
  expectedVersion?: number,
): StudioRequest {
  return {
    method: "DELETE",
    path: `${directionPath(directionId)}/memory/${encodeURIComponent(entryId)}`,
    body: {
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    },
  };
}

/**
 * The top-level promote control: `POST /api/promote` — consumes WS-05's
 * contracted `runPromote` verbatim: `directionId` only, never re-widened.
 */
export function globalPromoteRequest(args: {
  directionId: string;
  severity: RuleSeverity;
  text?: string;
  entryId?: string;
}): StudioRequest {
  return {
    method: "POST",
    path: "/api/promote",
    body: {
      directionId: args.directionId,
      severity: args.severity,
      ...(args.text !== undefined ? { text: args.text } : {}),
      ...(args.entryId !== undefined ? { entryId: args.entryId } : {}),
    },
  };
}

/** Resolve one contradiction: `POST /api/directions/:id/reconciliation/resolve`. */
export function reconciliationResolveRequest(
  directionId: string,
  body: Record<string, unknown>,
): StudioRequest {
  return {
    method: "POST",
    path: `${directionPath(directionId)}/reconciliation/resolve`,
    body,
  };
}

// ---------------------------------------------------------------------------
// TIER B — automatic (effect origin) — WS-18's two
// ---------------------------------------------------------------------------

/** ReconciliationPanel's automatic read: `GET /api/directions/:id/reconciliation`. */
export function reconciliationReadRequest(directionId: string): StudioRequest {
  return {
    method: "GET",
    path: `${directionPath(directionId)}/reconciliation`,
  };
}

/** The dashboard read `useDashboard` issues from its effect: `GET /api/dashboard`. */
export function dashboardReadRequest(): StudioRequest {
  return { method: "GET", path: "/api/dashboard" };
}
