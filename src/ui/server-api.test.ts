import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import {
  isLocalHost,
  toHttpError,
  readJsonBody,
  createLocalOnlyGuard,
  createWriteApi,
  createAssetServer,
  createUploadApi,
  createActionsApi,
  createJobsApi,
  createReconciliationApi,
  resolveUnderCwd,
  sanitizeUploadName,
  RESOURCE_ROUTE_TEMPLATES,
  type ConnectHandler,
} from "./server-api.js";
import { createJobStore } from "./jobs.js";
import { runExplore } from "../commands/explore.js";
import { appendVersionToIndex } from "../asset/asset-store.js";
import { loadConfig, directionsRoot } from "../config.js";
import { createBrandCore } from "../brand/core.js";
import { createDirectionCore } from "../direction/core.js";
import { chatJson } from "../openai.js";
import { CommandError } from "../errors.js";
import { VersionConflictError } from "../store/versioned-store.js";
import type { KeyartConfig } from "../types.js";

// Scanner-proof legacy-vocabulary probes (R-8): the runtime strings are the
// removed surface's spellings, assembled so no source literal carries them.
const LEGACY_SCOPE = ["con", "cept"].join("");
const LEGACY_WRAPPER_KEY = `${LEGACY_SCOPE}s`;
const LEGACY_ID_KEY = `${LEGACY_SCOPE}Id`;


vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn() };
});

// Wrap chatJson so the brief-map "applies on confirm" test can force a keyed
// (non-dryRun) model proposal, while every other test uses the real (keyless,
// dryRun) implementation — the same behavior CI already exercises with no key.
// NOTE: Mock hasApiKey to return false (no key) to force dry-run mode since
// .env.local may have an API key. Tests that explicitly mock chatJson still work
// because the return value is determined after module evaluation.
vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return {
    ...actual,
    chatJson: vi.fn(actual.chatJson),
    hasApiKey: vi.fn(() => false),
    createClient: vi.fn(() => null),
  };
});

// Wrap createBrandCore so a single test can force a VersionConflictError while
// every other test uses the real implementation.
vi.mock("../brand/core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../brand/core.js")>();
  return { ...actual, createBrandCore: vi.fn(actual.createBrandCore) };
});

let tmpDir: string;

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Test Project", type: "prototype", framework: "next" },
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

// --- fake req/res harness -------------------------------------------------

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  ended: boolean;
  payload?: string | Buffer;
  json(): unknown;
  setHeader(k: string, v: string): void;
  end(payload?: string | Buffer): void;
  _done: Promise<void>;
}

function makeReq(opts: {
  method: string;
  originalUrl: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Readable & { method: string; url: string; originalUrl: string; headers: Record<string, string> } {
  const hasBody = opts.body !== undefined;
  const raw = hasBody ? Buffer.from(JSON.stringify(opts.body)) : null;
  const req = Readable.from(raw ? [raw] : []) as Readable & {
    method: string;
    url: string;
    originalUrl: string;
    headers: Record<string, string>;
  };
  req.method = opts.method;
  req.originalUrl = opts.originalUrl;
  req.url = opts.originalUrl; // connect strips this; tests set originalUrl explicitly
  req.headers = opts.headers ?? { host: "127.0.0.1:4317" };
  return req;
}

/** A 1×1 PNG magic-byte prefix — enough for byte-matching + image detection. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

function buildMultipart(parts: {
  fields?: Record<string, string>;
  files?: { field: string; filename: string; contentType: string; content: Buffer }[];
}): { body: Buffer; contentType: string } {
  const boundary = "----keyarttestboundary1234";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(parts.fields ?? {})) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  for (const f of parts.files ?? []) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n` +
          `Content-Type: ${f.contentType}\r\n\r\n`,
      ),
    );
    chunks.push(f.content);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function makeMultipartReq(
  originalUrl: string,
  mp: { body: Buffer; contentType: string },
): Readable & { method: string; url: string; originalUrl: string; headers: Record<string, string> } {
  const req = Readable.from([mp.body]) as Readable & {
    method: string;
    url: string;
    originalUrl: string;
    headers: Record<string, string>;
  };
  req.method = "POST";
  req.originalUrl = originalUrl;
  req.url = originalUrl;
  req.headers = { host: "127.0.0.1:4317", "content-type": mp.contentType };
  return req;
}

function makeRes(): FakeRes {
  let resolveDone: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    ended: false,
    payload: undefined,
    json() {
      return this.payload === undefined ? undefined : JSON.parse(String(this.payload));
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(payload) {
      this.ended = true;
      this.payload = payload;
      resolveDone();
    },
    _done: done,
  };
  return res;
}

/** Drive a connect handler; resolves { nexted } when it calls next() OR ends res. */
function drive(
  handler: ConnectHandler,
  req: ReturnType<typeof makeReq>,
  res: FakeRes,
): Promise<{ nexted: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (nexted: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ nexted });
    };
    void res._done.then(() => finish(false));
    handler(req as unknown as Parameters<ConnectHandler>[0], res as unknown as ServerResponse, () =>
      finish(true),
    );
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-sapi-"));
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("isLocalHost", () => {
  it("accepts local hosts (with and without ports / IPv6)", () => {
    expect(isLocalHost("127.0.0.1:4317", undefined)).toBe(true);
    expect(isLocalHost("localhost:4317")).toBe(true);
    expect(isLocalHost("[::1]:4317")).toBe(true);
    expect(isLocalHost("localhost", "http://localhost:4317")).toBe(true);
  });

  it("rejects a remote host", () => {
    expect(isLocalHost("evil.example.com", undefined)).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
  });

  it("rejects a cross-origin request even with a local host", () => {
    expect(isLocalHost("127.0.0.1:4317", "http://evil.example.com")).toBe(false);
  });
});

describe("createLocalOnlyGuard", () => {
  it("calls next() and writes nothing for a local request", async () => {
    const guard = createLocalOnlyGuard();
    const req = makeReq({ method: "POST", originalUrl: "/api/rules", headers: { host: "127.0.0.1:4317" } });
    const res = makeRes();
    const { nexted } = await drive(guard, req, res);
    expect(nexted).toBe(true);
    expect(res.ended).toBe(false);
  });

  it("rejects a remote host with 403 and does not call next()", async () => {
    const guard = createLocalOnlyGuard();
    const req = makeReq({ method: "POST", originalUrl: "/api/rules", headers: { host: "evil.example.com" } });
    const res = makeRes();
    const { nexted } = await drive(guard, req, res);
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("rejects a cross-origin request with 403", async () => {
    const guard = createLocalOnlyGuard();
    const req = makeReq({
      method: "POST",
      originalUrl: "/api/rules",
      headers: { host: "127.0.0.1:4317", origin: "http://evil.example.com" },
    });
    const res = makeRes();
    const { nexted } = await drive(guard, req, res);
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

describe("toHttpError", () => {
  it("maps VersionConflictError → 409 with code, CommandError → 400, other → 500", () => {
    const conflict = toHttpError(new VersionConflictError("brand.yaml", 1, 2));
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("version_conflict");

    expect(toHttpError(new CommandError("bad")).status).toBe(400);
    expect(toHttpError(new Error("boom")).status).toBe(500);
    expect(toHttpError(new Error("boom")).body.error).toBe("boom");
  });
});

describe("readJsonBody", () => {
  it("parses valid JSON", async () => {
    const req = makeReq({ method: "POST", originalUrl: "/api/x", body: { a: 1 } });
    await expect(readJsonBody(req as unknown as import("node:http").IncomingMessage)).resolves.toEqual({ a: 1 });
  });

  it("returns {} for an empty body", async () => {
    const req = makeReq({ method: "POST", originalUrl: "/api/x" });
    await expect(readJsonBody(req as unknown as import("node:http").IncomingMessage)).resolves.toEqual({});
  });

  it("throws CommandError on invalid JSON", async () => {
    const req = Readable.from([Buffer.from("{ not json")]) as unknown as import("node:http").IncomingMessage;
    await expect(readJsonBody(req)).rejects.toBeInstanceOf(CommandError);
  });

  it("throws 413 when over the limit", async () => {
    const req = Readable.from([Buffer.from("x".repeat(50))]) as unknown as import("node:http").IncomingMessage;
    await expect(readJsonBody(req, { limit: 10 })).rejects.toMatchObject({ exitCode: 413 });
  });
});

describe("createWriteApi routes", () => {
  function api(): ConnectHandler {
    return createWriteApi({ cwd: tmpDir });
  }

  it("POST /api/directions mints a DRAFT on disk (201): head null, zero versions", async () => {
    const req = makeReq({ method: "POST", originalUrl: "/api/directions", body: { name: "warm" } });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(201);
    const body = res.json() as { directionId: string; name: string; isDraft: boolean };
    expect(body.isDraft).toBe(true);
    expect(body.name).toBe("warm");
    expect(JSON.stringify(body)).not.toContain(`"${LEGACY_ID_KEY}"`);

    const directionDir = path.join(tmpDir, "brand", "directions", body.directionId);
    await expect(fs.access(path.join(directionDir, "direction.yaml"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(directionDir, "brief.md"))).resolves.toBeUndefined();

    // Re-read through the core: a draft has no head and no versions yet.
    const record = await createDirectionCore(tmpDir, buildTestConfig(tmpDir)).get(body.directionId);
    expect(record.head).toBeNull();
    expect(record.versions).toEqual([]);
  });

  it("a POST to the legacy prefix is NOT handled — it is no longer owned (next())", async () => {
    const req = makeReq({ method: "POST", originalUrl: `/api/${LEGACY_WRAPPER_KEY}`, body: { name: "warm" } });
    const res = makeRes();
    const { nexted } = await drive(api(), req, res);
    expect(nexted).toBe(true);
    expect(res.ended).toBe(false);
  });

  it("POST /api/directions/:id/feedback records an entry attributed source: serve (200)", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/feedback",
      body: { body: "warmer", kind: "feedback" },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(`"${LEGACY_ID_KEY}"`);
    const entries = await createDirectionCore(tmpDir, config).memoryEntries("moody");
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("warmer");
    expect(entries[0].source).toBe("serve");
  });

  it("PATCH /api/directions/:id/brief writes fields via core (200); brief.md is the projection", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    const before = await core.get("moody");

    const req = makeReq({
      method: "PATCH",
      originalUrl: "/api/directions/moody/brief",
      body: { patch: { oneLiner: "cozy tools", tone: ["warm", "earthy"] } },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      brief: { oneLiner?: string; tone: string[] };
      renderedBrief: string;
      version: number;
    };
    // The record was updated + its version bumped, and the response carries the
    // structured brief AND its rendered projection (so the client re-seeds).
    expect(body.brief.oneLiner).toBe("cozy tools");
    expect(body.brief.tone).toEqual(["warm", "earthy"]);
    expect(body.version).toBe(before.version + 1);
    expect(body.renderedBrief).toContain("cozy tools");

    // brief.md on disk is the deterministic projection (never a raw overwrite).
    const briefPath = path.join(tmpDir, "brand", "directions", "moody", "brief.md");
    const onDisk = await fs.readFile(briefPath, "utf-8");
    expect(onDisk).toContain("cozy tools");
    expect(onDisk).toBe(body.renderedBrief);

    // Never hits a model path — no key required (SC-09 keyless form editing).
    expect(vi.mocked(chatJson)).not.toHaveBeenCalled();
  });

  it("PATCH /api/directions/:id/brief with a stale expectedVersion → 409 version_conflict", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const req = makeReq({
      method: "PATCH",
      originalUrl: "/api/directions/moody/brief",
      body: { patch: { oneLiner: "stale" }, expectedVersion: 99 },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("version_conflict");
    expect(vi.mocked(chatJson)).not.toHaveBeenCalled();
  });

  it("PATCH /api/directions/:id/brief rejects an unknown field → 400 naming valid fields", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const req = makeReq({
      method: "PATCH",
      originalUrl: "/api/directions/moody/brief",
      body: { patch: { colour: "x" } },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(400);
    const err = (res.json() as { error: string }).error;
    expect(err).toContain("colour");
    expect(err).toContain("oneLiner"); // names the valid fields
  });

  it("POST /api/directions/:id/brief/map no-ops without a key → 200 dryRun + empty patch", async () => {
    // Force dry-run behavior even if there's an API key in .env.local
    vi.mocked(chatJson).mockResolvedValueOnce({ data: null, dryRun: true });

    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/brief/map",
      body: { freeform: "warm and earthy, a bit playful, accent #ff5722" },
    });
    const res = makeRes();
    await drive(api(), req, res);

    // Never 500 without a key — an empty FIELD patch, but the deterministic hex
    // scan still surfaces the pasted color as a lock suggestion (SC-06/SC-09).
    expect(res.statusCode).toBe(200);
    const proposal = res.json() as {
      patch: Record<string, unknown>;
      hexLocks: { hex: string }[];
      dryRun: boolean;
    };
    expect(proposal.dryRun).toBe(true);
    expect(Object.keys(proposal.patch)).toHaveLength(0);
    expect(proposal.hexLocks).toContainEqual({ hex: "#ff5722" });
  });

  it("brief/map applies on confirm (mocked key): patch → field PATCH, hex → color lock", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    // Mock a keyed model proposal (tone words only — NEVER a hex as a field).
    vi.mocked(chatJson).mockResolvedValueOnce({
      data: { tone: ["warm", "editorial"], colorIntent: "warm earthy" },
      dryRun: false,
    });

    const mapReq = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/brief/map",
      body: { freeform: "warm editorial vibe, lock #ff5722 as the accent" },
    });
    const mapRes = makeRes();
    await drive(api(), mapReq, mapRes);
    expect(mapRes.statusCode).toBe(200);
    const proposal = mapRes.json() as {
      patch: { tone?: string[]; colorIntent?: string };
      hexLocks: { hex: string }[];
      dryRun: boolean;
    };
    expect(proposal.dryRun).toBe(false);
    expect(proposal.patch.tone).toEqual(["warm", "editorial"]);
    // The hex is a lock suggestion, never a brief field.
    expect(proposal.patch).not.toHaveProperty("colorIntent", "#ff5722");
    expect(proposal.hexLocks).toContainEqual({ hex: "#ff5722" });

    // Confirm (a): apply the proposed field patch.
    const patchReq = makeReq({
      method: "PATCH",
      originalUrl: "/api/directions/moody/brief",
      body: { patch: proposal.patch },
    });
    const patchRes = makeRes();
    await drive(api(), patchReq, patchRes);
    expect(patchRes.statusCode).toBe(200);

    // Confirm (b): route the hex to a color-lock decision (not a brief field).
    const lockReq = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/brief/lock",
      body: { hex: proposal.hexLocks[0].hex },
    });
    const lockRes = makeRes();
    await drive(api(), lockReq, lockRes);
    expect(lockRes.statusCode).toBe(201);

    // The record carries the mapped tone; the hex is a `decision` memory entry.
    const record = await core.get("moody");
    expect(record.brief.tone).toEqual(["warm", "editorial"]);
    const decisions = (await core.memoryEntries("moody")).filter((e) => e.kind === "decision");
    expect(decisions.some((d) => d.body.includes("#ff5722"))).toBe(true);
    // The hex never leaked into a brief field.
    expect(JSON.stringify(record.brief)).not.toContain("#ff5722");
  });

  it("POST /api/rules appends a hard rule attributed source: serve (201)", async () => {
    const req = makeReq({
      method: "POST",
      originalUrl: "/api/rules",
      body: { text: "always 8px grid", severity: "hard" },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(201);
    const brand = await createBrandCore(tmpDir, buildTestConfig(tmpDir)).read();
    expect(brand.rules).toHaveLength(1);
    expect(brand.rules[0].severity).toBe("hard");
    expect(brand.rules[0].text).toBe("always 8px grid");
    expect(brand.rules[0].source).toBe("serve");
  });

  it("POST /api/promote lifts a learning; rule source is promote:<id> (201)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.appendLearning("moody", { body: "use warm neutrals", author: "tim", source: "cli" });
    const entry = (await core.memoryEntries("moody"))[0];

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/promote",
      body: { directionId: "moody", entryId: entry.id, severity: "hard" },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(201);
    const brand = await createBrandCore(tmpDir, config).read();
    expect(brand.rules).toHaveLength(1);
    expect(brand.rules[0].text).toBe("use warm neutrals");
    expect(brand.rules[0].source).toBe("promote:moody");
  });

  it("maps a VersionConflictError to 409 with code version_conflict", async () => {
    vi.mocked(createBrandCore).mockReturnValueOnce({
      read: vi.fn(),
      setPointer: vi.fn(),
      addRule: vi.fn().mockRejectedValue(new VersionConflictError("brand.yaml", 1, 2)),
      promoteLearning: vi.fn(),
      removeRule: vi.fn(),
      editRule: vi.fn(),
    });

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/rules",
      body: { text: "stale", severity: "guideline" },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("version_conflict");
  });

  it("404s an unknown owned route but passes foreign routes through", async () => {
    const bogus = makeReq({ method: "POST", originalUrl: "/api/directions/x/bogus" });
    const bogusRes = makeRes();
    const bogusResult = await drive(api(), bogus, bogusRes);
    expect(bogusResult.nexted).toBe(false);
    expect(bogusRes.statusCode).toBe(404);

    // The old nested parent→direction shape is COLLAPSED, never renamed: a
    // legacy nested path carrying the directions segment twice is a 404.
    const nested = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/directions/dir-1/versions",
      body: {},
    });
    const nestedRes = makeRes();
    const nestedResult = await drive(api(), nested, nestedRes);
    expect(nestedResult.nexted).toBe(false);
    expect(nestedRes.statusCode).toBe(404);

    const foreign = makeReq({ method: "POST", originalUrl: "/api/uploads" });
    const foreignRes = makeRes();
    const foreignResult = await drive(api(), foreign, foreignRes);
    expect(foreignResult.nexted).toBe(true);
    expect(foreignRes.ended).toBe(false);
  });

  it("passes GET requests straight through to downstream reads", async () => {
    const req = makeReq({ method: "GET", originalUrl: "/api/dashboard" });
    const res = makeRes();
    const { nexted } = await drive(api(), req, res);
    expect(nexted).toBe(true);
    expect(res.ended).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WS-03 — actions + jobs
// ---------------------------------------------------------------------------

describe("createActionsApi + createJobsApi", () => {
  // A single shared store so a job started via the actions API is pollable via
  // the jobs API — exactly as serve.ts wires them.
  function wire(): { actions: ConnectHandler; jobs: ConnectHandler; store: ReturnType<typeof createJobStore> } {
    const store = createJobStore();
    return {
      actions: createActionsApi({ cwd: tmpDir, jobs: store }),
      jobs: createJobsApi({ jobs: store }),
      store,
    };
  }

  async function pollJob(
    jobsApi: ConnectHandler,
    id: string,
  ): Promise<{ status: string; result?: unknown; error?: string }> {
    for (let i = 0; i < 300; i++) {
      const req = makeReq({ method: "GET", originalUrl: `/api/jobs/${id}` });
      const res = makeRes();
      await drive(jobsApi, req, res);
      expect(res.statusCode).toBe(200);
      const job = res.json() as { status: string; result?: unknown; error?: string };
      if (job.status !== "running") return job;
      // Real-time wait so the job's disk I/O has wall-clock to complete.
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`job ${id} never settled`);
  }

  it("POST /api/actions/explore → 202 + jobId", async () => {
    const { actions, jobs } = wire();
    // Create a direction first, as explore requires a seed direction.
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/actions/explore",
      body: { directionId: "moody" },
    });
    const res = makeRes();
    await drive(actions, req, res);

    expect(res.statusCode).toBe(202);
    const body = res.json() as { jobId: string };
    expect(typeof body.jobId).toBe("string");
    expect(body.jobId.length).toBeGreaterThan(0);
  });

  it("explore job runs end-to-end (dry-run) and writes direction-version artifacts", async () => {
    const { actions, jobs } = wire();
    // Create a direction first, as explore requires a seed direction.
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const kickoff = makeReq({
      method: "POST",
      originalUrl: "/api/actions/explore",
      body: { directionId: "moody" },
    });
    const kickoffRes = makeRes();
    await drive(actions, kickoff, kickoffRes);
    expect(kickoffRes.statusCode).toBe(202);
    const { jobId } = kickoffRes.json() as { jobId: string };

    const settled = await pollJob(jobs, jobId);
    expect(settled.status).toBe("succeeded");

    const result = settled.result as { directionIds: string[]; direction: string };
    expect(result.direction).toBe("moody");
    expect(result.directionIds.length).toBeGreaterThan(0);
    // The explore actually happened: sibling directions exist on disk, each with
    // a v1 index (no run folder, no directions.json batch file).
    const directionsDir = path.join(tmpDir, "brand", "directions");
    const dirIds = (await fs.readdir(directionsDir)).filter((e) => e !== ".gitkeep");
    expect(dirIds).toEqual(expect.arrayContaining(result.directionIds));
    await expect(
      fs.access(path.join(directionsDir, result.directionIds[0], "direction.yaml")),
    ).resolves.toBeUndefined();
  });

  it("explore { directionId: <draft> } → 202 + jobId; the job writes exactly one v1 into that draft", async () => {
    const { actions, jobs } = wire();
    const config = buildTestConfig(tmpDir);
    // A DRAFT direction: created with zero versions — positional explore's target.
    await createDirectionCore(tmpDir, config).create({ id: "draft-dir", name: "Draft Dir" });

    const kickoff = makeReq({
      method: "POST",
      originalUrl: "/api/actions/explore",
      body: { directionId: "draft-dir" },
    });
    const kickoffRes = makeRes();
    await drive(actions, kickoff, kickoffRes);
    expect(kickoffRes.statusCode).toBe(202);
    const { jobId } = kickoffRes.json() as { jobId: string };
    expect(typeof jobId).toBe("string");

    const settled = await pollJob(jobs, jobId);
    expect(settled.status).toBe("succeeded");
    const result = settled.result as { directionIds: string[] };
    // Positional mode mints nothing — it writes INTO the addressed draft.
    expect(result.directionIds).toEqual(["draft-dir"]);
    const versionsDir = path.join(tmpDir, "brand", "directions", "draft-dir", "versions");
    const versions = await fs.readdir(versionsDir);
    expect(versions).toHaveLength(1);
  });

  it("explore { describe, count: 2 } → the job mints two new directions", async () => {
    const { actions, jobs } = wire();

    const kickoff = makeReq({
      method: "POST",
      originalUrl: "/api/actions/explore",
      body: { describe: "seed", count: 2 },
    });
    const kickoffRes = makeRes();
    await drive(actions, kickoff, kickoffRes);
    expect(kickoffRes.statusCode).toBe(202);
    const { jobId } = kickoffRes.json() as { jobId: string };

    const settled = await pollJob(jobs, jobId);
    expect(settled.status).toBe("succeeded");
    const result = settled.result as { directionIds: string[] };
    expect(result.directionIds).toHaveLength(2);
    // Minted ids are never hardcoded — assert each exists on disk with a v1.
    const directionsDir = path.join(tmpDir, "brand", "directions");
    for (const id of result.directionIds) {
      await expect(
        fs.access(path.join(directionsDir, id, "direction.yaml")),
      ).resolves.toBeUndefined();
      expect(await fs.readdir(path.join(directionsDir, id, "versions"))).toHaveLength(1);
    }
  });

  it("explore with neither directionId/describe/from → 4xx teaching error (no job started)", async () => {
    const { actions, store } = wire();
    const req = makeReq({
      method: "POST",
      originalUrl: "/api/actions/explore",
      body: {},
    });
    const res = makeRes();
    await drive(actions, req, res);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/directionId/);
    expect((res.json() as { error: string }).error).toMatch(/describe/);
    expect(store.list()).toHaveLength(0);
  });

  it("explore with ONLY the legacy parent-alias key → 4xx (the alias is gone)", async () => {
    const { actions, store } = wire();
    const req = makeReq({
      method: "POST",
      originalUrl: "/api/actions/explore",
      body: { [LEGACY_SCOPE]: "moody" },
    });
    const res = makeRes();
    await drive(actions, req, res);
    expect(res.statusCode).toBe(400);
    expect(store.list()).toHaveLength(0);
  });

  it("POST /api/actions/approve missing directionId → 400 (a stray runId is ignored)", async () => {
    const { actions } = wire();
    // A body carrying only a legacy `runId` (no directionId) → 400.
    const req = makeReq({ method: "POST", originalUrl: "/api/actions/approve", body: { runId: "r1" } });
    const res = makeRes();
    await drive(actions, req, res);
    expect(res.statusCode).toBe(400);

    const req2 = makeReq({ method: "POST", originalUrl: "/api/actions/approve", body: {} });
    const res2 = makeRes();
    await drive(actions, req2, res2);
    expect(res2.statusCode).toBe(400);
  });

  it("POST /api/actions/regenerate with locks + note → 202 + jobId; missing directionId → 400", async () => {
    const { actions } = wire();

    // Well-formed kickoff carrying locked roles, an explicit locked color, and a
    // generic feedback note → 202 (the job itself runs async; we assert kickoff).
    // A stray `runId` in the body is ignored (no run addressing).
    const ok = makeReq({
      method: "POST",
      originalUrl: "/api/actions/regenerate",
      body: {
        runId: "ignored",
        directionId: "d1",
        lockedRoles: ["primary"],
        lockedColors: [{ role: "accent", hex: "#abcdef" }],
        feedback: "warmer, more editorial",
      },
    });
    const okRes = makeRes();
    await drive(actions, ok, okRes);
    expect(okRes.statusCode).toBe(202);
    expect(typeof (okRes.json() as { jobId: string }).jobId).toBe("string");

    // A malformed locked color hex is a hard 400 (validated at parse time).
    const badHex = makeReq({
      method: "POST",
      originalUrl: "/api/actions/regenerate",
      body: { directionId: "d1", lockedColors: [{ hex: "nope" }] },
    });
    const badHexRes = makeRes();
    await drive(actions, badHex, badHexRes);
    expect(badHexRes.statusCode).toBe(400);

    // Missing directionId → 400.
    const bad = makeReq({
      method: "POST",
      originalUrl: "/api/actions/regenerate",
      body: { feedback: "warmer" },
    });
    const badRes = makeRes();
    await drive(actions, bad, badRes);
    expect(badRes.statusCode).toBe(400);
  });

  it("POST /api/actions/audit → 202 + jobId (not awaited)", async () => {
    const { actions } = wire();
    const req = makeReq({
      method: "POST",
      originalUrl: "/api/actions/audit",
      body: { url: "http://example.com" },
    });
    const res = makeRes();
    await drive(actions, req, res);

    expect(res.statusCode).toBe(202);
    expect(typeof (res.json() as { jobId: string }).jobId).toBe("string");
  });

  it("audit missing url → 400", async () => {
    const { actions } = wire();
    const req = makeReq({ method: "POST", originalUrl: "/api/actions/audit", body: {} });
    const res = makeRes();
    await drive(actions, req, res);
    expect(res.statusCode).toBe(400);
  });

  it("unknown action → 404; unknown job → 404", async () => {
    const { actions, jobs } = wire();
    const bogus = makeReq({ method: "POST", originalUrl: "/api/actions/bogus", body: {} });
    const bogusRes = makeRes();
    await drive(actions, bogus, bogusRes);
    expect(bogusRes.statusCode).toBe(404);

    const missing = makeReq({ method: "GET", originalUrl: "/api/jobs/nope" });
    const missingRes = makeRes();
    await drive(jobs, missing, missingRes);
    expect(missingRes.statusCode).toBe(404);
  });

  it("passes non-POST actions and non-GET job requests through to next()", async () => {
    const { actions, jobs } = wire();
    const getAction = makeReq({ method: "GET", originalUrl: "/api/actions/explore" });
    const getActionRes = makeRes();
    const a = await drive(actions, getAction, getActionRes);
    expect(a.nexted).toBe(true);

    const postJob = makeReq({ method: "POST", originalUrl: "/api/jobs/x", body: {} });
    const postJobRes = makeRes();
    const j = await drive(jobs, postJob, postJobRes);
    expect(j.nexted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WS-02 — path safety helpers
// ---------------------------------------------------------------------------

describe("resolveUnderCwd", () => {
  it("returns absolute paths that stay under cwd and throws 403 on escape", () => {
    const cwd = tmpDir;
    expect(resolveUnderCwd(cwd, "brand/x.png")).toBe(path.join(cwd, "brand", "x.png"));
    expect(resolveUnderCwd(cwd, ".")).toBe(path.resolve(cwd));
    expect(() => resolveUnderCwd(cwd, "../../etc/passwd")).toThrow(CommandError);
    expect(() => resolveUnderCwd(cwd, "/etc/passwd")).toThrow(/Forbidden/);
  });
});

describe("sanitizeUploadName", () => {
  it("reduces names to safe basenames without separators", () => {
    expect(sanitizeUploadName("../../evil .png")).toBe("evil-.png");
    expect(sanitizeUploadName("a/b/c.png")).toBe("c.png");
    expect(sanitizeUploadName("weird***name.PNG")).toBe("weird-name.PNG");
    expect(sanitizeUploadName("....")).toMatch(/^upload-\d+$/);
    // Never contains a path separator.
    expect(sanitizeUploadName("a/../../b.png")).not.toMatch(/[\\/]/);
  });
});

// ---------------------------------------------------------------------------
// WS-02 — GET /api/asset
// ---------------------------------------------------------------------------

describe("createAssetServer", () => {
  function asset(): ConnectHandler {
    return createAssetServer({ cwd: tmpDir });
  }

  it("serves an image with the right Content-Type and byte-identical body", async () => {
    const file = path.join(tmpDir, "brand", "x.png");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, PNG_BYTES);

    const req = makeReq({ method: "GET", originalUrl: "/api/asset?path=brand/x.png" });
    const res = makeRes();
    await drive(asset(), req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(Buffer.isBuffer(res.payload)).toBe(true);
    expect((res.payload as Buffer).equals(PNG_BYTES)).toBe(true);
  });

  it("400s a missing ?path=", async () => {
    const req = makeReq({ method: "GET", originalUrl: "/api/asset" });
    const res = makeRes();
    await drive(asset(), req, res);
    expect(res.statusCode).toBe(400);
  });

  it("blocks traversal (403), non-image extensions (415), and missing files (404)", async () => {
    const traverse = makeReq({ method: "GET", originalUrl: "/api/asset?path=../../etc/passwd" });
    const traverseRes = makeRes();
    await drive(asset(), traverse, traverseRes);
    expect(traverseRes.statusCode).toBe(403);

    const nonImage = makeReq({ method: "GET", originalUrl: "/api/asset?path=brand/secret.txt" });
    const nonImageRes = makeRes();
    await drive(asset(), nonImage, nonImageRes);
    expect(nonImageRes.statusCode).toBe(415);

    const missing = makeReq({ method: "GET", originalUrl: "/api/asset?path=brand/nope.png" });
    const missingRes = makeRes();
    await drive(asset(), missing, missingRes);
    expect(missingRes.statusCode).toBe(404);
  });

  it("passes non-GET/HEAD methods through to next()", async () => {
    const req = makeReq({ method: "POST", originalUrl: "/api/asset?path=brand/x.png" });
    const res = makeRes();
    const { nexted } = await drive(asset(), req, res);
    expect(nexted).toBe(true);
    expect(res.ended).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WS-02 — POST /api/uploads
// ---------------------------------------------------------------------------

describe("createUploadApi", () => {
  function upload(): ConnectHandler {
    return createUploadApi({ cwd: tmpDir });
  }

  it("uploads to references (no directionId) → 201, sanitized file on disk, registered:false", async () => {
    const mp = buildMultipart({
      files: [{ field: "file", filename: "hero shot.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const req = makeMultipartReq("/api/uploads", mp);
    const res = makeRes();
    await drive(upload(), req, res);

    expect(res.statusCode).toBe(201);
    const body = res.json() as { ok: boolean; files: { path: string; registered: boolean }[] };
    expect(body.ok).toBe(true);
    expect(body.files).toHaveLength(1);
    expect(body.files[0].registered).toBe(false);
    expect(body.files[0].path).toBe("brand/input/references/hero-shot.png");

    const onDisk = path.join(tmpDir, "brand", "input", "references", "hero-shot.png");
    expect(await fs.readFile(onDisk)).toEqual(PNG_BYTES);
  });

  it("uploads to a direction (directionId) → 201, file under assets/, registered AssetRef", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const mp = buildMultipart({
      fields: { directionId: "moody" },
      files: [{ field: "file", filename: "board.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const req = makeMultipartReq("/api/uploads", mp);
    const res = makeRes();
    await drive(upload(), req, res);

    expect(res.statusCode).toBe(201);
    const body = res.json() as { files: { path: string; registered: boolean }[] };
    expect(body.files[0].registered).toBe(true);
    expect(body.files[0].path).toBe("brand/directions/moody/assets/board.png");

    const onDisk = path.join(tmpDir, "brand", "directions", "moody", "assets", "board.png");
    expect(await fs.readFile(onDisk)).toEqual(PNG_BYTES);

    const record = await createDirectionCore(tmpDir, config).get("moody");
    // Uploads now stamp a reference intent (WS-05/06), defaulting to "inspire".
    expect(record.assets).toContainEqual({
      kind: "image",
      path: "brand/directions/moody/assets/board.png",
      intent: "inspire",
    });
  });

  it("uploading to a non-existent direction fails cleanly (400) without writing", async () => {
    const mp = buildMultipart({
      fields: { directionId: "ghost" },
      files: [{ field: "file", filename: "x.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const req = makeMultipartReq("/api/uploads", mp);
    const res = makeRes();
    await drive(upload(), req, res);

    expect(res.statusCode).toBe(400);
    await expect(
      fs.stat(path.join(tmpDir, "brand", "directions", "ghost")),
    ).rejects.toThrow();
  });

  it("sanitizes filenames and never clobbers — same name twice yields two files", async () => {
    const first = buildMultipart({
      files: [{ field: "file", filename: "../../evil .png", contentType: "image/png", content: PNG_BYTES }],
    });
    const firstRes = makeRes();
    await drive(upload(), makeMultipartReq("/api/uploads", first), firstRes);
    expect(firstRes.statusCode).toBe(201);
    expect((firstRes.json() as { files: { path: string }[] }).files[0].path).toBe(
      "brand/input/references/evil-.png",
    );

    const second = buildMultipart({
      files: [{ field: "file", filename: "../../evil .png", contentType: "image/png", content: PNG_BYTES }],
    });
    const secondRes = makeRes();
    await drive(upload(), makeMultipartReq("/api/uploads", second), secondRes);
    expect(secondRes.statusCode).toBe(201);
    // Disambiguated, not overwritten.
    expect((secondRes.json() as { files: { path: string }[] }).files[0].path).toBe(
      "brand/input/references/evil--1.png",
    );

    const refsDir = path.join(tmpDir, "brand", "input", "references");
    const entries = (await fs.readdir(refsDir)).sort();
    expect(entries).toEqual(["evil--1.png", "evil-.png"]);
  });

  it("rejects a non-image upload with 415", async () => {
    const mp = buildMultipart({
      files: [{ field: "file", filename: "payload.exe", contentType: "application/octet-stream", content: Buffer.from("MZ") }],
    });
    const req = makeMultipartReq("/api/uploads", mp);
    const res = makeRes();
    await drive(upload(), req, res);
    expect(res.statusCode).toBe(415);

    // Nothing written to references.
    await expect(
      fs.stat(path.join(tmpDir, "brand", "input", "references", "payload.exe")),
    ).rejects.toThrow();
  });

  it("rejects an oversize upload with 413", async () => {
    const big = Buffer.alloc(15 * 1024 * 1024 + 1024, 0x41);
    const mp = buildMultipart({
      files: [{ field: "file", filename: "huge.png", contentType: "image/png", content: big }],
    });
    const req = makeMultipartReq("/api/uploads", mp);
    const res = makeRes();
    await drive(upload(), req, res);
    expect(res.statusCode).toBe(413);
  });

  it("passes non-POST methods through to next()", async () => {
    const req = makeReq({ method: "GET", originalUrl: "/api/uploads" });
    const res = makeRes();
    const { nexted } = await drive(upload(), req, res);
    expect(nexted).toBe(true);
    expect(res.ended).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WS-06 — authoring channel/polarity on rules + decisions; reconcile dispatch
// ---------------------------------------------------------------------------

describe("WS-06 — channel/polarity authoring + reconciliation", () => {
  function api(): ConnectHandler {
    return createWriteApi({ cwd: tmpDir });
  }
  function reconcileApi(): ConnectHandler {
    return createReconciliationApi({ cwd: tmpDir });
  }

  it("POST /api/rules with channel/polarity persists them via core (201)", async () => {
    const req = makeReq({
      method: "POST",
      originalUrl: "/api/rules",
      body: { text: "no stock-photo hands", severity: "hard", channel: "visual", polarity: "avoid" },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(201);
    const brand = await createBrandCore(tmpDir, buildTestConfig(tmpDir)).read();
    expect(brand.rules).toHaveLength(1);
    expect(brand.rules[0].channel).toBe("visual");
    expect(brand.rules[0].polarity).toBe("avoid");
  });

  it("POST /api/directions/:id/feedback with kind:decision + channel/polarity persists them (200)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/feedback",
      body: { body: "always bold icons", kind: "decision", channel: "visual", polarity: "avoid" },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(200);
    const entries = (await core.memoryEntries("moody")).filter((e) => e.kind === "decision");
    expect(entries).toHaveLength(1);
    expect(entries[0].channel).toBe("visual");
    expect(entries[0].polarity).toBe("avoid");
  });

  it("reconcile GET lists contradictions (200, empty list is safe)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const req = makeReq({ method: "GET", originalUrl: "/api/directions/moody/reconciliation" });
    const res = makeRes();
    await drive(reconcileApi(), req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(`"${LEGACY_ID_KEY}"`);
    const body = res.json() as { directionId: string; report: { items: unknown[] }; memoryVersion: number; globalVersion: number };
    expect(body.directionId).toBe("moody");
    expect(Array.isArray(body.report.items)).toBe(true);
    expect(typeof body.memoryVersion).toBe("number");
    expect(typeof body.globalVersion).toBe("number");
  });

  it("reconcile resolve retire: retires target entry and bumps record version (200)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    // Add a decision entry to retire.
    await core.appendDecision("moody", { body: "stale decision", author: "tim", source: "cli" });
    const entries = await core.memoryEntries("moody");
    const target = entries[0];

    const mem = await core.readMemory("moody");
    const brand = await createBrandCore(tmpDir, config).read();

    // Build a minimal Contradiction that points to this entry as the conflictsWith side.
    const contradiction = {
      id: "test-c1",
      kind: "memory-vs-memory",
      subject: { source: "memory", id: "other-id", text: "other decision" },
      conflictsWith: { source: "memory", id: target.id, text: target.body },
      severity: "info",
      explanation: "These two decisions conflict.",
      suggestions: ["retire"],
    };

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/reconciliation/resolve",
      body: {
        contradiction,
        action: "retire",
        winner: "subject",
        expectedMemoryVersion: mem.version,
        expectedGlobalVersion: brand.version,
      },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(200);
    // The target entry is now retired (non-destructive). includeRetired: true —
    // the WS-01 default view excludes retired entries; assert against the store.
    const afterEntries = await core.memoryEntries("moody", { includeRetired: true });
    const retired = afterEntries.find((e) => e.id === target.id)!;
    expect(retired).toBeDefined();
    expect(retired.retiredAt).toBeTruthy();
    // Record version bumped.
    const afterMem = await core.readMemory("moody");
    expect(afterMem.version).toBeGreaterThan(mem.version);
  });

  it("reconcile resolve with stale expectedMemoryVersion → 409 version_conflict", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.appendDecision("moody", { body: "stale decision", author: "tim", source: "cli" });
    const entries = await core.memoryEntries("moody");
    const target = entries[0];

    const brand = await createBrandCore(tmpDir, config).read();

    const contradiction = {
      id: "test-c2",
      kind: "memory-vs-memory",
      subject: { source: "memory", id: "other-id", text: "other" },
      conflictsWith: { source: "memory", id: target.id, text: target.body },
      severity: "info",
      explanation: "conflict",
      suggestions: ["retire"],
    };

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/reconciliation/resolve",
      body: {
        contradiction,
        action: "retire",
        winner: "subject",
        expectedMemoryVersion: 9999,
        expectedGlobalVersion: brand.version,
      },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("version_conflict");
  });

  it("reconcile resolve promote lifts to global (200)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.appendLearning("moody", { body: "use warm neutrals for premium feel", author: "tim", source: "cli" });
    const entries = await core.memoryEntries("moody");
    const learning = entries[0];

    const mem = await core.readMemory("moody");
    const brandBefore = await createBrandCore(tmpDir, config).read();

    const contradiction = {
      id: "test-c3",
      kind: "memory-vs-memory",
      subject: { source: "memory", id: learning.id, text: learning.body },
      conflictsWith: { source: "memory", id: "other-id", text: "other" },
      severity: "info",
      explanation: "learning worth promoting",
      suggestions: ["promote"],
    };

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/reconciliation/resolve",
      body: {
        contradiction,
        action: "promote",
        winner: "subject",
        severity: "guideline",
        expectedMemoryVersion: mem.version,
        expectedGlobalVersion: brandBefore.version,
      },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(200);
    const brandAfter = await createBrandCore(tmpDir, config).read();
    expect(brandAfter.rules.some((r) => r.text === learning.body)).toBe(true);
  });

  it("local-only: reconcile resolve from a remote host is rejected 403", async () => {
    const guard = createLocalOnlyGuard();
    const req = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/reconciliation/resolve",
      headers: { host: "evil.example.com" },
      body: { action: "keep" },
    });
    const res = makeRes();
    const { nexted } = await drive(guard, req, res);
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// WS-18 — the canonical route table
// ---------------------------------------------------------------------------

describe("RESOURCE_ROUTE_TEMPLATES (WS-18 route table)", () => {
  it("every template carries the directions segment at most once and never a legacy segment", () => {
    expect(RESOURCE_ROUTE_TEMPLATES.length).toBeGreaterThan(0);
    for (const template of RESOURCE_ROUTE_TEMPLATES) {
      const [method, routePath] = template.split(" ");
      expect(method).toMatch(/^(GET|POST|PUT|PATCH|DELETE)$/);
      expect(routePath.startsWith("/api/")).toBe(true);
      const segments = routePath.split("/").filter((s) => s !== "");
      expect(segments.filter((s) => s === "directions").length).toBeLessThanOrEqual(1);
      expect(segments).not.toContain(LEGACY_WRAPPER_KEY);
    }
  });

  it("the local-only guard still 403s a renamed route for a non-local Origin/Host", async () => {
    const guard = createLocalOnlyGuard();

    const crossOrigin = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/versions",
      headers: { host: "127.0.0.1:4317", origin: "http://evil.example.com" },
      body: {},
    });
    const crossOriginRes = makeRes();
    const crossOriginResult = await drive(guard, crossOrigin, crossOriginRes);
    expect(crossOriginResult.nexted).toBe(false);
    expect(crossOriginRes.statusCode).toBe(403);

    const foreignHost = makeReq({
      method: "PUT",
      originalUrl: "/api/directions/moody",
      headers: { host: "evil.example.com" },
      body: {},
    });
    const foreignHostRes = makeRes();
    const foreignHostResult = await drive(guard, foreignHost, foreignHostRes);
    expect(foreignHostResult.nexted).toBe(false);
    expect(foreignHostRes.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// WS-18 — collapsed direction routes (ONE id: the aggregate root)
// ---------------------------------------------------------------------------

describe("WS-18 — collapsed direction routes", () => {
  function api(): ConnectHandler {
    return createWriteApi({ cwd: tmpDir });
  }

  /** Seed a direction and (dry-run) explore v1 into it so it has a head. */
  async function seedWithHead(id: string): Promise<ReturnType<typeof createDirectionCore>> {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id, name: id });
    await runExplore({ cwd: tmpDir, directionId: id });
    return core;
  }

  it("POST /api/directions/:id/versions appends a NEW version to that direction (201)", async () => {
    const core = await seedWithHead("moody");
    const before = await core.get("moody");
    expect(before.head).not.toBeNull();
    expect(before.versions).toHaveLength(1);

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/versions",
      body: { summary: "A warmer second take." },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(201);
    const body = res.json() as { directionId: string; versionId: string };
    expect(body.directionId).toBe("moody");
    expect(JSON.stringify(body)).not.toContain(`"${LEGACY_ID_KEY}"`);

    // Re-reading shows the new head belongs to THIS direction.
    const after = await core.get("moody");
    expect(after.head).toBe(body.versionId);
    expect(after.versions).toHaveLength(2);
    expect(after.versions).toContain(before.head);
    expect(after.versions).toContain(body.versionId);
  });

  it("PUT /api/directions/:id edits the head IN PLACE (200): no new version appended", async () => {
    const core = await seedWithHead("moody");
    const before = await core.get("moody");

    const req = makeReq({
      method: "PUT",
      originalUrl: "/api/directions/moody",
      body: { summary: "Edited in place." },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { directionId: string; versionId: string };
    expect(body.directionId).toBe("moody");
    expect(body.versionId).toBe(before.head);
    expect(JSON.stringify(body)).not.toContain(`"${LEGACY_ID_KEY}"`);

    const after = await core.get("moody");
    expect(after.head).toBe(before.head);
    expect(after.versions).toEqual(before.versions);
  });

  it("POST /api/directions/:sourceId/create mints a NEW direction seeded by :sourceId (201)", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/create",
      body: {
        name: "Bold Modern",
        summary: "A strong, geometric direction for a tech startup.",
        character: { mood: "confident, energetic" },
        usage: {
          rules: ["use the primary role for all CTAs"],
          antiRules: ["never use the muted role for critical UI"],
        },
        copyExamples: { headline: "Built for what comes next" },
      },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(201);
    const body = res.json() as { sourceId: string; directionId: string; versionId: string };
    expect(body.sourceId).toBe("moody");
    expect(body.directionId).not.toBe("moody");
    expect(JSON.stringify(body)).not.toContain(`"${LEGACY_ID_KEY}"`);

    // The minted direction is real, with its own v1 on disk.
    const minted = await createDirectionCore(tmpDir, config).get(body.directionId);
    expect(minted.head).toBe(body.versionId);
    expect(minted.versions).toEqual([body.versionId]);
  });

  it("POST /api/directions/:sourceId/fork { count: 2 } → 201, distinct forks, source byte-unchanged", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const recordPath = path.join(directionsRoot(tmpDir, config), "moody", "direction.yaml");
    const bytesBefore = await fs.readFile(recordPath);

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/fork",
      body: { count: 2 },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(201);
    const body = res.json() as { sourceId: string; forks: { directionId: string }[] };
    expect(body.sourceId).toBe("moody");
    expect(body.forks).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain(`"${LEGACY_ID_KEY}"`);

    const ids = body.forks.map((f) => f.directionId);
    // Pairwise distinct, and none equals the source.
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).not.toBe("moody");
      await expect(
        fs.access(path.join(directionsRoot(tmpDir, config), id, "direction.yaml")),
      ).resolves.toBeUndefined();
    }

    // The SOURCE record on disk is byte-unchanged by the fork.
    const bytesAfter = await fs.readFile(recordPath);
    expect(bytesAfter.equals(bytesBefore)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WS-18 — renamed lifecycle routes (memory / assets / extracted-assets)
// ---------------------------------------------------------------------------

describe("WS-18 — memory + asset lifecycle routes", () => {
  function api(): ConnectHandler {
    return createWriteApi({ cwd: tmpDir });
  }

  it("PATCH /api/directions/:id/memory/:entryId supersedes the entry (200, directionId keys only)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.appendFeedback("moody", { body: "too dark", author: "tim", source: "cli" });
    const entry = (await core.memoryEntries("moody"))[0];

    const req = makeReq({
      method: "PATCH",
      originalUrl: `/api/directions/moody/memory/${entry.id}`,
      body: { body: "too dark — try a warmer base" },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { action: string; directionId: string; entryId: string };
    expect(body.action).toBe("edit");
    expect(body.directionId).toBe("moody");
    expect(JSON.stringify(body)).not.toContain(`"${LEGACY_ID_KEY}"`);
  });

  it("DELETE /api/directions/:id/memory/:entryId retires the entry (200)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.appendFeedback("moody", { body: "stale note", author: "tim", source: "cli" });
    const entry = (await core.memoryEntries("moody"))[0];

    const req = makeReq({
      method: "DELETE",
      originalUrl: `/api/directions/moody/memory/${entry.id}`,
      body: { reason: "superseded" },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { action: string; directionId: string };
    expect(body.action).toBe("delete");
    expect(body.directionId).toBe("moody");
    expect(JSON.stringify(body)).not.toContain(`"${LEGACY_ID_KEY}"`);

    // Non-destructive: the entry is retired, not gone. The retire appends its
    // OWN attributed audit `learning`, so assert exclusion, not emptiness.
    const after = await core.memoryEntries("moody", { includeRetired: true });
    expect(after.find((e) => e.id === entry.id)?.retiredAt).toBeTruthy();
    const active = await core.memoryEntries("moody");
    expect(active.some((e) => e.id === entry.id)).toBe(false);
  });

  it('POST /api/directions/:id/memory/:entryId/promote requires to: "global" and lifts the entry (200)', async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.appendLearning("moody", { body: "use warm neutrals", author: "tim", source: "cli" });
    const entry = (await core.memoryEntries("moody"))[0];

    // Missing `to` → 400 teaching error, passed through unchanged.
    const missingTo = makeReq({
      method: "POST",
      originalUrl: `/api/directions/moody/memory/${entry.id}/promote`,
      body: {},
    });
    const missingToRes = makeRes();
    await drive(api(), missingTo, missingToRes);
    expect(missingToRes.statusCode).toBe(400);
    expect((missingToRes.json() as { error: string }).error).toContain("global");

    const req = makeReq({
      method: "POST",
      originalUrl: `/api/directions/moody/memory/${entry.id}/promote`,
      body: { to: "global", severity: "guideline" },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { action: string; directionId: string; to: string };
    expect(body.action).toBe("promote");
    expect(body.directionId).toBe("moody");
    expect(body.to).toBe("global");
    expect(JSON.stringify(body)).not.toContain(`"${LEGACY_ID_KEY}"`);

    const brand = await createBrandCore(tmpDir, config).read();
    expect(brand.rules.some((r) => r.text === "use warm neutrals")).toBe(true);
  });

  it("DELETE /api/directions/:id/assets retires a kept-crop AssetRef (200)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.addAsset("moody", {
      kind: "image",
      path: "brand/directions/moody/assets/crop.png",
      intent: "inspire",
    });

    const req = makeReq({
      method: "DELETE",
      originalUrl: "/api/directions/moody/assets",
      body: { path: "brand/directions/moody/assets/crop.png" },
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; directionId: string; asset?: { retiredAt?: string } };
    expect(body.ok).toBe(true);
    expect(body.directionId).toBe("moody");
    expect(body.asset?.retiredAt).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(`"${LEGACY_ID_KEY}"`);
  });

  it("DELETE /api/directions/:id/extracted-assets/:assetId retires the extracted asset (200); unknown ids 404", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    // Seed one extracted asset directly through the store.
    const directionDir = path.join(directionsRoot(tmpDir, config), "moody");
    await appendVersionToIndex(
      directionDir,
      "logo",
      { name: "Logo", directionId: "moody" },
      {
        id: "v1",
        createdAt: new Date().toISOString(),
        description: "a mark",
        source: { directionId: "moody", versionId: "v1", image: "styleTile" },
        files: [],
      },
    );

    const req = makeReq({
      method: "DELETE",
      originalUrl: "/api/directions/moody/extracted-assets/logo",
    });
    const res = makeRes();
    await drive(api(), req, res);

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; directionId: string; assetId: string; retiredAt?: string };
    expect(body.ok).toBe(true);
    expect(body.directionId).toBe("moody");
    expect(body.assetId).toBe("logo");
    expect(body.retiredAt).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain(`"${LEGACY_ID_KEY}"`);

    // Unknown direction / unknown asset → 404, not 400.
    const ghostDir = makeReq({
      method: "DELETE",
      originalUrl: "/api/directions/ghost/extracted-assets/logo",
    });
    const ghostDirRes = makeRes();
    await drive(api(), ghostDir, ghostDirRes);
    expect(ghostDirRes.statusCode).toBe(404);

    const ghostAsset = makeReq({
      method: "DELETE",
      originalUrl: "/api/directions/moody/extracted-assets/nope",
    });
    const ghostAssetRes = makeRes();
    await drive(api(), ghostAsset, ghostAssetRes);
    expect(ghostAssetRes.statusCode).toBe(404);
  });
});
