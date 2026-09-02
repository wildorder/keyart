/**
 * The UI data layer: dashboard fetching, JSON/upload mutation helpers, job
 * polling, and a toast context. WS-05/06 build their write flows on top of
 * these — this workstream only defines them (and wires `useDashboard` into the
 * shell).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatEvent, ChatTurn, DashboardData, Job } from "./types.js";
import { appendUserTurn, initialChatViewState, parseSseFrames, reduceChatEvent } from "./chat-stream.js";
import { dashboardReadRequest, jobPollRequest, type StudioRequest } from "./direction-actions.js";

// The toast system (ToastProvider + useToasts) is part of this data layer but
// lives in `./components/Toasts` because its provider renders JSX — import it
// from there. Kept out of this `.ts` module so the server tsconfig (no `jsx`)
// never has to compile a `.tsx` file.

/** An Error carrying the structured `code` from a `{ error, code }` API body. */
export class ApiError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/** True when `e` is a WS-01 optimistic-concurrency conflict (HTTP 409). */
export function isVersionConflict(e: unknown): boolean {
  return e instanceof ApiError && e.code === "version_conflict";
}

/** Non-technical copy shown when a mutation loses to a concurrent write. */
export const VERSION_CONFLICT_MESSAGE =
  "Someone changed this direction — reloading. Please redo your edit.";

/** Parse a non-2xx response body as `{ error, code }` and throw an {@link ApiError}. */
async function throwFromResponse(res: Response): Promise<never> {
  let body: { error?: string; code?: string } = {};
  try {
    body = (await res.json()) as { error?: string; code?: string };
  } catch {
    // Non-JSON error body — fall back to the status text.
  }
  throw new ApiError(body.error ?? `HTTP ${res.status}`, body.code);
}

/** POST `body` as JSON, returning the parsed 2xx response (or throwing {@link ApiError}). */
export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return throwFromResponse(res);
  return (await res.json()) as T;
}

/** PUT `body` as JSON, returning the parsed 2xx response (or throwing {@link ApiError}). */
export async function putJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return throwFromResponse(res);
  return (await res.json()) as T;
}

/** PATCH `body` as JSON, returning the parsed 2xx response (or throwing {@link ApiError}).
 * The versioned brief field-write (WS-05) uses this. */
export async function patchJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return throwFromResponse(res);
  return (await res.json()) as T;
}

/** DELETE with a JSON `body`, returning the parsed 2xx response (or throwing {@link ApiError}).
 * The lifecycle retire/remove controls (WS-06) use this. */
export async function deleteJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) return throwFromResponse(res);
  return (await res.json()) as T;
}

/**
 * POST `files` (plus optional scalar `fields`) as multipart/form-data. No JSON
 * content-type — the browser sets the multipart boundary itself.
 */
export async function uploadFiles<T>(
  url: string,
  files: FileList | File[],
  fields?: Record<string, string>,
): Promise<T> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields ?? {})) {
    form.append(key, value);
  }
  for (const file of Array.from(files)) {
    form.append("files", file, file.name);
  }
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) return throwFromResponse(res);
  return (await res.json()) as T;
}

/** The multipart payload for a single element-feedback capture (WS-04). */
export interface ElementFeedbackPayload {
  /** The cropped PNG (`null` for a pure eyedropper color lock). */
  blob: Blob | null;
  /** File name for the crop; defaults to `crop.png`. */
  filename?: string;
  /** Scalar fields: `directionId`, `verb`, `intent?`, `hex?`, `note?`, `versionId?`. */
  fields: Record<string, string>;
}

/**
 * POST an element-feedback capture as `multipart/form-data` to
 * `/api/element-feedback` (WS-03). The crop `blob` is appended under the field
 * name `files` (matching `uploadFiles` / the server's `busboy` handling); every
 * `fields` entry is appended as a scalar. Throws {@link ApiError} on non-2xx.
 */
export async function postElementFeedback<T>(payload: ElementFeedbackPayload): Promise<T> {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload.fields)) {
    form.append(key, value);
  }
  if (payload.blob) {
    form.append("files", payload.blob, payload.filename ?? "crop.png");
  }
  const res = await fetch("/api/element-feedback", { method: "POST", body: form });
  if (!res.ok) return throwFromResponse(res);
  return (await res.json()) as T;
}

/** The multipart payload for the studio extract gesture (WS-06). */
export interface AssetExtractPayload {
  /** The client-side crop PNG riding as the `crop` file (null = no crop —
   * not used by the studio gesture, but kept total). */
  blob: Blob | null;
  /** File name for the crop; defaults to `crop.png`. */
  filename?: string;
  /** Scalar fields: directionId, describe, image?, versionId?, name?. */
  fields: Record<string, string>;
}

/**
 * POST an asset-extract capture as `multipart/form-data` to
 * `/api/actions/asset-extract` (WS-05). Mirrors {@link postElementFeedback},
 * except the crop blob rides under the field name `crop` (not `files`) —
 * the asset-extract busboy handler's contract. Throws {@link ApiError} on
 * non-2xx.
 */
export async function postAssetExtract(
  payload: AssetExtractPayload,
): Promise<{ jobId: string }> {
  const form = new FormData();
  for (const [key, value] of Object.entries(payload.fields)) {
    form.append(key, value);
  }
  if (payload.blob) {
    form.append("crop", payload.blob, payload.filename ?? "crop.png");
  }
  const res = await fetch("/api/actions/asset-extract", { method: "POST", body: form });
  if (!res.ok) return throwFromResponse(res);
  return (await res.json()) as { jobId: string };
}

/**
 * A minimal mutation hook around {@link postElementFeedback}. `submit` resolves
 * `true` on success (and `false` on failure, surfacing `error` inline) so the
 * caller can reset + `reload()` without a try/catch; `pending` gates the buttons.
 */
export function useElementFeedback(): {
  submit: (payload: ElementFeedbackPayload) => Promise<boolean>;
  pending: boolean;
  error: string | null;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async (payload: ElementFeedbackPayload): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await postElementFeedback(payload);
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      return false;
    } finally {
      setPending(false);
    }
  }, []);

  return { submit, pending, error };
}

export interface UseDashboard {
  data: DashboardData | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Fetch `/api/dashboard`; `reload()` re-fetches so mutations can refresh. */
export function useDashboard(): UseDashboard {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(dashboardReadRequest().path)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        if (cancelled) return;
        setData(d as DashboardData);
        setError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  return { data, error, loading, reload };
}

/**
 * Poll `GET /api/jobs/:id` every ~1s while the job is `running`; stop on a
 * terminal state. Cleans up on unmount / id change. Returns `{ job: null }`
 * when `jobId` is null.
 */
export function useJob(jobId: string | null): { job: Job | null } {
  const [job, setJob] = useState<Job | null>(null);
  // Avoid a state-update race when a poll resolves after the id changed.
  const activeId = useRef<string | null>(jobId);

  useEffect(() => {
    activeId.current = jobId;
    if (jobId === null) {
      setJob(null);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(jobPollRequest(jobId).path);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = (await res.json()) as Job;
        if (cancelled || activeId.current !== jobId) return;
        setJob(next);
        if (next.status === "running") {
          timer = setTimeout(poll, 1000);
        }
      } catch {
        // Transient fetch failure — retry on the same cadence.
        if (!cancelled && activeId.current === jobId) {
          timer = setTimeout(poll, 1000);
        }
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [jobId]);

  return { job };
}

export interface UseChat {
  messages: ChatTurn[];
  pendingApproval: Extract<ChatEvent, { type: "pending_approval" }> | null;
  streaming: boolean;
  unavailable: boolean;
  error: string | null;
  sessionId: string | null;
  /** Streams a `chatSendRequest` descriptor (`POST /api/chat`, SSE). The
   * caller (ChatRail) BUILDS the request — this hook only carries the bytes. */
  send: (req: StudioRequest) => void;
  /** Streams a `chatResumeRequest` descriptor
   * (`POST /api/chat/:sessionId/approve`, SSE) for the single suspended call. */
  approve: (req: StudioRequest) => void;
}

/**
 * Owns one chat session's reducer state and exposes BOTH `send` and
 * `approve` so the turn stream and the approval resume fold into the SAME
 * `reduceChatEvent` state — an approve continuation appends to the existing
 * transcript rather than starting a second one. Mirrors `useDashboard`/
 * `useJob`: an `AbortController` cancels an in-flight stream on unmount or
 * when a new `send`/`approve` supersedes it.
 */
export function useChat(): UseChat {
  const [state, setState] = useState(initialChatViewState());
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const consume = useCallback(async (res: Response, signal: AbortSignal) => {
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseFrames(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (signal.aborted) return;
          if (
            (event.type === "pending_approval" || event.type === "done") &&
            event.sessionId
          ) {
            sessionIdRef.current = event.sessionId;
          }
          setState((prev) => reduceChatEvent(prev, event));
        }
      }
    } catch {
      // Aborted or a transient network failure mid-stream — leave state as last folded.
    }
  }, []);

  const startStream = useCallback(
    (run: (signal: AbortSignal) => Promise<Response>) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      void (async () => {
        try {
          const res = await run(controller.signal);
          await consume(res, controller.signal);
        } catch {
          // Aborted before the request completed.
        }
      })();
    },
    [consume],
  );

  const send = useCallback(
    (req: StudioRequest) => {
      const payload = { ...(req.payload as { sessionId?: string; message: string }) };
      // The hook owns session continuity — fill the sessionId in when the
      // caller's descriptor did not carry one and a session already exists.
      if (payload.sessionId === undefined && sessionIdRef.current !== null) {
        payload.sessionId = sessionIdRef.current;
      }
      setState((prev) => ({ ...appendUserTurn(prev, payload.message), streaming: true }));
      startStream((signal) =>
        fetch(req.path, {
          method: req.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        }),
      );
    },
    [startStream],
  );

  const approve = useCallback(
    (req: StudioRequest) => {
      setState((prev) => ({ ...prev, pendingApproval: null, streaming: true }));
      startStream((signal) =>
        fetch(req.path, {
          method: req.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.payload),
          signal,
        }),
      );
    },
    [startStream],
  );

  return { ...state, send, approve };
}
