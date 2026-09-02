import type { IncomingMessage, ServerResponse } from "node:http";
import { hasApiKey } from "../openai.js";
import { dispatchCommand } from "../mcp/registry.js";
import { createComplete } from "../agent/model.js";
import type { ChatContext, CompleteFn, PendingApproval } from "../agent/model.js";
import type { ChatEvent, LaunchJobFn, LoopDeps } from "../agent/loop.js";
import { runChatTurn, resumeChatTurn } from "../agent/loop.js";
import { createSessionStore } from "../agent/session.js";
import type { ChatSession } from "../agent/session.js";
import {
  sendJson,
  readJsonBody,
  fullPath,
  toHttpError,
  type ConnectHandler,
} from "./server-api.js";
import type { JobKind, JobStore } from "./jobs.js";

/**
 * The three route matchers this module serves. `CHAT_APPROVE_RE` is checked
 * BEFORE `CHAT_SESSION_RE` since its path is a superset (method also differs:
 * approve is POST-only, rehydrate is GET-only).
 */
const CHAT_TURN_RE = /^\/api\/chat$/;
const CHAT_APPROVE_RE = /^\/api\/chat\/([^/]+)\/approve$/;
const CHAT_SESSION_RE = /^\/api\/chat\/([^/]+)$/;

/** Coerce a parsed body to a record (mirrors `server-api.ts`'s internal idiom — not exported there). */
function asRecord(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/**
 * Opens an SSE response and returns a writer for typed `ChatEvent` frames.
 * Raw Node HTTP writes — no `eventsource` dependency. `X-Accel-Buffering: no`
 * plus an explicit `flushHeaders` defeat proxy/response buffering so `token`
 * frames reach the browser as the model streams.
 */
function openSse(res: ServerResponse): (event: ChatEvent) => void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as { flushHeaders?: () => void }).flushHeaders?.();
  return (event: ChatEvent) => {
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
}

/** Writes the single-frame keyless-unavailable stream and closes it. Never calls `complete`. */
function writeUnavailable(res: ServerResponse): void {
  const write = openSse(res);
  write({
    type: "error",
    message: "Chat is unavailable — set OPENAI_API_KEY to enable the studio agent.",
    unavailable: true,
  });
  res.end();
}

/** Projects the loop's internal `PendingApproval` (call/leaf/tokens) onto the wire shape used by the `pending_approval` SSE event. */
function toPendingView(pending: PendingApproval): {
  sessionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  mutates: "write" | "destructive";
} {
  return {
    sessionId: pending.sessionId,
    toolName: pending.call.toolName,
    arguments: pending.call.arguments,
    mutates: pending.leaf.mutates as "write" | "destructive",
  };
}

/** Streams `events` through `write`, mapping a thrown error to a final `error` frame — never a dangling open stream. */
async function pipeEvents(
  events: AsyncIterable<ChatEvent>,
  write: (event: ChatEvent) => void,
): Promise<void> {
  try {
    for await (const event of events) {
      write(event);
    }
  } catch (err) {
    write({ type: "error", message: toHttpError(err).body.error });
  }
}

interface ChatTurnBody {
  sessionId?: string;
  message: string;
  context: ChatContext;
}

/** Parses + validates a `POST /api/chat` body. Returns `null` (after sending a 400) when invalid. */
function parseTurnBody(raw: unknown, res: ServerResponse): ChatTurnBody | null {
  const body = asRecord(raw);
  const message = typeof body.message === "string" ? body.message : "";
  const contextRaw = asRecord(body.context);
  if (message.trim() === "") {
    sendJson(res, 400, {
      error: "A chat turn requires a non-empty `message`.",
    });
    return null;
  }
  const directionId = typeof contextRaw.directionId === "string" ? contextRaw.directionId : undefined;
  if (directionId === undefined) {
    sendJson(res, 400, {
      error: "A chat turn requires a non-empty `context.directionId`.",
    });
    return null;
  }
  const sessionId =
    typeof body.sessionId === "string" && body.sessionId !== "" ? body.sessionId : undefined;
  return {
    sessionId,
    message,
    context: {
      directionId,
      versionId: typeof contextRaw.versionId === "string" ? contextRaw.versionId : undefined,
    },
  };
}

/**
 * `createChatApi({ cwd, jobs })` — the SSE/JSON adapter over the WS-02 agent
 * loop. A thin transport: no loop logic, confirm gate, context assembly, or
 * write path is reimplemented here — every mutation flows loop → `dispatch`
 * (= `dispatchCommand`) → core, exactly as every other front-end.
 *
 * `complete` is an optional override of the real model seam (`createComplete()`
 * from `../agent/model.js`), used by tests to inject a scripted fake so no
 * network call happens; production `serve.ts` never passes it.
 */
export function createChatApi(opts: {
  cwd: string;
  jobs: JobStore;
  complete?: CompleteFn;
}): ConnectHandler {
  const { cwd, jobs } = opts;
  const sessions = createSessionStore();
  const complete = opts.complete ?? createComplete();

  const launchJob: LaunchJobFn = (kind, tokens) => {
    const job = jobs.start(kind as JobKind, () =>
      dispatchCommand({ command: kind, input: tokens }, { defaultCwd: cwd }),
    );
    return { jobId: job.id };
  };

  const deps: LoopDeps = { complete, dispatch: dispatchCommand, launchJob, cwd };

  async function handleTurn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hasApiKey()) {
      writeUnavailable(res);
      return;
    }

    let raw: unknown;
    try {
      raw = await readJsonBody(req);
    } catch (err) {
      const { status, body } = toHttpError(err);
      sendJson(res, status, body);
      return;
    }

    const parsed = parseTurnBody(raw, res);
    if (!parsed) return;

    let session: ChatSession;
    if (parsed.sessionId) {
      const existing = sessions.get(parsed.sessionId);
      if (!existing) {
        sendJson(res, 404, { error: "Unknown chat session." });
        return;
      }
      session = existing;
    } else {
      session = sessions.create(parsed.context);
    }

    const write = openSse(res);
    await pipeEvents(runChatTurn(deps, session, parsed.message), write);
    res.end();
  }

  async function handleApprove(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string,
  ): Promise<void> {
    if (!hasApiKey()) {
      writeUnavailable(res);
      return;
    }

    let raw: unknown;
    try {
      raw = await readJsonBody(req);
    } catch (err) {
      const { status, body } = toHttpError(err);
      sendJson(res, status, body);
      return;
    }

    const body = asRecord(raw);
    if (typeof body.approve !== "boolean") {
      sendJson(res, 400, { error: "Approve requires a boolean `approve` field." });
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "Unknown chat session." });
      return;
    }

    const write = openSse(res);
    await pipeEvents(resumeChatTurn(deps, session, { approve: body.approve }), write);
    res.end();
  }

  function handleRehydrate(res: ServerResponse, sessionId: string): void {
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "Unknown chat session." });
      return;
    }
    sendJson(res, 200, {
      id: session.id,
      context: session.context,
      messages: session.messages,
      pending: session.pending ? toPendingView(session.pending) : undefined,
    });
  }

  return (req, res, next) => {
    const method = req.method ?? "GET";
    const pathname = fullPath(req);

    const approveMatch = pathname.match(CHAT_APPROVE_RE);
    if (approveMatch && method === "POST") {
      void handleApprove(req, res, decodeURIComponent(approveMatch[1])).catch((err) => {
        const { status, body } = toHttpError(err);
        sendJson(res, status, body);
      });
      return;
    }

    if (method === "POST" && CHAT_TURN_RE.test(pathname)) {
      void handleTurn(req, res).catch((err) => {
        const { status, body } = toHttpError(err);
        sendJson(res, status, body);
      });
      return;
    }

    const sessionMatch = pathname.match(CHAT_SESSION_RE);
    if (sessionMatch && method === "GET") {
      handleRehydrate(res, decodeURIComponent(sessionMatch[1]));
      return;
    }

    next();
  };
}
