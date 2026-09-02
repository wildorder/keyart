import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

// The scaffolded `keyart.config.ts` cannot be dynamically imported inside
// the vitest environment (mirrors serve-api.test.ts / smoke.test.ts) — mock
// `loadConfig` to a plain object pointing at the tmp project instead.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn() };
});

import { createChatApi } from "./chat-api.js";
import { createLocalOnlyGuard, type ConnectHandler } from "./server-api.js";
import { createJobStore, type JobStore } from "./jobs.js";
import { runInit } from "../commands/init.js";
import { runExplore } from "../commands/explore.js";
import { createBrandCore } from "../brand/core.js";
import { loadConfig } from "../config.js";
import { createDirectionCore } from "../direction/core.js";
import { getCommand, dispatchCommand } from "../mcp/registry.js";
import type { CompleteFn, ToolCall } from "../agent/model.js";
import type { ChatEvent } from "../agent/loop.js";
import type { KeyartConfig } from "../types.js";

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Chat API Test", type: "prototype", framework: "next" },
    brand: {
      root: path.join(cwd, "brand"),
      references: path.join(cwd, "brand", "input", "references"),
      approved: path.join(cwd, "brand", "approved"),
      rejected: path.join(cwd, "brand", "rejected"),
    },
    models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
    outputs: {
      cursorRules: path.join(cwd, ".cursor", "rules", "keyart-brand.mdc"),
      cssVars: path.join(cwd, "brand", "generated", "brand.css"),
      implementationBrief: path.join(cwd, "brand", "generated", "implementation-brief.md"),
    },
  };
}

// ---------------------------------------------------------------------------
// A tiny scripted, streaming fake model — exercises the transport, never the
// real model. Each call to the returned `CompleteFn` consumes the next script
// step (the last step repeats if over-consumed).
// ---------------------------------------------------------------------------

interface ScriptStep {
  deltas?: string[];
  toolCalls?: ToolCall[];
}

function scriptedComplete(steps: ScriptStep[]): CompleteFn {
  let i = 0;
  return async function* () {
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    const deltas = step.deltas ?? [];
    for (const text of deltas) {
      yield { type: "text-delta", text };
    }
    yield {
      type: "done",
      turn: {
        content: deltas.length > 0 ? deltas.join("") : undefined,
        toolCalls: step.toolCalls ?? [],
      },
    };
  };
}

// --- fake connect req/res harness (mirrors serve-api.test.ts) -------------

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  ended: boolean;
  payload?: string;
  json(): unknown;
  setHeader(k: string, v: string): void;
  write(chunk: string | Buffer): boolean;
  end(payload?: string | Buffer): void;
  flushHeaders(): void;
  _done: Promise<void>;
}

type FakeReq = Readable & {
  method: string;
  url: string;
  originalUrl: string;
  headers: Record<string, string>;
};

const LOCAL_HEADERS = { host: "127.0.0.1:4317" };

function makeReq(opts: {
  method: string;
  originalUrl: string;
  headers?: Record<string, string>;
  body?: unknown;
}): FakeReq {
  const hasBody = opts.body !== undefined;
  const raw = hasBody ? Buffer.from(JSON.stringify(opts.body)) : null;
  const req = Readable.from(raw ? [raw] : []) as FakeReq;
  req.method = opts.method;
  req.originalUrl = opts.originalUrl;
  req.url = opts.originalUrl;
  req.headers = { ...(opts.headers ?? LOCAL_HEADERS) };
  return req;
}

function makeRes(): FakeRes {
  let resolveDone: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const chunks: string[] = [];
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    ended: false,
    payload: undefined,
    json() {
      return this.payload === undefined ? undefined : JSON.parse(this.payload);
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    write(chunk) {
      chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return true;
    },
    end(payload) {
      if (payload !== undefined) {
        chunks.push(typeof payload === "string" ? payload : payload.toString("utf-8"));
      }
      this.payload = chunks.join("");
      this.ended = true;
      resolveDone();
    },
    flushHeaders() {},
    _done: done,
  };
  return res;
}

/** Splits a buffered SSE payload (`makeRes` doesn't stream) into parsed `ChatEvent` frames. */
function parseSseFrames(payload: string): ChatEvent[] {
  return payload
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) throw new Error(`SSE block missing a data line: ${block}`);
      return JSON.parse(dataLine.slice("data: ".length)) as ChatEvent;
    });
}

interface MountEntry {
  prefix: string;
  handler: ConnectHandler;
}

function pathnameOf(originalUrl: string): string {
  return new URL(originalUrl, "http://localhost").pathname;
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

function runChain(stack: MountEntry[], req: FakeReq, res: FakeRes): Promise<{ handled: boolean }> {
  const pathname = pathnameOf(req.originalUrl);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (handled: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ handled });
    };
    void res._done.then(() => settle(true));

    let i = 0;
    const next = (): void => {
      while (i < stack.length) {
        const entry = stack[i++];
        if (matchesPrefix(pathname, entry.prefix)) {
          entry.handler(
            req as unknown as Parameters<ConnectHandler>[0],
            res as unknown as ServerResponse,
            next,
          );
          return;
        }
      }
      settle(false);
    };
    next();
  });
}

function buildStack(cwd: string, jobs: JobStore, complete: CompleteFn): MountEntry[] {
  return [
    { prefix: "/api", handler: createLocalOnlyGuard() },
    { prefix: "/api/chat", handler: createChatApi({ cwd, jobs, complete }) },
  ];
}

type PendingApprovalEvent = Extract<ChatEvent, { type: "pending_approval" }>;
type JobEvent = Extract<ChatEvent, { type: "job" }>;

// ---------------------------------------------------------------------------

let tmpDir: string;
let savedKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-chat-api-"));
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
  await runInit({ cwd: tmpDir, force: true });
  // Create a direction for the chat context's focused scope.
  const core = createDirectionCore(tmpDir, await loadConfig(tmpDir));
  await core.create({ id: "moody", name: "Moody" });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = savedKey;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("createChatApi — SSE/JSON transport over the WS-02 agent loop", () => {
  it("SSE event sequence for a read-only turn (streamed prose): tool_call → tool_result → token* → assistant_message → done", async () => {
    process.env.OPENAI_API_KEY = "test";
    const jobs = createJobStore();
    const complete = scriptedComplete([
      { toolCalls: [{ id: "c1", toolName: "direction_list", arguments: {} }] },
      { deltas: ["Here ", "are ", "your directions."] },
    ]);
    const stack = buildStack(tmpDir, jobs, complete);

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/chat",
      body: { message: "what directions do we have?", context: { directionId: "moody" } },
    });
    const res = makeRes();
    await runChain(stack, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream");

    const frames = parseSseFrames(res.payload ?? "");
    expect(frames.map((f) => f.type)).toEqual([
      "tool_call",
      "tool_result",
      "token",
      "token",
      "token",
      "assistant_message",
      "done",
    ]);
    expect((frames[1] as { isError: boolean }).isError).toBe(false);
    const tokenText = frames
      .filter((f) => f.type === "token")
      .map((f) => (f as { text: string }).text)
      .join("");
    const assistantMessage = frames.find((f) => f.type === "assistant_message") as {
      text: string;
    };
    expect(tokenText).toBe(assistantMessage.text);
    expect(assistantMessage.text).toBe("Here are your directions.");
  });

  it("a mutating turn emits pending_approval and writes NOTHING; approve dispatches the exact suspended call", async () => {
    process.env.OPENAI_API_KEY = "test";
    const jobs = createJobStore();
    const complete = scriptedComplete([
      {
        toolCalls: [
          {
            id: "c1",
            toolName: "direction_feedback",
            arguments: { body: "Make it warmer and more editorial." },
          },
        ],
      },
      { deltas: ["Noted — recorded that feedback."] },
    ]);
    const stack = buildStack(tmpDir, jobs, complete);

    const turnReq = makeReq({
      method: "POST",
      originalUrl: "/api/chat",
      body: { message: "make it warmer", context: { directionId: "moody" } },
    });
    const turnRes = makeRes();
    await runChain(stack, turnReq, turnRes);

    const frames = parseSseFrames(turnRes.payload ?? "");
    expect(frames.map((f) => f.type)).toEqual(["tool_call", "pending_approval"]);
    const pending = frames[1] as PendingApprovalEvent;
    expect(pending.toolName).toBe("direction_feedback");
    expect(pending.mutates).toBe("write");
    expect(pending.sessionId).toEqual(expect.any(String));

    // Nothing written yet.
    expect(await createDirectionCore(tmpDir, await loadConfig(tmpDir)).memoryEntries("moody")).toHaveLength(0);

    // Approve → resumes the exact suspended call through dispatchCommand.
    const approveReq = makeReq({
      method: "POST",
      originalUrl: `/api/chat/${pending.sessionId}/approve`,
      body: { approve: true },
    });
    const approveRes = makeRes();
    await runChain(stack, approveReq, approveRes);

    const approveFrames = parseSseFrames(approveRes.payload ?? "");
    expect(approveFrames.map((f) => f.type)).toEqual([
      "tool_result",
      "token",
      "assistant_message",
      "done",
    ]);
    expect((approveFrames[0] as { isError: boolean }).isError).toBe(false);

    const entries = await createDirectionCore(tmpDir, await loadConfig(tmpDir)).memoryEntries("moody");
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("Make it warmer and more editorial.");
  });

  it("deny writes nothing and the turn continues; no suspended call remains", async () => {
    process.env.OPENAI_API_KEY = "test";
    const jobs = createJobStore();
    const complete = scriptedComplete([
      {
        toolCalls: [
          { id: "c1", toolName: "direction_feedback", arguments: { body: "Try something bolder." } },
        ],
      },
      { deltas: ["Understood, I won't apply that."] },
    ]);
    const stack = buildStack(tmpDir, jobs, complete);

    const turnReq = makeReq({
      method: "POST",
      originalUrl: "/api/chat",
      body: { message: "try something bolder", context: { directionId: "moody" } },
    });
    const turnRes = makeRes();
    await runChain(stack, turnReq, turnRes);
    const pending = parseSseFrames(turnRes.payload ?? "").find(
      (f) => f.type === "pending_approval",
    ) as PendingApprovalEvent;
    expect(pending).toBeDefined();

    const denyReq = makeReq({
      method: "POST",
      originalUrl: `/api/chat/${pending.sessionId}/approve`,
      body: { approve: false },
    });
    const denyRes = makeRes();
    await runChain(stack, denyReq, denyRes);

    const denyFrames = parseSseFrames(denyRes.payload ?? "");
    expect(denyFrames.map((f) => f.type)).toEqual(["tool_result", "token", "assistant_message", "done"]);
    expect((denyFrames[0] as { text: string }).text).toContain("declined");

    // Nothing was written.
    expect(await createDirectionCore(tmpDir, await loadConfig(tmpDir)).memoryEntries("moody")).toHaveLength(0);

    // No suspended call remains — a rehydrate shows `pending` cleared.
    const getReq = makeReq({ method: "GET", originalUrl: `/api/chat/${pending.sessionId}` });
    const getRes = makeRes();
    await runChain(stack, getReq, getRes);
    expect((getRes.json() as { pending?: unknown }).pending).toBeUndefined();
  });

  it("a long-running leaf returns a job event and does not block; the job settles independently", async () => {
    // `approve` never touches the model, so it settles deterministically even
    // with a (fake) key present for the chat route's gate.
    const config = await loadConfig(tmpDir);
    const explored = await runExplore({ cwd: tmpDir, directionId: "moody" });
    const directionId = explored.directionIds[0];

    process.env.OPENAI_API_KEY = "test";
    const jobs = createJobStore();
    const complete = scriptedComplete([
      { toolCalls: [{ id: "c1", toolName: "approve", arguments: {} }] },
      { deltas: ["Kicked off the approve job."] },
    ]);
    const stack = buildStack(tmpDir, jobs, complete);

    const turnReq = makeReq({
      method: "POST",
      originalUrl: "/api/chat",
      body: {
        message: "approve this direction",
        context: { directionId: directionId },
      },
    });
    const turnRes = makeRes();
    await runChain(stack, turnReq, turnRes);
    const pending = parseSseFrames(turnRes.payload ?? "").find(
      (f) => f.type === "pending_approval",
    ) as PendingApprovalEvent;
    expect(pending).toBeDefined();
    expect(pending.mutates).toBe("destructive");

    const approveReq = makeReq({
      method: "POST",
      originalUrl: `/api/chat/${pending.sessionId}/approve`,
      body: { approve: true },
    });
    const approveRes = makeRes();
    await runChain(stack, approveReq, approveRes);

    const frames = parseSseFrames(approveRes.payload ?? "");
    const jobEvent = frames.find((f) => f.type === "job") as JobEvent;
    expect(jobEvent).toBeDefined();
    expect(jobEvent.kind).toBe("approve");
    expect(frames[frames.length - 1].type).toBe("done");

    // The chat response already returned (frames collected above) — the loop
    // did not await the job. Poll it independently via the shared JobStore.
    let job = jobs.get(jobEvent.jobId);
    for (let i = 0; i < 300 && job?.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 5));
      job = jobs.get(jobEvent.jobId);
    }
    expect(job?.status).toBe("succeeded");

    const global = await createBrandCore(tmpDir, config).read();
    expect(global.approvedPointer?.directionId).toBe(directionId);
  });

  it("the local-only guard rejects a cross-origin/foreign-Host request before any session/model work", async () => {
    process.env.OPENAI_API_KEY = "test";
    const jobs = createJobStore();
    const complete = scriptedComplete([{ deltas: ["should never run"] }]);
    const completeSpy = vi.fn(complete);
    const stack = buildStack(tmpDir, jobs, completeSpy);

    const cases: { method: string; originalUrl: string; body?: unknown }[] = [
      { method: "POST", originalUrl: "/api/chat", body: { message: "hi", context: { directionId: "moody" } } },
      { method: "POST", originalUrl: "/api/chat/some-session/approve", body: { approve: true } },
      { method: "GET", originalUrl: "/api/chat/some-session" },
    ];
    for (const c of cases) {
      const req = makeReq({
        ...c,
        headers: { host: "127.0.0.1:4317", origin: "https://evil.com" },
      });
      const res = makeRes();
      await runChain(stack, req, res);
      expect(res.statusCode).toBe(403);
    }
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("the keyless path returns the explicit unavailable shape and makes no model call; GET rehydrate still works keyless", async () => {
    process.env.OPENAI_API_KEY = "test";
    const jobs = createJobStore();
    const complete = scriptedComplete([
      { toolCalls: [{ id: "c1", toolName: "direction_feedback", arguments: { body: "placeholder" } }] },
    ]);
    const completeSpy = vi.fn(complete);
    const stack = buildStack(tmpDir, jobs, completeSpy);

    // Create a suspended session while keyed, to prove GET rehydrate still
    // works once the key is removed.
    const setupReq = makeReq({
      method: "POST",
      originalUrl: "/api/chat",
      body: { message: "hi", context: { directionId: "moody" } },
    });
    const setupRes = makeRes();
    await runChain(stack, setupReq, setupRes);
    const pending = parseSseFrames(setupRes.payload ?? "").find(
      (f) => f.type === "pending_approval",
    ) as PendingApprovalEvent;
    expect(pending).toBeDefined();
    completeSpy.mockClear();

    delete process.env.OPENAI_API_KEY;

    const turnReq = makeReq({
      method: "POST",
      originalUrl: "/api/chat",
      body: { message: "hi again", context: { directionId: "moody" } },
    });
    const turnRes = makeRes();
    await runChain(stack, turnReq, turnRes);
    const turnFrames = parseSseFrames(turnRes.payload ?? "");
    expect(turnFrames).toHaveLength(1);
    expect(turnFrames[0]).toMatchObject({ type: "error", unavailable: true });
    expect((turnFrames[0] as { message: string }).message.length).toBeGreaterThan(0);

    const approveReq = makeReq({
      method: "POST",
      originalUrl: `/api/chat/${pending.sessionId}/approve`,
      body: { approve: true },
    });
    const approveRes = makeRes();
    await runChain(stack, approveReq, approveRes);
    const approveFrames = parseSseFrames(approveRes.payload ?? "");
    expect(approveFrames).toHaveLength(1);
    expect(approveFrames[0]).toMatchObject({ type: "error", unavailable: true });

    expect(completeSpy).not.toHaveBeenCalled();

    // GET rehydrate touches no model and stays available keyless.
    const getReq = makeReq({ method: "GET", originalUrl: `/api/chat/${pending.sessionId}` });
    const getRes = makeRes();
    await runChain(stack, getReq, getRes);
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json() as { id: string; pending?: { toolName: string } };
    expect(body.id).toBe(pending.sessionId);
    expect(body.pending?.toolName).toBe("direction_feedback");
  });

  it("no chat command exists on the MCP surface (SC-03) — serve/chat stay CLI-launch-only", async () => {
    expect(getCommand("chat")).toBeUndefined();
    const result = await dispatchCommand({ command: "chat", input: [] }, { defaultCwd: tmpDir });
    expect(result.isError).toBe(true);
    expect(getCommand("serve")?.dispatchable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WS-18 — transport contract: context.directionId is the one required scope
// ---------------------------------------------------------------------------

describe("POST /api/chat — context contract (WS-18)", () => {
  it("an empty context ⇒ 400 and NO model call", async () => {
    process.env.OPENAI_API_KEY = "test";
    const jobs = createJobStore();
    const completeSpy = vi.fn(scriptedComplete([{ deltas: ["never runs"] }]));
    const stack = buildStack(tmpDir, jobs, completeSpy);

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/chat",
      body: { message: "hi", context: {} },
    });
    const res = makeRes();
    await runChain(stack, req, res);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("directionId");
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it("context { directionId } is accepted as the complete scope", async () => {
    process.env.OPENAI_API_KEY = "test";
    const jobs = createJobStore();
    const complete = scriptedComplete([{ deltas: ["Hello."] }]);
    const stack = buildStack(tmpDir, jobs, complete);

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/chat",
      body: { message: "hi", context: { directionId: "moody" } },
    });
    const res = makeRes();
    await runChain(stack, req, res);

    expect(res.statusCode).toBe(200);
    const frames = parseSseFrames(res.payload ?? "");
    expect(frames[frames.length - 1].type).toBe("done");
  });

  it("context { directionId, versionId } is accepted and rehydrates verbatim; version stays optional", async () => {
    process.env.OPENAI_API_KEY = "test";
    const jobs = createJobStore();
    // A mutating call so the pending_approval frame surfaces the sessionId.
    const complete = scriptedComplete([
      { toolCalls: [{ id: "c1", toolName: "direction_feedback", arguments: { body: "warmer" } }] },
    ]);
    const stack = buildStack(tmpDir, jobs, complete);

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/chat",
      body: { message: "hi", context: { directionId: "moody", versionId: "v2" } },
    });
    const res = makeRes();
    await runChain(stack, req, res);

    expect(res.statusCode).toBe(200);
    const pending = parseSseFrames(res.payload ?? "").find(
      (f) => f.type === "pending_approval",
    ) as PendingApprovalEvent;
    expect(pending).toBeDefined();

    const getReq = makeReq({ method: "GET", originalUrl: `/api/chat/${pending.sessionId}` });
    const getRes = makeRes();
    await runChain(stack, getReq, getRes);
    expect(getRes.statusCode).toBe(200);
    const body = getRes.json() as { context: { directionId: string; versionId?: string } };
    // toEqual is exact-shape: directionId + versionId are the ONLY context keys.
    expect(body.context).toEqual({ directionId: "moody", versionId: "v2" });
    expect(Object.keys(body.context).sort()).toEqual(["directionId", "versionId"]);
  });
});
