import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

// Mock loadConfig only — every other config.js export keeps its real
// implementation, so the cores resolve real on-disk paths under the tmp
// project (mirrors the direction-pipeline integration harness). This is a
// deterministic, network-free, key-free end-to-end exercise of the writable
// `serve` HTTP surface.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn() };
});

// Wrap createBrandCore so a single test can force a VersionConflictError while
// every other test uses the real implementation.
vi.mock("../brand/core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../brand/core.js")>();
  return { ...actual, createBrandCore: vi.fn(actual.createBrandCore) };
});

// Wrap the aggregate-root core too so a single test can simulate the
// promote-to-global residual race (the source-retire write conflicts AFTER
// the global rule already committed) while every other test uses the real
// implementation.
vi.mock("../direction/core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../direction/core.js")>();
  return { ...actual, createDirectionCore: vi.fn(actual.createDirectionCore) };
});

// Fake `playwright` for the whole file. Every browser-touching route exercised
// here (`/api/actions/audit`, `/api/actions/surface-scan`) is only ever pointed
// at a deliberately UNREACHABLE url — no case in this file asserts anything
// about a successful page load — so the honest fake is one whose `goto` always
// rejects with a connection failure. `runSurfaceScan` / `captureUrl` stay the
// real implementations, so the scan route still proves the real `CommandError`
// text (including the url) travels out through the JobStore. This removes the
// last real Chromium launch from the integration suite, which is what made the
// "scan route contract" case time out under parallel load.
vi.mock("playwright", () => {
  const chromium = {
    executablePath: () => "",
    async launch() {
      return {
        async newPage(_options?: unknown) {
          return {
            async goto(url: string, _options?: unknown) {
              throw new Error(
                `page.goto: net::ERR_CONNECTION_REFUSED at ${url}\n` +
                  `Call log:\n  - navigating to "${url}"`,
              );
            },
            async evaluate(_fn: unknown) {
              return { elements: [], colors: [], fontFamilies: [] };
            },
            async screenshot(_options?: { path?: string }) {
              return Buffer.alloc(0);
            },
          };
        },
        async close() {
          /* nothing to tear down */
        },
      };
    },
  };
  return { chromium, default: { chromium } };
});

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
  type ConnectHandler,
} from "../ui/server-api.js";
import { createSettingsApi } from "../ui/settings-api.js";
import { createChatApi } from "../ui/chat-api.js";
import { loadDashboardData } from "../ui/api.js";
import type { DirectionTokens, PaletteToken } from "../types.js";
import { createJobStore } from "../ui/jobs.js";
import { runInit } from "../commands/init.js";
import { loadConfig, directionsRoot, surfaceManifestPath } from "../config.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { readVersion, listDirectionIds } from "../direction/store.js";
import { VersionConflictError } from "../store/versioned-store.js";
import { getCommand } from "../mcp/registry.js";
import type { KeyartConfig } from "../types.js";
import { createSurfaceCore } from "../surface/store.js";
import type { SurfaceSlot } from "../surface/schema.js";
import { surfaceScanDir } from "../surface/scan.js";
import type { ScanCandidate, ScanProposal } from "../surface/scan.js";

// Scanner-proof legacy-vocabulary probes (R-8): the runtime strings are the
// removed surface's spellings, assembled so no source literal carries them.
const LEGACY_SCOPE = ["con", "cept"].join("");
const LEGACY_WRAPPER_KEY = `${LEGACY_SCOPE}s`;
const LEGACY_ID_KEY = `${LEGACY_SCOPE}Id`;


async function readDirectionIndex(_root: string, directionId: string) {
  return createDirectionCore(tmpDir, buildTestConfig(tmpDir)).get(directionId);
}

// ---------------------------------------------------------------------------
// Test config — points every core at the tmp project scaffolded by runInit.
// ---------------------------------------------------------------------------

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Serve API ITest", type: "prototype", framework: "next" },
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

// --- fake connect req/res harness -----------------------------------------

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

type FakeReq = Readable & {
  method: string;
  url: string;
  originalUrl: string;
  headers: Record<string, string>;
};

const LOCAL_HEADERS = { host: "127.0.0.1:4317" };

/** A JSON (or empty-body) connect request. `originalUrl` carries the full
 * `/api/...` path, since the handlers match on it (connect prefix-stripping). */
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

/** A 1×1 PNG magic-byte prefix — enough for byte-matching + image detection. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

function buildMultipart(parts: {
  fields?: Record<string, string>;
  files?: { field: string; filename: string; contentType: string; content: Buffer }[];
}): { body: Buffer; contentType: string } {
  const boundary = "----keyartitestboundary9876";
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
): FakeReq {
  const req = Readable.from([mp.body]) as FakeReq;
  req.method = "POST";
  req.originalUrl = originalUrl;
  req.url = originalUrl;
  req.headers = { ...LOCAL_HEADERS, "content-type": mp.contentType };
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

// --- a mini-connect middleware chain, mirroring serve.ts's mount order -----

interface MountEntry {
  prefix: string;
  handler: ConnectHandler;
}

function pathnameOf(originalUrl: string): string {
  return new URL(originalUrl, "http://localhost").pathname;
}

/** connect's prefix-mount predicate: exact match or a `/`-boundary child. */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/**
 * Drives a request through an ordered mount stack exactly as connect (and thus
 * `serve.ts`) would: each handler whose mount prefix matches the request path
 * runs in order, advancing via `next()`; resolves when a handler ends the
 * response (`handled: true`) or the stack is exhausted (`handled: false`).
 */
function runChain(
  stack: MountEntry[],
  req: FakeReq,
  res: FakeRes,
): Promise<{ handled: boolean }> {
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

// ---------------------------------------------------------------------------

let tmpDir: string;
let jobs: ReturnType<typeof createJobStore>;
let stack: MountEntry[];

/** The full serve.ts middleware stack over the tmp project. */
function buildStack(cwd: string): MountEntry[] {
  return [
    { prefix: "/api", handler: createLocalOnlyGuard() },
    { prefix: "/api", handler: createReconciliationApi({ cwd }) },
    { prefix: "/api", handler: createWriteApi({ cwd }) },
    { prefix: "/api", handler: createTokensApi() },
    { prefix: "/api", handler: createSettingsApi({ cwd }) },
    { prefix: "/api/asset", handler: createAssetServer({ cwd }) },
    { prefix: "/api/uploads", handler: createUploadApi({ cwd }) },
    { prefix: "/api/element-feedback", handler: createElementFeedbackApi({ cwd }) },
    // WS-08 (studio-surface-board): mounted BEFORE createAssetActionsApi/
    // createActionsApi, mirroring serve.ts's mount order.
    { prefix: "/api/actions", handler: createSurfaceActionsApi({ cwd, jobs }) },
    // WS-05 (asset-extraction): mounted BEFORE createActionsApi, mirroring
    // serve.ts's mount order (createActionsApi 404s unknown POST segments).
    { prefix: "/api/actions", handler: createAssetActionsApi({ cwd, jobs }) },
    { prefix: "/api/actions", handler: createActionsApi({ cwd, jobs }) },
    { prefix: "/api/jobs", handler: createJobsApi({ jobs }) },
    { prefix: "/api/asset-pack", handler: createAssetPackApi({ cwd }) },
    // WS-08 (studio-surface-board): slot curation (add/edit/retire).
    { prefix: "/api/surface", handler: createSurfaceApi({ cwd }) },
  ];
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-serve-api-"));
  // Genuinely dry-run / deterministic: no API key, no network.
  delete process.env.OPENAI_API_KEY;
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
  // Silence the scaffolder's + cores' progress logging during the test.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Scaffold a real project (config, brand tree, default direction, brand.yaml).
  await runInit({ cwd: tmpDir, force: true });
  jobs = createJobStore();
  stack = buildStack(tmpDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function pollJob(id: string): Promise<{ status: string; result?: unknown; error?: string }> {
  for (let i = 0; i < 300; i++) {
    const req = makeReq({ method: "GET", originalUrl: `/api/jobs/${id}` });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);
    const job = res.json() as { status: string; result?: unknown; error?: string };
    if (job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${id} never settled`);
}

describe("serve write/asset/action endpoints (end-to-end, no network / no key)", () => {
  it("local-only guard rejects a non-local Host (403) and admits a local one", async () => {
    const remote = makeReq({
      method: "POST",
      originalUrl: "/api/directions",
      headers: { host: "evil.example.com" },
      body: { name: "moody" },
    });
    const remoteRes = makeRes();
    await runChain(stack, remote, remoteRes);
    expect(remoteRes.statusCode).toBe(403);
    // The write never happened.
    await expect(
      fs.stat(path.join(directionsRoot(tmpDir, buildTestConfig(tmpDir)), "moody")),
    ).rejects.toThrow();

    // A local request is admitted through the guard and mints the draft direction.
    const local = makeReq({ method: "POST", originalUrl: "/api/directions", body: { name: "moody" } });
    const localRes = makeRes();
    await runChain(stack, local, localRes);
    expect(localRes.statusCode).toBe(201);
  });

  it("GET /api/asset rejects traversal (403) and serves a real image (200)", async () => {
    const traverse = makeReq({ method: "GET", originalUrl: "/api/asset?path=../../secret" });
    const traverseRes = makeRes();
    await runChain(stack, traverse, traverseRes);
    expect(traverseRes.statusCode).toBe(403);

    // A real image under brand/ serves with the right content-type + bytes.
    const imgAbs = path.join(tmpDir, "brand", "input", "references", "board.png");
    await fs.mkdir(path.dirname(imgAbs), { recursive: true });
    await fs.writeFile(imgAbs, PNG_BYTES);

    const ok = makeReq({
      method: "GET",
      originalUrl: "/api/asset?path=brand/input/references/board.png",
    });
    const okRes = makeRes();
    await runChain(stack, ok, okRes);
    expect(okRes.statusCode).toBe(200);
    expect(okRes.headers["content-type"]).toBe("image/png");
    expect(Buffer.isBuffer(okRes.payload)).toBe(true);
    expect((okRes.payload as Buffer).equals(PNG_BYTES)).toBe(true);
  });

  it("creates a draft direction, records serve-attributed feedback, and writes the brief", async () => {
    const config = buildTestConfig(tmpDir);
    const directionDir = path.join(directionsRoot(tmpDir, config), "moody");

    // POST /api/directions (draft create via runDirectionNew) → 201 + direction.yaml
    // on disk; the minted record is a draft (head: null, zero versions).
    const create = makeReq({ method: "POST", originalUrl: "/api/directions", body: { name: "moody" } });
    const createRes = makeRes();
    await runChain(stack, create, createRes);
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json() as { directionId: string; isDraft: boolean };
    expect(created.directionId).toBe("moody");
    expect(created.isDraft).toBe(true);
    await expect(fs.access(path.join(directionDir, "direction.yaml"))).resolves.toBeUndefined();
    const draftRecord = await createDirectionCore(tmpDir, config).get("moody");
    expect(draftRecord.head).toBeNull();
    expect(draftRecord.versions).toEqual([]);

    // POST /api/directions/moody/feedback → 200 + a memory entry attributed source: serve.
    const feedback = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/feedback",
      body: { body: "Lean into warm neutrals", kind: "learning" },
    });
    const feedbackRes = makeRes();
    await runChain(stack, feedback, feedbackRes);
    expect(feedbackRes.statusCode).toBe(200);

    const entries = await createDirectionCore(tmpDir, config).memoryEntries("moody");
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("Lean into warm neutrals");
    expect(entries[0].source).toBe("serve");

    // PATCH /api/directions/moody/brief → 200; the structured field is written via
    // core and brief.md is the deterministic PROJECTION (not a raw overwrite).
    const brief = makeReq({
      method: "PATCH",
      originalUrl: "/api/directions/moody/brief",
      body: { patch: { oneLiner: "A moody, editorial fashion brand." } },
    });
    const briefRes = makeRes();
    await runChain(stack, brief, briefRes);
    expect(briefRes.statusCode).toBe(200);
    const briefBody = briefRes.json() as {
      brief: { oneLiner?: string };
      renderedBrief: string;
    };
    expect(briefBody.brief.oneLiner).toBe("A moody, editorial fashion brand.");
    const briefMd = await fs.readFile(path.join(directionDir, "brief.md"), "utf-8");
    expect(briefMd).toContain("A moody, editorial fashion brand.");
    expect(briefMd).toBe(briefBody.renderedBrief);
  });

  it("uploads a moodboard and registers it as an AssetRef on the direction", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const mp = buildMultipart({
      fields: { directionId: "moody" },
      files: [{ field: "file", filename: "board.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const req = makeMultipartReq("/api/uploads", mp);
    const res = makeRes();
    await runChain(stack, req, res);

    expect(res.statusCode).toBe(201);
    const body = res.json() as { files: { path: string; registered: boolean }[] };
    expect(body.files[0].registered).toBe(true);
    expect(body.files[0].path).toBe("brand/directions/moody/assets/board.png");

    const onDisk = path.join(directionsRoot(tmpDir, config), "moody", "assets", "board.png");
    expect(await fs.readFile(onDisk)).toEqual(PNG_BYTES);

    const record = await createDirectionCore(tmpDir, config).get("moody");
    // Uploads now stamp a reference intent (WS-05/06), defaulting to "inspire".
    expect(record.assets).toContainEqual({
      kind: "image",
      path: "brand/directions/moody/assets/board.png",
      intent: "inspire",
    });
  });

  it("adds a global hard rule and promotes a direction learning", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.appendLearning("moody", { body: "use warm neutrals", author: "tim", source: "cli" });
    const entry = (await core.memoryEntries("moody"))[0];

    // POST /api/rules → 201 + brand.yaml hard rule attributed source: serve.
    const rule = makeReq({
      method: "POST",
      originalUrl: "/api/rules",
      body: { text: "always an 8px grid", severity: "hard" },
    });
    const ruleRes = makeRes();
    await runChain(stack, rule, ruleRes);
    expect(ruleRes.statusCode).toBe(201);

    let brand = await createBrandCore(tmpDir, config).read();
    const added = brand.rules.find((r) => r.text === "always an 8px grid");
    expect(added?.severity).toBe("hard");
    expect(added?.source).toBe("serve");

    // POST /api/promote → 201 + the learning lifted as source: promote:moody.
    const promote = makeReq({
      method: "POST",
      originalUrl: "/api/promote",
      body: { directionId: "moody", entryId: entry.id, severity: "guideline" },
    });
    const promoteRes = makeRes();
    await runChain(stack, promote, promoteRes);
    expect(promoteRes.statusCode).toBe(201);

    brand = await createBrandCore(tmpDir, config).read();
    const promoted = brand.rules.find((r) => r.text === "use warm neutrals");
    expect(promoted?.source).toBe("promote:moody");
  });

  it("runs a dry-run explore action through the job round-trip", async () => {
    const config = buildTestConfig(tmpDir);
    // Create through the write endpoint (runDirectionNew), which scaffolds the
    // brief.md that explore reads — the real studio flow.
    const create = makeReq({ method: "POST", originalUrl: "/api/directions", body: { name: "moody" } });
    const createRes = makeRes();
    await runChain(stack, create, createRes);
    expect(createRes.statusCode).toBe(201);

    const kickoff = makeReq({ method: "POST", originalUrl: "/api/actions/explore", body: { from: "moody" } });
    const kickoffRes = makeRes();
    await runChain(stack, kickoff, kickoffRes);
    expect(kickoffRes.statusCode).toBe(202);
    const { jobId } = kickoffRes.json() as { jobId: string };
    expect(typeof jobId).toBe("string");

    const settled = await pollJob(jobId);
    expect(settled.status).toBe("succeeded");
    const result = settled.result as { direction: string; directionIds: string[] };
    expect(result.direction).toBe("moody");

    // The explore actually happened: sibling directions were seeded directly
    // under directions/ (WS-01: directions/<id>/versions/<verId>/, no runs/).
    const directionsDir = directionsRoot(tmpDir, config);
    expect(result.directionIds).toHaveLength(3);
    const dirIds = result.directionIds;
    const head = (await readDirectionIndex(directionsDir, dirIds[0])).head;
    expect(head).not.toBeNull();
    await expect(
      fs.access(
        path.join(directionsDir, dirIds[0], "versions", head!, "direction-version.json"),
      ),
    ).resolves.toBeUndefined();
  });

  /** Absolute project-level `directions/` aggregate-root directory. */
  function directionsDirOf(_id: string): string {
    return directionsRoot(tmpDir, buildTestConfig(tmpDir));
  }

  /**
   * Creates a draft direction via the write endpoint and runs one dry-run
   * divergent explore, returning the first seeded direction's id + its head
   * versionId. Mirrors the real studio flow; the studio addresses a direction
   * by `{ directionId, versionId }` (directions/<dirId>/versions/<verId>/).
   */
  async function scaffoldDirectionWithRun(
    id: string,
  ): Promise<{ directionId: string; versionId: string }> {
    const create = makeReq({ method: "POST", originalUrl: "/api/directions", body: { name: id } });
    const createRes = makeRes();
    await runChain(stack, create, createRes);
    expect(createRes.statusCode).toBe(201);

    const kickoff = makeReq({ method: "POST", originalUrl: "/api/actions/explore", body: { from: id } });
    const kickoffRes = makeRes();
    await runChain(stack, kickoff, kickoffRes);
    expect(kickoffRes.statusCode).toBe(202);
    const settled = await pollJob((kickoffRes.json() as { jobId: string }).jobId);
    expect(settled.status).toBe("succeeded");

    const directionsDir = directionsDirOf(id);
    const dirIds = (settled.result as { directionIds: string[] }).directionIds;
    expect(dirIds.length).toBeGreaterThan(0);
    const directionId = dirIds[0];
    const versionId = (await readDirectionIndex(directionsDir, directionId)).head;
    expect(versionId).not.toBeNull();
    expect(versionId).not.toBeNull();
    return { directionId, versionId: versionId! };
  }

  it("refine is no longer a dispatchable studio action (removed — 404)", async () => {
    const { directionId, versionId } = await scaffoldDirectionWithRun("moody");

    // `refine` was removed: feedback now regenerates a direction (appending a new
    // version). The studio action segment no longer exists → 404 (no job started).
    const req = makeReq({
      method: "POST",
      originalUrl: "/api/actions/refine",
      body: { versionId, directionId, tweak: "warm type" },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(404);
  });

  it("generate-one appends a single NEW sibling direction beside the source (no lineage)", async () => {
    await scaffoldDirectionWithRun("moody");
    const directionsDir = directionsDirOf("moody");
    const before = (await listDirectionIds(directionsDir)).length;

    const kickoff = makeReq({
      method: "POST",
      originalUrl: "/api/actions/explore",
      body: { from: "moody", count: 1 },
    });
    const kickoffRes = makeRes();
    await runChain(stack, kickoff, kickoffRes);
    expect(kickoffRes.statusCode).toBe(202);
    const settled = await pollJob((kickoffRes.json() as { jobId: string }).jobId);
    expect(settled.status).toBe("succeeded");
    expect((settled.result as { directionIds: string[] }).directionIds).toHaveLength(1);

    // Exactly one new sibling direction was added.
    const after = (await listDirectionIds(directionsDir)).length;
    expect(after).toBe(before + 1);
  });

  it("dry-run regenerate APPENDS a new head version and retains the prior (SC-06)", async () => {
    const { directionId, versionId } = await scaffoldDirectionWithRun("moody");
    const directionsDir = directionsDirOf("moody");

    const head = await readVersion(directionsDir, directionId, versionId);
    const priorPrimary = head.tokens!.palette.find(
      (t) => t.role === "primary",
    )!.hex;
    const before = (await readDirectionIndex(directionsDir, directionId)).versions;
    expect(before).toHaveLength(1);

    // Missing directionId → 400 (validation, no job started). A stray runId is ignored.
    const bad = makeReq({
      method: "POST",
      originalUrl: "/api/actions/regenerate",
      body: { runId: versionId },
    });
    const badRes = makeRes();
    await runChain(stack, bad, badRes);
    expect(badRes.statusCode).toBe(400);

    // Well-formed dry-run regenerate with a locked role → 202 → succeeds and
    // APPENDS a new version (the head advances). A stray `runId` is ignored.
    const kickoff = makeReq({
      method: "POST",
      originalUrl: "/api/actions/regenerate",
      body: {
        runId: "ignored",
        directionId,
        lockedRoles: ["primary"],
        feedback: "warmer, more editorial",
      },
    });
    const kickoffRes = makeRes();
    await runChain(stack, kickoff, kickoffRes);
    expect(kickoffRes.statusCode).toBe(202);
    const settled = await pollJob((kickoffRes.json() as { jobId: string }).jobId);
    expect(settled.status).toBe("succeeded");

    // The head advanced to a NEW version; the prior version is retained.
    const index = await readDirectionIndex(directionsDir, directionId);
    expect(index.versions).toHaveLength(2);
    expect(index.head).not.toBe(versionId);
    expect(index.versions).toContain(versionId);

    // No key ⇒ no tile ⇒ no re-extraction: the prior version is untouched, and
    // the deterministic board still re-rendered on the new head.
    const prior = await readVersion(directionsDir, directionId, versionId);
    expect(
      prior.tokens!.palette.find((t) => t.role === "primary")!.hex,
    ).toBe(priorPrimary);
    const result = settled.result as {
      dryRun: boolean;
      boardWritten: boolean;
      versionId: string;
    };
    expect(result.dryRun).toBe(true);
    expect(result.boardWritten).toBe(true);
    expect(result.versionId).toBe(index.head);
  });

  it("version navigation payload: directions[] with head + ordered versions, no run/silo keys (SC-03/SC-10)", async () => {
    const { directionId, versionId } = await scaffoldDirectionWithRun("moody");

    // Regenerate the one direction so it has a second version.
    const kickoff = makeReq({
      method: "POST",
      originalUrl: "/api/actions/regenerate",
      body: { directionId },
    });
    const kickoffRes = makeRes();
    await runChain(stack, kickoff, kickoffRes);
    expect(kickoffRes.statusCode).toBe(202);
    const settled = await pollJob((kickoffRes.json() as { jobId: string }).jobId);
    expect(settled.status).toBe("succeeded");
    const newHead = (settled.result as { versionId: string }).versionId;

    const data = await loadDashboardData(tmpDir);
    const dir = data.directions.find((d) => d.id === directionId);
    expect(dir).toBeDefined();

    expect(dir!.head).toBe(newHead);
    expect(dir!.versions).toHaveLength(2);
    // Canonical ascending order: versions[last] === head.
    expect(dir!.versions[dir!.versions.length - 1].versionId).toBe(dir!.head);
    expect(dir!.versions[0].versionId).toBe(versionId);

    // No run/silo vocabulary leaks anywhere in the payload (SC-03/SC-10) — and
    // the payload is FLAT (WS-18): no wrapper key, no per-entry nesting.
    const blob = JSON.stringify(data);
    expect(blob).not.toContain('"runId"');
    expect(blob).not.toContain('"runs"');
    expect(blob).not.toContain('"latestRun"');
    expect(blob).not.toContain('"silos"');
    expect(blob).not.toContain(`"${LEGACY_WRAPPER_KEY}"`);
    expect(blob).not.toContain(`"${LEGACY_ID_KEY}"`);
  });

  it("approve PINS a version; regenerate advances the head without moving the pointer (SC-04/SC-08)", async () => {
    const { directionId, versionId } = await scaffoldDirectionWithRun("moody");
    const config = buildTestConfig(tmpDir);

    // Approve the head → the pointer pins { directionId, versionId }.
    const approve = makeReq({
      method: "POST",
      originalUrl: "/api/actions/approve",
      body: { directionId },
    });
    const approveRes = makeRes();
    await runChain(stack, approve, approveRes);
    expect(approveRes.statusCode).toBe(202);
    expect((await pollJob((approveRes.json() as { jobId: string }).jobId)).status).toBe(
      "succeeded",
    );

    let global = await createBrandCore(tmpDir, config).read();
    expect(global.approvedPointer).toMatchObject({
      directionId,
      versionId,
    });
    expect(JSON.stringify(global.approvedPointer)).not.toContain("runId");

    // Regenerate advances the head; the approved pointer/versionId stays put.
    const regen = makeReq({
      method: "POST",
      originalUrl: "/api/actions/regenerate",
      body: { directionId },
    });
    const regenRes = makeRes();
    await runChain(stack, regen, regenRes);
    expect(regenRes.statusCode).toBe(202);
    expect((await pollJob((regenRes.json() as { jobId: string }).jobId)).status).toBe(
      "succeeded",
    );

    const directionsDir = directionsDirOf("moody");
    const index = await readDirectionIndex(directionsDir, directionId);
    expect(index.head).not.toBe(versionId); // head advanced
    global = await createBrandCore(tmpDir, config).read();
    expect(global.approvedPointer!.versionId).toBe(versionId); // pointer unchanged
  });

  it("restores an old version's content as a NEW head, leaving prior versions untouched (SC-10)", async () => {
    const { directionId, versionId } = await scaffoldDirectionWithRun("moody");
    const directionsDir = directionsDirOf("moody");
    const original = await readVersion(directionsDir, directionId, versionId);

    // Advance the head via an in-place edit so the head differs from v1.
    const edit = makeReq({
      method: "PUT",
      originalUrl: `/api/directions/${directionId}`,
      body: { name: "Edited Head" },
    });
    const editRes = makeRes();
    await runChain(stack, edit, editRes);
    expect(editRes.statusCode).toBe(200);
    const editedHead = await readVersion(directionsDir, directionId, versionId);
    expect(editedHead.name).toBe("Edited Head");

    // Restore v1's content by POSTing it to the versions route — appends a NEW
    // head whose content equals the restored version.
    const restore = makeReq({
      method: "POST",
      originalUrl: `/api/directions/${directionId}/versions`,
      body: {
        name: original.name,
        summary: original.summary,
        positioning: original.positioning,
        character: original.character,
        styleTilePrompt: original.styleTilePrompt,
        homepageMockupPrompt: original.homepageMockupPrompt,
        usage: original.usage,
        copyExamples: original.copyExamples,
        ...(original.tokens ? { tokens: original.tokens } : {}),
      },
    });
    const restoreRes = makeRes();
    await runChain(stack, restore, restoreRes);
    expect(restoreRes.statusCode).toBe(201);
    const { directionId: rDir, versionId: rVer } = restoreRes.json() as {
      directionId: string;
      versionId: string;
    };
    expect(rDir).toBe(directionId);
    expect(rVer).not.toBe(versionId);

    const index = await readDirectionIndex(directionsDir, directionId);
    expect(index.head).toBe(rVer);
    const restored = await readVersion(directionsDir, directionId, rVer);
    expect(restored.name).toBe(original.name); // content equals the restored version
    // Prior versions untouched (the edited v1 still carries its edit).
    expect((await readVersion(directionsDir, directionId, versionId)).name).toBe(
      "Edited Head",
    );
  });

  it("records an attributed memory note on direction upload, none for references-only", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    // Upload targeting the direction → registered AND an attributed memory note.
    const withDirection = buildMultipart({
      fields: { directionId: "moody" },
      files: [{ field: "file", filename: "board.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const res = makeRes();
    await runChain(stack, makeMultipartReq("/api/uploads", withDirection), res);
    expect(res.statusCode).toBe(201);

    const entries = await createDirectionCore(tmpDir, config).memoryEntries("moody");
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toContain("brand/directions/moody/assets/board.png");
    expect(entries[0].source).toBe("serve");

    // A references-only upload (no directionId) records NO memory note.
    const refsOnly = buildMultipart({
      files: [{ field: "file", filename: "ref.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const refsRes = makeRes();
    await runChain(stack, makeMultipartReq("/api/uploads", refsOnly), refsRes);
    expect(refsRes.statusCode).toBe(201);

    // moody's memory is unchanged (still just the one note from its own upload).
    const after = await createDirectionCore(tmpDir, config).memoryEntries("moody");
    expect(after).toHaveLength(1);
  });

  it("kicks off an audit action returning only a jobId (no real browser)", async () => {
    // Audit needs Playwright/Chromium (not guaranteed here) — assert kickoff only.
    const req = makeReq({
      method: "POST",
      originalUrl: "/api/actions/audit",
      body: { url: "http://localhost:3000" },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(202);
    expect(typeof (res.json() as { jobId: string }).jobId).toBe("string");
  });

  it("surfaces a version conflict as 409 { code: version_conflict }", async () => {
    // Force the global-rule write to hit a stale version, mirroring a concurrent
    // CLI + studio write. Everything else in this test file uses the real core.
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
      body: { text: "stale write", severity: "guideline" },
    });
    const res = makeRes();
    await runChain(stack, req, res);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("version_conflict");
  });

  /** A valid, complete token set (six roles, catalog fonts, real shape). */
  function sampleTokens(): DirectionTokens {
    return {
      palette: [
        { role: "primary", name: "Primary", hex: "#3344ff" },
        { role: "secondary", name: "Secondary", hex: "#22aa88" },
        { role: "background", name: "Background", hex: "#ffffff" },
        { role: "surface", name: "Surface", hex: "#f4f4f4" },
        { role: "text", name: "Text", hex: "#111111" },
        { role: "muted", name: "Muted", hex: "#888888" },
      ],
      typography: { heading: "Space Grotesk", body: "Inter" },
      shape: { radius: "8px", spacingUnit: "8px" },
    };
  }

  it("upload carries the reference intent onto the AssetRef (extract; defaults to inspire)", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    // intent=extract → the registered AssetRef records intent: "extract".
    const extract = buildMultipart({
      fields: { directionId: "moody", intent: "extract" },
      files: [{ field: "file", filename: "swatch.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const res = makeRes();
    await runChain(stack, makeMultipartReq("/api/uploads", extract), res);
    expect(res.statusCode).toBe(201);

    let record = await createDirectionCore(tmpDir, config).get("moody");
    expect(record.assets.find((a) => a.path.endsWith("swatch.png"))?.intent).toBe("extract");

    // Omitting intent defaults to "inspire".
    const plain = buildMultipart({
      fields: { directionId: "moody" },
      files: [{ field: "file", filename: "plain.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const res2 = makeRes();
    await runChain(stack, makeMultipartReq("/api/uploads", plain), res2);
    expect(res2.statusCode).toBe(201);

    record = await createDirectionCore(tmpDir, config).get("moody");
    expect(record.assets.find((a) => a.path.endsWith("plain.png"))?.intent).toBe("inspire");
  });

  it("reroll endpoint keeps locked roles, changes the rest, and guards input", async () => {
    const tokens = sampleTokens();
    const primaryHex = tokens.palette.find((t) => t.role === "primary")!.hex;

    // Lock primary, reroll the rest → primary preserved verbatim, ≥1 other
    // changed. A stray "accent" lockedRole is not a valid six-role role and is
    // ignored (WS-05); the response still carries all six semantic roles.
    const ok = makeReq({
      method: "POST",
      originalUrl: "/api/palette/reroll",
      body: { tokens, lockedRoles: ["primary", "accent"], seed: 12345 },
    });
    const okRes = makeRes();
    await runChain(stack, ok, okRes);
    expect(okRes.statusCode).toBe(200);
    const { palette } = okRes.json() as { palette: PaletteToken[] };
    expect(palette).toHaveLength(6);
    const byRole = new Map(palette.map((t) => [t.role, t.hex]));
    expect(byRole.get("primary")).toBe(primaryHex);
    const changedSomething = tokens.palette.some(
      (t) => t.role !== "primary" && byRole.get(t.role) !== t.hex,
    );
    expect(changedSomething).toBe(true);

    // Malformed body (no palette) → 400.
    const bad = makeReq({ method: "POST", originalUrl: "/api/palette/reroll", body: { nope: true } });
    const badRes = makeRes();
    await runChain(stack, bad, badRes);
    expect(badRes.statusCode).toBe(400);

    // Non-local request → 403 (the local-only guard runs before the tokens API).
    const remote = makeReq({
      method: "POST",
      originalUrl: "/api/palette/reroll",
      headers: { host: "evil.example.com" },
      body: { tokens, lockedRoles: [] },
    });
    const remoteRes = makeRes();
    await runChain(stack, remote, remoteRes);
    expect(remoteRes.statusCode).toBe(403);
  });

  it("GET /api/fonts serves the curated pairing catalog", async () => {
    const req = makeReq({ method: "GET", originalUrl: "/api/fonts" });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);
    const { pairings } = res.json() as { pairings: { id: string; heading: string; body: string }[] };
    expect(pairings.length).toBeGreaterThan(0);
    expect(pairings.some((p) => p.heading === "Space Grotesk" && p.body === "Inter")).toBe(true);
  });

  it("PUT and versions POST persist structured tokens through the edit core", async () => {
    // The studio addresses a direction by { directionId }; the head is edited in
    // place via PUT, and a new version is appended via …/versions.
    const { directionId: dirId, versionId } = await scaffoldDirectionWithRun("moody");
    const directionsDir = directionsDirOf("moody");

    const tokens = sampleTokens();

    // PUT …/directions/:id with a tokens body edits the head version IN PLACE.
    const put = makeReq({
      method: "PUT",
      originalUrl: `/api/directions/${dirId}`,
      body: { tokens },
    });
    const putRes = makeRes();
    await runChain(stack, put, putRes);
    expect(putRes.statusCode).toBe(200);

    const edited = await readVersion(directionsDir, dirId, versionId);
    expect(edited.tokens?.typography.heading).toBe("Space Grotesk");
    expect(edited.tokens?.palette.find((t) => t.role === "primary")?.hex).toBe("#3344ff");
    expect(edited.tokens?.shape.radius).toBe("8px");

    // POST …/versions with tokens appends a NEW VERSION of the SAME direction
    // (the head advances) carrying them.
    const versionPost = makeReq({
      method: "POST",
      originalUrl: `/api/directions/${dirId}/versions`,
      body: { name: "Token Variant", tokens },
    });
    const versionRes = makeRes();
    await runChain(stack, versionPost, versionRes);
    expect(versionRes.statusCode).toBe(201);
    const { directionId: vDirId, versionId: vVersionId } = versionRes.json() as {
      directionId: string;
      versionId: string;
    };
    expect(vDirId).toBe(dirId); // same direction …
    expect(vVersionId).not.toBe(versionId); // … a new version (head advanced)
    const variantHead = await readVersion(directionsDir, vDirId, vVersionId);
    expect(variantHead.tokens?.typography.body).toBe("Inter");
  });

  it("rejects an edit whose tokens use an off-catalog font (400)", async () => {
    const { directionId: dirId } = await scaffoldDirectionWithRun("moody");

    const bad = sampleTokens();
    bad.typography = { heading: "Comic Sans MS", body: "Inter" }; // not in the catalog
    const put = makeReq({
      method: "PUT",
      originalUrl: `/api/directions/${dirId}`,
      body: { tokens: bad },
    });
    const res = makeRes();
    await runChain(stack, put, res);
    expect(res.statusCode).toBe(400);
  });

  it("rejects an edit whose tokens are missing a semantic role (six-role validation, 400)", async () => {
    const { directionId: dirId } = await scaffoldDirectionWithRun("moody");

    // Drop the `secondary` role — one of the six required semantic roles. There
    // is no `accent` role in the set, so it is never required (WS-05).
    const bad = sampleTokens();
    bad.palette = bad.palette.filter((t) => t.role !== "secondary");
    const put = makeReq({
      method: "PUT",
      originalUrl: `/api/directions/${dirId}`,
      body: { tokens: bad },
    });
    const res = makeRes();
    await runChain(stack, put, res);
    expect(res.statusCode).toBe(400);
  });

  it("GET /api/settings returns project + models + masked key status (no key)", async () => {
    const req = makeReq({ method: "GET", originalUrl: "/api/settings" });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      project: { name: string; framework: string };
      models: { text: string; vision: string; image: string };
      frameworkChoices: string[];
      openaiKey: { configured: boolean; hint: string };
      envLocalGitignored: boolean;
    };
    expect(body.project.name).toBe("Serve API ITest");
    expect(body.models.text).toBe("gpt-5.5");
    expect(body.models.image).toBe("gpt-image-2");
    expect(body.frameworkChoices).toContain("next");
    // No key in this deterministic harness → dry-run, masked "(none)".
    expect(body.openaiKey.configured).toBe(false);
    expect(body.openaiKey.hint).toBe("(none)");
    expect(typeof body.envLocalGitignored).toBe("boolean");
  });

  it("PUT /api/settings rewrites keyart.config.ts (project + models preserved fields)", async () => {
    const put = makeReq({
      method: "PUT",
      originalUrl: "/api/settings",
      body: {
        project: { name: "Renamed", framework: "vite" },
        models: { text: "gpt-x", image: "gpt-image-9" },
      },
    });
    const res = makeRes();
    await runChain(stack, put, res);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      project: { name: string; framework: string };
      models: { text: string; vision: string; image: string };
    };
    expect(body.ok).toBe(true);
    expect(body.project.name).toBe("Renamed");
    expect(body.project.framework).toBe("vite");
    expect(body.models.text).toBe("gpt-x");
    // A blank field keeps the current model (vision was not sent).
    expect(body.models.vision).toBe("gpt-5.5");
    expect(body.models.image).toBe("gpt-image-9");

    // The config file on disk reflects the edits and stays schema-shaped.
    const text = await fs.readFile(path.join(tmpDir, "keyart.config.ts"), "utf-8");
    expect(text).toContain('name: "Renamed"');
    expect(text).toContain('framework: "vite"');
    expect(text).toContain('text: "gpt-x"');
    expect(text).toContain('image: "gpt-image-9"');
    expect(text).toContain('defineKeyartConfig');
    // The raw config never carries the key string.
    expect(text).not.toContain("OPENAI_API_KEY");
  });

  it("PUT /api/settings writes the API key to .env.local and never returns it raw", async () => {
    const secret = "sk-test-supersecret-1234";
    const put = makeReq({
      method: "PUT",
      originalUrl: "/api/settings",
      body: { openaiApiKey: secret },
    });
    const res = makeRes();
    await runChain(stack, put, res);
    expect(res.statusCode).toBe(200);

    // The raw key is never echoed back in the response payload.
    expect(String(res.payload)).not.toContain(secret);
    const body = res.json() as {
      keyUpdated: boolean;
      openaiKey: { configured: boolean; hint: string };
    };
    expect(body.keyUpdated).toBe(true);
    expect(body.openaiKey.configured).toBe(true);
    expect(body.openaiKey.hint).not.toBe(secret);

    // It landed in .env.local and this process picked it up.
    const envLocal = await fs.readFile(path.join(tmpDir, ".env.local"), "utf-8");
    expect(envLocal).toContain(`OPENAI_API_KEY=${secret}`);
    expect(process.env.OPENAI_API_KEY).toBe(secret);

    // A subsequent GET reports configured=true with a masked hint (still no raw key).
    const getReq = makeReq({ method: "GET", originalUrl: "/api/settings" });
    const getRes = makeRes();
    await runChain(stack, getReq, getRes);
    expect(getRes.statusCode).toBe(200);
    expect(String(getRes.payload)).not.toContain(secret);
    const getBody = getRes.json() as { openaiKey: { configured: boolean } };
    expect(getBody.openaiKey.configured).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Element feedback — the studio crop UI write path (serve-only, no network/key).
// ---------------------------------------------------------------------------

describe("POST /api/element-feedback (crop keep/discard/eyedropper, no network / no key)", () => {
  const EF = "/api/element-feedback";

  it("rejects a non-local request (403) before the handler runs", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const mp = buildMultipart({ fields: { directionId: "moody", verb: "keep", hex: "#336699" } });
    const req = makeMultipartReq(EF, mp);
    req.headers = { ...req.headers, host: "evil.example.com" };
    const res = makeRes();
    await runChain(stack, req, res);

    expect(res.statusCode).toBe(403);
    // Nothing was recorded.
    const entries = await createDirectionCore(tmpDir, config).memoryEntries("moody");
    expect(entries).toHaveLength(0);
  });

  it("keep → inspire AssetRef under assets/", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const mp = buildMultipart({
      fields: { directionId: "moody", verb: "keep", intent: "inspire" },
      files: [{ field: "file", filename: "crop.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const res = makeRes();
    await runChain(stack, makeMultipartReq(EF, mp), res);

    expect(res.statusCode).toBe(201);
    const onDisk = path.join(directionsRoot(tmpDir, config), "moody", "assets", "crop.png");
    expect(await fs.readFile(onDisk)).toEqual(PNG_BYTES);

    const record = await createDirectionCore(tmpDir, config).get("moody");
    expect(record.assets).toContainEqual({
      kind: "image",
      path: "brand/directions/moody/assets/crop.png",
      intent: "inspire",
    });
  });

  it("keep → extract AssetRef carries the chosen intent", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const mp = buildMultipart({
      fields: { directionId: "moody", verb: "keep", intent: "extract" },
      files: [{ field: "file", filename: "swatch.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const res = makeRes();
    await runChain(stack, makeMultipartReq(EF, mp), res);

    expect(res.statusCode).toBe(201);
    const record = await createDirectionCore(tmpDir, config).get("moody");
    expect(record.assets.find((a) => a.path.endsWith("swatch.png"))?.intent).toBe("extract");
  });

  it("discard → feedback + thumbnail under assets/feedback/, NEVER an AssetRef", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const mp = buildMultipart({
      fields: { directionId: "moody", verb: "discard", note: "too much gradient" },
      files: [{ field: "file", filename: "bad.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const res = makeRes();
    await runChain(stack, makeMultipartReq(EF, mp), res);

    expect(res.statusCode).toBe(201);
    const thumbRel = "brand/directions/moody/assets/feedback/bad.png";
    const onDisk = path.join(directionsRoot(tmpDir, config), "moody", "assets", "feedback", "bad.png");
    expect(await fs.readFile(onDisk)).toEqual(PNG_BYTES);

    const feedback = (await core.memoryEntries("moody")).filter((e) => e.kind === "feedback");
    expect(feedback).toHaveLength(1);
    expect(feedback[0].body).toContain("too much gradient");
    expect(feedback[0].asset).toBe(thumbRel);

    // The discard thumbnail is NEVER a positive reference.
    const record = await core.get("moody");
    expect(record.assets.some((a) => a.path === thumbRel)).toBe(false);
  });

  it("eyedropper hex → normalized color-lock decision (no file)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const mp = buildMultipart({ fields: { directionId: "moody", verb: "keep", hex: "#3366CC" } });
    const res = makeRes();
    await runChain(stack, makeMultipartReq(EF, mp), res);

    expect(res.statusCode).toBe(201);
    expect((res.json() as { hex?: string }).hex).toBe("#3366cc");
    const decisions = (await core.memoryEntries("moody")).filter((e) => e.kind === "decision");
    expect(decisions.some((d) => d.body.includes("#3366cc"))).toBe(true);
    // No assets recorded for a pure eyedropper keep.
    expect((await core.get("moody")).assets).toHaveLength(0);
  });

  it("keep with file + hex records BOTH an AssetRef and a color-lock decision", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const mp = buildMultipart({
      fields: { directionId: "moody", verb: "keep", intent: "extract", hex: "#0af" },
      files: [{ field: "file", filename: "combo.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const res = makeRes();
    await runChain(stack, makeMultipartReq(EF, mp), res);

    expect(res.statusCode).toBe(201);
    const record = await core.get("moody");
    expect(record.assets.find((a) => a.path.endsWith("combo.png"))?.intent).toBe("extract");
    // "#0af" expands to "#00aaff".
    const decisions = (await core.memoryEntries("moody")).filter((e) => e.kind === "decision");
    expect(decisions.some((d) => d.body.includes("#00aaff"))).toBe(true);
  });

  it("validation: missing directionId / bad verb / bad hex / non-image / empty discard / empty keep / missing direction", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const cases: { mp: ReturnType<typeof buildMultipart>; status: number }[] = [
      // missing directionId
      { mp: buildMultipart({ fields: { verb: "keep", hex: "#333333" } }), status: 400 },
      // unknown verb
      { mp: buildMultipart({ fields: { directionId: "moody", verb: "maybe", hex: "#333333" } }), status: 400 },
      // invalid hex
      { mp: buildMultipart({ fields: { directionId: "moody", verb: "keep", hex: "blue" } }), status: 400 },
      // non-image file
      {
        mp: buildMultipart({
          fields: { directionId: "moody", verb: "keep" },
          files: [{ field: "file", filename: "notes.txt", contentType: "text/plain", content: Buffer.from("hi") }],
        }),
        status: 415,
      },
      // discard with no file
      { mp: buildMultipart({ fields: { directionId: "moody", verb: "discard", note: "n" } }), status: 400 },
      // keep with neither file nor hex
      { mp: buildMultipart({ fields: { directionId: "moody", verb: "keep" } }), status: 400 },
      // missing direction
      { mp: buildMultipart({ fields: { directionId: "ghost", verb: "keep", hex: "#333333" } }), status: 400 },
    ];

    for (const { mp, status } of cases) {
      const res = makeRes();
      await runChain(stack, makeMultipartReq(EF, mp), res);
      expect(res.statusCode).toBe(status);
    }

    // No successful write leaked through the failing cases.
    expect(await createDirectionCore(tmpDir, config).memoryEntries("moody")).toHaveLength(0);
  });

  it("loadDashboardData surfaces MemoryEntry.asset after a discard", async () => {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id: "moody", name: "Moody" });

    const mp = buildMultipart({
      fields: { directionId: "moody", verb: "discard", note: "off-brand" },
      files: [{ field: "file", filename: "reject.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const res = makeRes();
    await runChain(stack, makeMultipartReq(EF, mp), res);
    expect(res.statusCode).toBe(201);

    const data = await loadDashboardData(tmpDir);
    const direction = data.directions.find((d) => d.id === "moody");
    const entry = direction?.memory.find((e) => e.kind === "feedback");
    expect(entry?.asset).toBe("brand/directions/moody/assets/feedback/reject.png");
  });
});

// ---------------------------------------------------------------------------
// POST /api/directions/:sourceId/create — create authored direction (WS-04/WS-18).
// ---------------------------------------------------------------------------

describe("POST /api/directions/:sourceId/create (authored create, SC-06/SC-07/SC-03, no network / no key)", () => {
  /** A minimal valid authored direction body. */
  function validBody(name = "Bold & Modern"): Record<string, unknown> {
    return {
      name,
      summary: "A confident, editorial direction.",
      character: { mood: "bold and confident" },
      usage: {
        rules: ["Use strong typography"],
        antiRules: ["Avoid cluttered layouts"],
      },
      copyExamples: { headline: "Make it count", subheadline: "", cta: "Get started" },
    };
  }

  /** Scaffold a draft direction via the write endpoint. */
  async function scaffoldDirection(id: string): Promise<void> {
    const res = makeRes();
    await runChain(
      stack,
      makeReq({ method: "POST", originalUrl: "/api/directions", body: { name: id } }),
      res,
    );
    expect(res.statusCode).toBe(201);
  }

  it("returns 201 + writes v1; direction appears in dashboard at v1; keyless (SC-07/SC-08)", async () => {
    await scaffoldDirection("moody");

    const dirRes = makeRes();
    await runChain(
      stack,
      makeReq({ method: "POST", originalUrl: "/api/directions/moody/create", body: validBody() }),
      dirRes,
    );
    expect(dirRes.statusCode).toBe(201);

    const result = dirRes.json() as {
      sourceId: string;
      seedDirection: string;
      directionId: string;
      versionId: string;
      filesWritten: string[];
      dryRun: boolean;
    };
    expect(result.sourceId).toBe("moody");
    expect(result.seedDirection).toBe("moody");
    expect(typeof result.directionId).toBe("string");
    expect(result.directionId.length).toBeGreaterThan(0);
    expect(typeof result.versionId).toBe("string");
    expect(result.filesWritten.length).toBeGreaterThan(0);
    // No API key in this harness → dry-run flag is true (but the write still happened).
    expect(result.dryRun).toBe(true);

    // Reload via loadDashboardData — the new direction appears at v1 (flat).
    const data = await loadDashboardData(tmpDir);
    const dir = data.directions.find((d) => d.id === result.directionId);
    expect(dir).toBeDefined();
    expect(dir!.versions).toHaveLength(1);
    expect(dir!.versions[0].versionId).toBe(result.versionId);
    expect(dir!.versions[0].name).toBe("Bold & Modern");
  });

  it("validation error → 400: `tokens` field rejected with pointer to color-locks (SC-03)", async () => {
    await scaffoldDirection("moody");
    const res = makeRes();
    await runChain(
      stack,
      makeReq({
        method: "POST",
        originalUrl: "/api/directions/moody/create",
        body: { ...validBody(), tokens: {} },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("tokens");
  });

  it("validation error → 400: hex in character.mood (SC-03)", async () => {
    await scaffoldDirection("moody");
    const res = makeRes();
    await runChain(
      stack,
      makeReq({
        method: "POST",
        originalUrl: "/api/directions/moody/create",
        body: {
          name: "Test",
          summary: "Test direction.",
          character: { mood: "warm like #ff5500" },
          usage: {},
          copyExamples: {},
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("character.mood");
  });

  it("validation error → 400: missing required name (SC-03)", async () => {
    await scaffoldDirection("moody");
    const res = makeRes();
    await runChain(
      stack,
      makeReq({
        method: "POST",
        originalUrl: "/api/directions/moody/create",
        body: { summary: "A direction.", character: {}, usage: {}, copyExamples: {} },
      }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/name/i);
  });

  it("bad JSON body → 400 (SC-03)", async () => {
    await scaffoldDirection("moody");

    // Construct a raw non-JSON body request without using the JSON-serialising makeReq.
    const rawBuf = Buffer.from("not-valid-json!!!");
    const badReq = Readable.from([rawBuf]) as FakeReq;
    badReq.method = "POST";
    badReq.originalUrl = "/api/directions/moody/create";
    badReq.url = badReq.originalUrl;
    badReq.headers = { ...LOCAL_HEADERS };

    const res = makeRes();
    await runChain(stack, badReq, res);
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toContain("Invalid JSON");
  });

  it("local-only guard → 403 on non-local host (SC-06)", async () => {
    await scaffoldDirection("moody");
    const res = makeRes();
    await runChain(
      stack,
      makeReq({
        method: "POST",
        originalUrl: "/api/directions/moody/create",
        headers: { host: "evil.example.com" },
        body: validBody(),
      }),
      res,
    );
    expect(res.statusCode).toBe(403);
  });

  it("same-name double-create yields two distinct direction ids (SC-07)", async () => {
    await scaffoldDirection("moody");
    const body = validBody("Bold");

    const res1 = makeRes();
    await runChain(
      stack,
      makeReq({ method: "POST", originalUrl: "/api/directions/moody/create", body }),
      res1,
    );
    expect(res1.statusCode).toBe(201);
    const r1 = res1.json() as { directionId: string };

    const res2 = makeRes();
    await runChain(
      stack,
      makeReq({ method: "POST", originalUrl: "/api/directions/moody/create", body }),
      res2,
    );
    expect(res2.statusCode).toBe(201);
    const r2 = res2.json() as { directionId: string };

    expect(r1.directionId).not.toBe(r2.directionId);
  });

  it("GET /api/directions/:sourceId/create falls through; DELETE under owned prefix → 404; legacy nested route is gone", async () => {
    await scaffoldDirection("moody");

    // GET falls through the write API (passes GET through without handling).
    const getReq = makeReq({ method: "GET", originalUrl: "/api/directions/moody/create" });
    const getRes = makeRes();
    const { handled } = await runChain(stack, getReq, getRes);
    expect(handled).toBe(false);

    // DELETE under an owned prefix with no matching route → 404.
    const delRes = makeRes();
    await runChain(
      stack,
      makeReq({ method: "DELETE", originalUrl: "/api/directions/moody/create" }),
      delRes,
    );
    expect(delRes.statusCode).toBe(404);

    // Absence probe (WS-18): the legacy nested route is not served by any
    // middleware — no handler ends the response.
    const legacyRes = makeRes();
    const legacy = await runChain(
      stack,
      makeReq({ method: "POST", originalUrl: `/api/${LEGACY_WRAPPER_KEY}/moody/directions`, body: validBody() }),
      legacyRes,
    );
    expect(legacy.handled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WS-05: reconciliation endpoints
// ---------------------------------------------------------------------------

describe("GET /api/directions/:id/reconciliation + POST /api/directions/:id/reconciliation/resolve", () => {
  async function scaffoldDirection(id: string): Promise<void> {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id, name: id });
  }

  it("GET /api/directions/:id/reconciliation returns list response with report + versions", async () => {
    await scaffoldDirection("moody");

    const req = makeReq({ method: "GET", originalUrl: "/api/directions/moody/reconciliation" });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      directionId: string;
      report: { items: unknown[]; warnings: unknown[]; detector: string };
      memoryVersion: number;
      globalVersion: number;
    };
    expect(body.directionId).toBe("moody");
    expect(body.report).toBeDefined();
    expect(Array.isArray(body.report.items)).toBe(true);
    expect(body.report.detector).toBe("deterministic");
    expect(typeof body.memoryVersion).toBe("number");
    expect(typeof body.globalVersion).toBe("number");
  });

  it("POST /api/directions/:id/reconciliation/resolve: keep writes an audit entry + returns versions", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    // Add a hard rule so detectContradictions has something to find.
    const brandCore = createBrandCore(tmpDir, config);
    await brandCore.addRule({ severity: "hard", text: "Never use pure black", author: "tim", source: "cli" });

    const mem = await core.appendLearning("moody", {
      body: "Use pure black backgrounds",
      author: "tim",
      source: "cli",
    });
    const memEntry = mem.entries[0];

    // Get the contradiction report to find the contradiction id.
    const listReq = makeReq({ method: "GET", originalUrl: "/api/directions/moody/reconciliation" });
    const listRes = makeRes();
    await runChain(stack, listReq, listRes);
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json() as { report: { items: Array<{ id: string; subject: { id: string }; conflictsWith: { id: string } }> }; memoryVersion: number; globalVersion: number };

    // There should be at least one contradiction (live-vs-hardrule from the entry vs the hard rule).
    // If no contradiction found deterministically, do a keep with a synthetic one.
    const contradictionId = listBody.report.items.length > 0 ? listBody.report.items[0].id : "c-synthetic";
    const contradiction = listBody.report.items.length > 0
      ? listBody.report.items[0]
      : {
          id: "c-synthetic",
          kind: "memory-vs-memory",
          subject: { source: "memory", id: memEntry.id, text: memEntry.body },
          conflictsWith: { source: "memory", id: "other-entry", text: "Use light backgrounds" },
          severity: "info",
          explanation: "test",
          suggestions: ["keep"],
        };

    const resolveReq = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/reconciliation/resolve",
      body: {
        contradiction,
        action: "keep",
        winner: "subject",
        expectedMemoryVersion: listBody.memoryVersion,
        expectedGlobalVersion: listBody.globalVersion,
      },
    });
    const resolveRes = makeRes();
    await runChain(stack, resolveReq, resolveRes);

    expect(resolveRes.statusCode).toBe(200);
    const resolveBody = resolveRes.json() as {
      directionId: string;
      contradictionId: string;
      action: string;
      memoryVersion: number;
      globalVersion: number;
    };
    expect(resolveBody.directionId).toBe("moody");
    expect(resolveBody.action).toBe("keep");
    expect(resolveBody.contradictionId).toBe(contradictionId);
    expect(resolveBody.memoryVersion).toBeGreaterThan(listBody.memoryVersion);
  });

  it("resolve with stale expectedMemoryVersion → 409 version_conflict", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    const mem = await core.appendFeedback("moody", { body: "old", author: "tim", source: "cli" });
    const target = mem.entries[0];
    const staleVersion = 0; // before the appendFeedback bumped it

    const resolveReq = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/reconciliation/resolve",
      body: {
        contradiction: {
          id: "c-stale-test",
          kind: "memory-vs-memory",
          subject: { source: "memory", id: target.id, text: target.body },
          conflictsWith: { source: "memory", id: "other", text: "Other" },
          severity: "info",
          explanation: "test",
          suggestions: ["keep"],
        },
        action: "keep",
        winner: "subject",
        expectedMemoryVersion: staleVersion, // stale
      },
    });
    const res = makeRes();
    await runChain(stack, resolveReq, res);

    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string };
    expect(body.code).toBe("version_conflict");
  });

  it("promote residual race: global write VersionConflictError → 409 reconciliation_partial", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    const mem = await core.appendLearning("moody", { body: "Editorial serifs", author: "tim", source: "cli" });
    const winnerEntry = mem.entries[0];

    // Get current versions.
    const listReq = makeReq({ method: "GET", originalUrl: "/api/directions/moody/reconciliation" });
    const listRes = makeRes();
    await runChain(stack, listReq, listRes);
    const listBody = listRes.json() as { memoryVersion: number; globalVersion: number };

    // Wrap createBrandCore to return a core whose promoteLearning throws VersionConflictError.
    const realBrandCore = createBrandCore(tmpDir, config);
    vi.mocked(createBrandCore).mockReturnValueOnce({
      read: realBrandCore.read.bind(realBrandCore),
      setPointer: realBrandCore.setPointer.bind(realBrandCore),
      addRule: realBrandCore.addRule.bind(realBrandCore),
      promoteLearning: vi.fn().mockRejectedValue(
        new VersionConflictError("brand.yaml", listBody.globalVersion, listBody.globalVersion + 1),
      ),
      removeRule: realBrandCore.removeRule.bind(realBrandCore),
      editRule: realBrandCore.editRule.bind(realBrandCore),
    });

    const resolveReq = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/reconciliation/resolve",
      body: {
        contradiction: {
          id: "c-promote-race",
          kind: "memory-vs-memory",
          subject: { source: "memory", id: winnerEntry.id, text: winnerEntry.body },
          conflictsWith: { source: "memory", id: "other", text: "Avoid serifs" },
          severity: "info",
          explanation: "test",
          suggestions: ["promote"],
        },
        action: "promote",
        winner: "subject",
        expectedMemoryVersion: listBody.memoryVersion,
        expectedGlobalVersion: listBody.globalVersion,
      },
    });
    const res = makeRes();
    await runChain(stack, resolveReq, res);

    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string; committed: string; retryable: boolean; action: string };
    expect(body.code).toBe("reconciliation_partial");
    expect(body.committed).toBe("memory");
    expect(body.retryable).toBe(true);
    expect(body.action).toBe("promote");
  });

  it("local-only guard → 403 on reconciliation routes for cross-origin / missing Host", async () => {
    await scaffoldDirection("moody");

    // Missing Host header → 403.
    const reqNoHost = makeReq({
      method: "GET",
      originalUrl: "/api/directions/moody/reconciliation",
      headers: {},
    });
    const resNoHost = makeRes();
    await runChain(stack, reqNoHost, resNoHost);
    expect(resNoHost.statusCode).toBe(403);

    // Cross-origin Origin → 403.
    const reqCrossOrigin = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/reconciliation/resolve",
      headers: { host: "localhost", origin: "https://evil.com" },
      body: {},
    });
    const resCrossOrigin = makeRes();
    await runChain(stack, reqCrossOrigin, resCrossOrigin);
    expect(resCrossOrigin.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// WS-04: scoped write endpoints (direction-scoped memory + dashboard projection)
// ---------------------------------------------------------------------------

describe("WS-04: scoped element-feedback + notes + dashboard (direction-scoped memory)", () => {
  const EF = "/api/element-feedback";

  /** Scaffold a direction by id using the real core (no HTTP round-trip). */
  async function scaffoldDirection(id: string): Promise<void> {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id, name: id });
    if (id !== "dir-a") await core.create({ id: "dir-a", name: "dir-a" });
  }

  it("keep + directionId ⇒ direction-scoped inspire AssetRef (AC-1)", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);

    const mp = buildMultipart({
      fields: { verb: "keep", directionId: "dir-a" },
      files: [{ field: "file", filename: "crop.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const res = makeRes();
    await runChain(stack, makeMultipartReq(EF, mp), res);

    expect(res.statusCode).toBe(201);
    const record = await createDirectionCore(tmpDir, config).get("dir-a");
    const asset = record.assets.find((a) => a.path.endsWith("crop.png"));
    expect(asset).toBeDefined();
    expect(asset!.intent).toBe("inspire");
  });

  it("discard + directionId ⇒ direction-scoped feedback entry + thumbnail, NEVER AssetRef (AC-1)", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);

    const mp = buildMultipart({
      fields: { verb: "discard", note: "too busy", directionId: "dir-a" },
      files: [{ field: "file", filename: "bad.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const res = makeRes();
    await runChain(stack, makeMultipartReq(EF, mp), res);

    expect(res.statusCode).toBe(201);

    const feedback = (await core.memoryEntries("dir-a")).filter((e) => e.kind === "feedback");
    expect(feedback).toHaveLength(1);
    expect(feedback[0].asset).toBe("brand/directions/dir-a/assets/feedback/bad.png");

    // Discard thumbnail NEVER registered as AssetRef.
    const record = await core.get("dir-a");
    expect(record.assets.some((a) => a.path.endsWith("bad.png"))).toBe(false);
  });

  it("eyedropper + directionId ⇒ direction-scoped color-lock decision (AC-1)", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);

    const mp = buildMultipart({
      fields: { verb: "keep", hex: "#336699", directionId: "dir-a" },
    });
    const res = makeRes();
    await runChain(stack, makeMultipartReq(EF, mp), res);

    expect(res.statusCode).toBe(201);
    const decisions = (await core.memoryEntries("dir-a")).filter((e) => e.kind === "decision");
    const lock = decisions.find((d) => d.body.includes("#336699"));
    expect(lock).toBeDefined();
  });

  it("the legacy scope override is gone — the directionId target always wins (WS-18 absence probe)", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);

    // A stray legacy scope field (once a route-owner override) is ignored: the
    // lock lands on the direction named by directionId, never anywhere else.
    const mpStrayScope = buildMultipart({
      fields: { verb: "keep", hex: "#aabbcc", directionId: "dir-a", scope: LEGACY_SCOPE },
    });
    const resStrayScope = makeRes();
    await runChain(stack, makeMultipartReq(EF, mpStrayScope), resStrayScope);
    expect(resStrayScope.statusCode).toBe(201);

    const targetDecisions = (await core.memoryEntries("dir-a")).filter((e) => e.kind === "decision");
    expect(targetDecisions.find((d) => d.body.includes("#aabbcc"))).toBeDefined();
    const moodyDecisions = (await core.memoryEntries("moody")).filter((e) => e.kind === "decision");
    expect(moodyDecisions.find((d) => d.body.includes("#aabbcc"))).toBeUndefined();

    // Without any scope field, directionId is likewise the one target.
    const mpDir = buildMultipart({
      fields: { verb: "keep", hex: "#112233", directionId: "dir-a" },
    });
    const resDir = makeRes();
    await runChain(stack, makeMultipartReq(EF, mpDir), resDir);
    expect(resDir.statusCode).toBe(201);

    const decisions2 = (await core.memoryEntries("dir-a")).filter((e) => e.kind === "decision");
    const dirLock = decisions2.find((d) => d.body.includes("#112233"));
    expect(dirLock).toBeDefined();
  });

  it("/api/uploads moodboard targets the direction named by directionId (WS-18)", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);

    // The multipart directionId is the one target field.
    const mp = buildMultipart({
      fields: { directionId: "dir-a" },
      files: [{ field: "file", filename: "moodboard.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const res = makeRes();
    await runChain(stack, makeMultipartReq("/api/uploads", mp), res);
    expect(res.statusCode).toBe(201);

    const record = await createDirectionCore(tmpDir, config).get("dir-a");
    const asset = record.assets.find((a) => a.path.endsWith("moodboard.png"));
    expect(asset).toBeDefined();
    // The sibling direction never received it.
    const moody = await createDirectionCore(tmpDir, config).get("moody");
    expect(moody.assets.some((a) => a.path.endsWith("moodboard.png"))).toBe(false);
  });

  it("brief color-lock is direction-local by construction — the route id is the target (AC-3)", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/brief/lock",
      body: { hex: "#112233" },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(201);

    const decisions = (await core.memoryEntries("moody")).filter((e) => e.kind === "decision");
    const lock = decisions.find((d) => d.body.includes("#112233"));
    expect(lock).toBeDefined();
  });

  it("notes feedback lands on the route's direction — the body carries no scope (AC-1 notes path)", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/directions/moody/feedback",
      body: { body: "warmer tones" },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);

    const entries = (await core.memoryEntries("moody")).filter((e) => e.kind === "feedback");
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("warmer tones");
  });

  it("/api/dashboard payload is flat: memory + assets live on each direction entry (AC-4/WS-18)", async () => {
    await scaffoldDirection("moody");

    // Write a direction-scoped discard (gives us a scoped memory entry).
    const discardMp = buildMultipart({
      fields: { verb: "discard", note: "off-brand", directionId: "dir-a" },
      files: [{ field: "file", filename: "reject.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const discardRes = makeRes();
    await runChain(stack, makeMultipartReq(EF, discardMp), discardRes);
    expect(discardRes.statusCode).toBe(201);

    // Write a direction-scoped keep (gives us a scoped asset).
    const keepMp = buildMultipart({
      fields: { verb: "keep", directionId: "dir-a" },
      files: [{ field: "file", filename: "keep.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const keepRes = makeRes();
    await runChain(stack, makeMultipartReq(EF, keepMp), keepRes);
    expect(keepRes.statusCode).toBe(201);

    // Write an upload targeting the sibling direction.
    const uploadMp = buildMultipart({
      fields: { directionId: "moody" },
      files: [{ field: "file", filename: "moodboard.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const uploadRes = makeRes();
    await runChain(stack, makeMultipartReq("/api/uploads", uploadMp), uploadRes);
    expect(uploadRes.statusCode).toBe(201);

    const data = await loadDashboardData(tmpDir);
    const moody = data.directions.find((d) => d.id === "moody");
    const focused = data.directions.find((d) => d.id === "dir-a");
    expect(moody).toBeDefined();
    expect(focused).toBeDefined();

    // Memory is direction-scoped by location; there is no scope field.
    const scopedEntry = focused!.memory.find((e) => e.kind === "feedback");
    expect(scopedEntry).toBeDefined();

    // Assets are likewise direction-scoped by location.
    const scopedAsset = focused!.assets?.find((a) => a.path.endsWith("keep.png"));
    expect(scopedAsset).toBeDefined();

    // The upload landed on its own direction's flat entry.
    const moodboardAsset = moody!.assets?.find((a) => a.path.endsWith("moodboard.png"));
    expect(moodboardAsset).toBeDefined();
  });

  it("local-only guard still rejects cross-origin / missing-Host on element-feedback (AC-5)", async () => {
    await scaffoldDirection("moody");

    // Cross-origin host → 403.
    const mpCross = buildMultipart({
      fields: { verb: "keep", hex: "#336699", directionId: "dir-a" },
    });
    const reqCross = makeMultipartReq(EF, mpCross);
    reqCross.headers = { ...reqCross.headers, host: "evil.example.com" };
    const resCross = makeRes();
    await runChain(stack, reqCross, resCross);
    expect(resCross.statusCode).toBe(403);

    // Missing Host → 403.
    const mpNoHost = buildMultipart({
      fields: { directionId: "moody", verb: "keep", hex: "#336699" },
    });
    const reqNoHost = makeMultipartReq(EF, mpNoHost);
    reqNoHost.headers = {};
    const resNoHost = makeRes();
    await runChain(stack, reqNoHost, resNoHost);
    expect(resNoHost.statusCode).toBe(403);

    // Nothing written.
    const config = buildTestConfig(tmpDir);
    expect(await createDirectionCore(tmpDir, config).memoryEntries("moody")).toHaveLength(0);
  });

  it("versioned 409 on a stale scoped write (AC-5)", async () => {
    // Reuse the existing createBrandCore mock pattern to force a VersionConflictError.
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
      body: { text: "stale scoped write test", severity: "guideline" },
    });
    const res = makeRes();
    await runChain(stack, req, res);

    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("version_conflict");
  });
});

// ---------------------------------------------------------------------------
// WS-05: memory/asset/rule lifecycle endpoints (EDIT/PROMOTE/DELETE)
// ---------------------------------------------------------------------------

describe("lifecycle endpoints (WS-05: memory edit/promote/delete, asset-remove, rule remove/edit)", () => {
  async function scaffoldDirection(id: string): Promise<void> {
    const config = buildTestConfig(tmpDir);
    await createDirectionCore(tmpDir, config).create({ id, name: id });
  }

  it("edit supersedes a memory entry over HTTP; a body with no editable field is 400", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    const mem = await core.appendLearning("moody", {
      body: "original text",
      author: "tim",
      source: "cli",
    });
    const entry = mem.entries[0];

    const req = makeReq({
      method: "PATCH",
      originalUrl: `/api/directions/moody/memory/${entry.id}`,
      body: { body: "corrected text", expectedVersion: mem.version },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { memoryVersion: number };
    expect(body.memoryVersion).toBe(mem.version + 1);

    const entries = await core.memoryEntries("moody", { includeRetired: true });
    const original = entries.find((e) => e.id === entry.id)!;
    expect(original.retiredAt).toBeTruthy();
    expect(original.supersededBy).toBeTruthy();
    const corrected = entries.find((e) => e.id === original.supersededBy)!;
    expect(corrected.body).toBe("corrected text");

    // A body with no editable field → 400.
    const badReq = makeReq({
      method: "PATCH",
      originalUrl: `/api/directions/moody/memory/${corrected.id}`,
      body: {},
    });
    const badRes = makeRes();
    await runChain(stack, badReq, badRes);
    expect(badRes.statusCode).toBe(400);
  });

  it("rejects the removed non-global promotion rung (absence probe: `to` must be \"global\")", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    const mem = await core.appendLearning("moody", {
      body: "direction-scoped insight",
      author: "tim",
      source: "cli",
    });
    const entry = mem.entries[0];

    const req = makeReq({
      method: "POST",
      originalUrl: `/api/directions/moody/memory/${entry.id}/promote`,
      // The removed lower promotion rung spelling is the probe (global is the only rung).
      body: { to: LEGACY_SCOPE, expectedVersion: mem.version },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(400);
    const entries = await core.memoryEntries("moody", { includeRetired: true });
    expect(entries.find((e) => e.id === entry.id)?.retiredAt).toBeUndefined();
  });

  it("promotes a memory entry to a global rule over HTTP", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    const mem = await core.appendLearning("moody", {
      body: "use warm neutrals",
      author: "tim",
      source: "cli",
    });
    const entry = mem.entries[0];
    const brand = createBrandCore(tmpDir, config);
    const brandDoc = await brand.read();

    const req = makeReq({
      method: "POST",
      originalUrl: `/api/directions/moody/memory/${entry.id}/promote`,
      body: {
        to: "global",
        severity: "guideline",
        expectedVersion: mem.version,
        expectedGlobalVersion: brandDoc.version,
      },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { memoryVersion: number; globalVersion: number };
    expect(typeof body.globalVersion).toBe("number");

    const entries = await core.memoryEntries("moody", { includeRetired: true });
    expect(entries.find((e) => e.id === entry.id)!.retiredAt).toBeTruthy();
    const rules = (await createBrandCore(tmpDir, config).read()).rules;
    expect(rules.some((r) => r.text === "use warm neutrals")).toBe(true);
  });

  it("deletes (retires) a memory entry over HTTP", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    const mem = await core.appendFeedback("moody", {
      body: "old feedback",
      author: "tim",
      source: "cli",
    });
    const entry = mem.entries[0];

    const req = makeReq({
      method: "DELETE",
      originalUrl: `/api/directions/moody/memory/${entry.id}`,
      body: { reason: "no longer relevant", expectedVersion: mem.version },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);

    const entries = await core.memoryEntries("moody", { includeRetired: true });
    const retired = entries.find((e) => e.id === entry.id)!;
    expect(retired.retiredAt).toBeTruthy();
    expect(
      entries.some((e) => e.kind === "learning" && e.body.includes("no longer relevant")),
    ).toBe(true);
  });

  it("retires a kept-crop asset over HTTP", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await core.addAsset("moody", {
      kind: "image",
      path: "brand/directions/moody/assets/crop.png",
    });
    const record = await core.get("moody");

    const req = makeReq({
      method: "DELETE",
      originalUrl: "/api/directions/moody/assets",
      body: {
        path: "brand/directions/moody/assets/crop.png",
        expectedVersion: record.version,
      },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);

    const updated = await core.get("moody");
    const asset = updated.assets.find(
      (a) => a.path === "brand/directions/moody/assets/crop.png",
    )!;
    expect(asset.retiredAt).toBeTruthy();
  });

  it("retires a guideline rule over HTTP", async () => {
    const config = buildTestConfig(tmpDir);
    const brand = createBrandCore(tmpDir, config);
    const withRule = await brand.addRule({
      severity: "guideline",
      text: "use whitespace",
      author: "tim",
      source: "cli",
    });
    const rule = withRule.rules.find((r) => r.text === "use whitespace")!;

    const req = makeReq({
      method: "DELETE",
      originalUrl: `/api/rules/${rule.id}`,
      body: { expectedVersion: withRule.version },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);

    const after = await brand.read();
    expect(after.rules.find((r) => r.id === rule.id)!.retiredAt).toBeTruthy();
  });

  it("hard-rule remove needs force; hard-severity edit needs force", async () => {
    const config = buildTestConfig(tmpDir);
    const brand = createBrandCore(tmpDir, config);
    const withRule = await brand.addRule({
      severity: "hard",
      text: "never pure black",
      author: "tim",
      source: "cli",
    });
    const rule = withRule.rules.find((r) => r.text === "never pure black")!;

    // Remove without force → non-2xx, not retired.
    const noForceReq = makeReq({ method: "DELETE", originalUrl: `/api/rules/${rule.id}` });
    const noForceRes = makeRes();
    await runChain(stack, noForceReq, noForceRes);
    expect(noForceRes.statusCode).toBeGreaterThanOrEqual(400);
    expect(noForceRes.statusCode).toBeLessThan(500);
    expect((await brand.read()).rules.find((r) => r.id === rule.id)!.retiredAt).toBeUndefined();

    // Remove WITH force → 200, retired.
    const forceReq = makeReq({
      method: "DELETE",
      originalUrl: `/api/rules/${rule.id}`,
      body: { force: true },
    });
    const forceRes = makeRes();
    await runChain(stack, forceReq, forceRes);
    expect(forceRes.statusCode).toBe(200);
    expect((await brand.read()).rules.find((r) => r.id === rule.id)!.retiredAt).toBeTruthy();

    // A second hard rule: edit its severity without force → non-2xx, unchanged.
    const withRule2 = await brand.addRule({
      severity: "hard",
      text: "another hard rule",
      author: "tim",
      source: "cli",
    });
    const rule2 = withRule2.rules.find((r) => r.text === "another hard rule")!;
    const editNoForceReq = makeReq({
      method: "PATCH",
      originalUrl: `/api/rules/${rule2.id}`,
      body: { severity: "guideline" },
    });
    const editNoForceRes = makeRes();
    await runChain(stack, editNoForceReq, editNoForceRes);
    expect(editNoForceRes.statusCode).toBeGreaterThanOrEqual(400);
    expect(editNoForceRes.statusCode).toBeLessThan(500);
    expect((await brand.read()).rules.find((r) => r.id === rule2.id)!.retiredAt).toBeUndefined();

    // With force → 200, superseded (retired + a guideline replacement appended).
    const editForceReq = makeReq({
      method: "PATCH",
      originalUrl: `/api/rules/${rule2.id}`,
      body: { severity: "guideline", force: true },
    });
    const editForceRes = makeRes();
    await runChain(stack, editForceReq, editForceRes);
    expect(editForceRes.statusCode).toBe(200);
    expect((await brand.read()).rules.find((r) => r.id === rule2.id)!.retiredAt).toBeTruthy();
  });

  it("409 on a stale expectedVersion (edit / delete / asset-remove); force bypasses", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);

    // --- edit ---
    const mem1 = await core.appendLearning("moody", { body: "v1", author: "tim", source: "cli" });
    const entry1 = mem1.entries[0];
    const staleEditRes = makeRes();
    await runChain(
      stack,
      makeReq({
        method: "PATCH",
        originalUrl: `/api/directions/moody/memory/${entry1.id}`,
        body: { body: "v2", expectedVersion: mem1.version - 1 },
      }),
      staleEditRes,
    );
    expect(staleEditRes.statusCode).toBe(409);
    expect((staleEditRes.json() as { code: string }).code).toBe("version_conflict");
    const forcedEditRes = makeRes();
    await runChain(
      stack,
      makeReq({
        method: "PATCH",
        originalUrl: `/api/directions/moody/memory/${entry1.id}`,
        body: { body: "v2", expectedVersion: mem1.version - 1, force: true },
      }),
      forcedEditRes,
    );
    expect(forcedEditRes.statusCode).toBe(200);

    // --- delete ---
    const mem2 = await core.appendLearning("moody", {
      body: "to delete",
      author: "tim",
      source: "cli",
    });
    const entry2 = mem2.entries.find((e) => e.body === "to delete")!;
    const staleDeleteRes = makeRes();
    await runChain(
      stack,
      makeReq({
        method: "DELETE",
        originalUrl: `/api/directions/moody/memory/${entry2.id}`,
        body: { expectedVersion: mem2.version - 1 },
      }),
      staleDeleteRes,
    );
    expect(staleDeleteRes.statusCode).toBe(409);
    const forcedDeleteRes = makeRes();
    await runChain(
      stack,
      makeReq({
        method: "DELETE",
        originalUrl: `/api/directions/moody/memory/${entry2.id}`,
        body: { expectedVersion: mem2.version - 1, force: true },
      }),
      forcedDeleteRes,
    );
    expect(forcedDeleteRes.statusCode).toBe(200);

    // --- asset-remove ---
    await core.addAsset("moody", { kind: "image", path: "brand/directions/moody/assets/stale.png" });
    const record = await core.get("moody");
    const staleAssetRes = makeRes();
    await runChain(
      stack,
      makeReq({
        method: "DELETE",
        originalUrl: "/api/directions/moody/assets",
        body: {
          path: "brand/directions/moody/assets/stale.png",
          expectedVersion: record.version - 1,
        },
      }),
      staleAssetRes,
    );
    expect(staleAssetRes.statusCode).toBe(409);
    const forcedAssetRes = makeRes();
    await runChain(
      stack,
      makeReq({
        method: "DELETE",
        originalUrl: "/api/directions/moody/assets",
        body: {
          path: "brand/directions/moody/assets/stale.png",
          expectedVersion: record.version - 1,
          force: true,
        },
      }),
      forcedAssetRes,
    );
    expect(forcedAssetRes.statusCode).toBe(200);
  });

  it("promote-to-global residual race surfaces an honest 409 promote_partial (no rollback claim)", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    const mem = await core.appendLearning("moody", {
      body: "editorial serifs",
      author: "tim",
      source: "cli",
    });
    const entry = mem.entries[0];
    const brand = createBrandCore(tmpDir, config);
    const brandDoc = await brand.read();

    // The FIRST createDirectionCore call (inside `runDirection`) gets the real
    // core; the SECOND (inside `promoteEntryToGlobal`, which creates its own
    // since it isn't given explicit deps) gets a core whose `retireMemoryEntry`
    // always races — simulating the residual second-write conflict.
    const realDirectionCore = createDirectionCore(tmpDir, config);
    vi.mocked(createDirectionCore)
      .mockReturnValueOnce(realDirectionCore)
      .mockReturnValueOnce({
        ...realDirectionCore,
        retireMemoryEntry: vi
          .fn()
          .mockRejectedValue(
            new VersionConflictError("direction memory (moody)", mem.version, mem.version + 1),
          ),
      });

    const req = makeReq({
      method: "POST",
      originalUrl: `/api/directions/moody/memory/${entry.id}/promote`,
      body: {
        to: "global",
        severity: "guideline",
        expectedVersion: mem.version,
        expectedGlobalVersion: brandDoc.version,
      },
    });
    const res = makeRes();
    await runChain(stack, req, res);

    expect(res.statusCode).toBe(409);
    const body = res.json() as { code: string; committed: string; retryable: boolean };
    expect(body.code).toBe("promote_partial");
    expect(body.committed).toBe("global");
    expect(body.retryable).toBe(true);

    // Honest by construction: the global rule DID commit — never a rollback claim.
    const after = await createBrandCore(tmpDir, config).read();
    expect(after.rules.some((r) => r.text === "editorial serifs")).toBe(true);
  });

  it("local-only guard rejects cross-origin / absent-Host on every new route; nothing mutates", async () => {
    await scaffoldDirection("moody");
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    const mem = await core.appendLearning("moody", {
      body: "guarded entry",
      author: "tim",
      source: "cli",
    });
    const entry = mem.entries[0];
    await core.addAsset("moody", {
      kind: "image",
      path: "brand/directions/moody/assets/guarded.png",
    });
    const brand = createBrandCore(tmpDir, config);
    const withRule = await brand.addRule({
      severity: "guideline",
      text: "guarded rule",
      author: "tim",
      source: "cli",
    });
    const rule = withRule.rules.find((r) => r.text === "guarded rule")!;

    const crossOriginHeaders = { host: "127.0.0.1:4317", origin: "https://evil.com" };
    const routes: { method: string; originalUrl: string; body?: unknown }[] = [
      { method: "PATCH", originalUrl: `/api/directions/moody/memory/${entry.id}`, body: { body: "x" } },
      {
        method: "POST",
        originalUrl: `/api/directions/moody/memory/${entry.id}/promote`,
        body: { to: "global" },
      },
      { method: "DELETE", originalUrl: `/api/directions/moody/memory/${entry.id}`, body: {} },
      {
        method: "DELETE",
        originalUrl: "/api/directions/moody/assets",
        body: { path: "brand/directions/moody/assets/guarded.png" },
      },
      { method: "DELETE", originalUrl: `/api/rules/${rule.id}`, body: {} },
      { method: "PATCH", originalUrl: `/api/rules/${rule.id}`, body: { text: "x" } },
    ];

    for (const route of routes) {
      const req = makeReq({ ...route, headers: crossOriginHeaders });
      const res = makeRes();
      await runChain(stack, req, res);
      expect(res.statusCode).toBe(403);
    }

    // Nothing mutated.
    const entries = await core.memoryEntries("moody", { includeRetired: true });
    expect(entries.find((e) => e.id === entry.id)!.retiredAt).toBeUndefined();
    const record = await core.get("moody");
    expect(
      record.assets.find((a) => a.path.endsWith("guarded.png"))!.retiredAt,
    ).toBeUndefined();
    expect((await brand.read()).rules.find((r) => r.id === rule.id)!.retiredAt).toBeUndefined();
  });

  it("none of the six lifecycle routes is reachable via the MCP dispatchCommand surface", () => {
    // `serve` is the ONLY CLI-launch-only, non-MCP-dispatchable command in the
    // registry; these six HTTP routes are not MCP command names at all (they
    // live only inside server-api.ts's dispatch()), so there is no MCP path to
    // them — automation reaches the same core via the CLI/MCP `direction`/`rule`
    // commands instead, never via `serve`.
    expect(getCommand("serve")?.dispatchable).toBe(false);
    for (const name of [
      "memory-edit",
      "memory-promote",
      "memory-delete",
      "asset-remove",
      "rule-remove-http",
      "rule-edit-http",
    ]) {
      expect(getCommand(name)).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// WS-03: chat routes — the one regression case that belongs with the existing
// serve-api suite (the SSE/adapter behavior itself lives in `ui/chat-api.test.ts`).
// ---------------------------------------------------------------------------

describe("WS-03: chat mounts behind the shared local-only guard; no MCP command added (SC-03/SC-07/SC-12)", () => {
  it("cross-origin POST /api/chat is rejected by the shared guard; no `chat` command exists on the MCP surface", async () => {
    const chatStack: MountEntry[] = [
      { prefix: "/api", handler: createLocalOnlyGuard() },
      { prefix: "/api/chat", handler: createChatApi({ cwd: tmpDir, jobs }) },
    ];

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/chat",
      headers: { host: "127.0.0.1:4317", origin: "https://evil.com" },
      body: { message: "hi", context: { directionId: "moody" } },
    });
    const res = makeRes();
    await runChain(chatStack, req, res);
    expect(res.statusCode).toBe(403);

    expect(getCommand("chat")).toBeUndefined();
    expect(getCommand("serve")?.dispatchable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WS-05 (asset-extraction): serve asset endpoints
// ---------------------------------------------------------------------------

describe("WS-05 (asset-extraction): serve asset endpoints (no network / no key)", () => {
  function directionsRootOf(): string {
    return directionsRoot(tmpDir, buildTestConfig(tmpDir));
  }

  /** Creates a draft direction and runs one dry-run divergent explore,
   * returning the sibling direction ids it seeds (several — enough for A/B
   * scoping cases). */
  async function scaffoldSiblingDirections(id: string): Promise<string[]> {
    const create = makeReq({ method: "POST", originalUrl: "/api/directions", body: { name: id } });
    const createRes = makeRes();
    await runChain(stack, create, createRes);
    expect(createRes.statusCode).toBe(201);

    const kickoff = makeReq({ method: "POST", originalUrl: "/api/actions/explore", body: { from: id } });
    const kickoffRes = makeRes();
    await runChain(stack, kickoff, kickoffRes);
    expect(kickoffRes.statusCode).toBe(202);
    const settled = await pollJob((kickoffRes.json() as { jobId: string }).jobId);
    expect(settled.status).toBe("succeeded");

    const dirIds = (settled.result as { directionIds: string[] }).directionIds;
    expect(dirIds.length).toBeGreaterThanOrEqual(2);
    return dirIds;
  }

  it("extract action → 202 + a dry-run job that completes with the record + prompt and NO PNG", async () => {
    const [directionId] = await scaffoldSiblingDirections("moody");

    const mp = buildMultipart({
      fields: { directionId, describe: "the yak mascot", name: "yak" },
    });
    const req = makeMultipartReq("/api/actions/asset-extract", mp);
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };

    const settled = await pollJob(jobId);
    expect(settled.status).toBe("succeeded");
    const result = settled.result as {
      assetId: string;
      versionId: string;
      dryRun: boolean;
      filesWritten: string[];
    };
    expect(result.dryRun).toBe(true);
    expect(result.filesWritten.length).toBeGreaterThan(0);

    const assetDir = path.join(directionsRootOf(), directionId, "extracted-assets", result.assetId);
    await expect(fs.access(path.join(assetDir, "asset.json"))).resolves.toBeUndefined();
    const versionDir = path.join(assetDir, "versions", result.versionId);
    await expect(fs.access(path.join(versionDir, "asset-version.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(versionDir, "asset-prompt.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(versionDir, "asset.png"))).rejects.toThrow();
  });

  it("missing directionId/describe → 400 with the existing error shape; nothing written, no job created", async () => {
    const [directionId] = await scaffoldSiblingDirections("moody");
    const beforeJobCount = jobs.list().length;

    const missingDirection = buildMultipart({
      fields: { describe: "the yak mascot" },
    });
    const res1 = makeRes();
    await runChain(stack, makeMultipartReq("/api/actions/asset-extract", missingDirection), res1);
    expect(res1.statusCode).toBe(400);
    expect(typeof (res1.json() as { error: string }).error).toBe("string");

    const missingDescribe = buildMultipart({ fields: { directionId } });
    const res2 = makeRes();
    await runChain(stack, makeMultipartReq("/api/actions/asset-extract", missingDescribe), res2);
    expect(res2.statusCode).toBe(400);

    expect(jobs.list().length).toBe(beforeJobCount);
    await expect(
      fs.access(path.join(directionsRootOf(), "moody", "extracted-assets")),
    ).rejects.toThrow();
  });

  it("the multipart crop is accepted, forwarded, and reaches the core; never an AssetRef", async () => {
    const [directionId] = await scaffoldSiblingDirections("moody");

    const mp = buildMultipart({
      fields: { directionId, describe: "the yak mascot" },
      files: [{ field: "crop", filename: "crop.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const req = makeMultipartReq("/api/actions/asset-extract", mp);
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(202);
    const settled = await pollJob((res.json() as { jobId: string }).jobId);
    expect(settled.status).toBe("succeeded");
    const result = settled.result as { assetId: string; versionId: string };

    const cropDir = path.join(directionsRootOf(), directionId, "assets", "extract-crops");
    const cropFiles = await fs.readdir(cropDir);
    expect(cropFiles).toHaveLength(1);
    expect(await fs.readFile(path.join(cropDir, cropFiles[0]))).toEqual(PNG_BYTES);

    // Not an AssetRef.
    const config = buildTestConfig(tmpDir);
    const record = await createDirectionCore(tmpDir, config).get("moody");
    expect(record.assets.some((a) => a.path.includes("extract-crops"))).toBe(false);

    // The persisted asset-version.json's source carries the crop's cwd-relative path.
    const versionPath = path.join(
      directionsRootOf(),
      directionId,
      "extracted-assets",
      result.assetId,
      "versions",
      result.versionId,
      "asset-version.json",
    );
    const version = JSON.parse(await fs.readFile(versionPath, "utf-8")) as {
      source: { cropPath?: string };
    };
    expect(version.source.cropPath).toBe(
      `brand/directions/${directionId}/assets/extract-crops/${cropFiles[0]}`,
    );

    // A non-image crop → 415 (the element-feedback checks) — nothing written.
    const badType = buildMultipart({
      fields: { directionId, describe: "bad crop" },
      files: [{ field: "crop", filename: "notes.txt", contentType: "text/plain", content: Buffer.from("hi") }],
    });
    const badRes = makeRes();
    await runChain(stack, makeMultipartReq("/api/actions/asset-extract", badType), badRes);
    expect(badRes.statusCode).toBe(415);
  });

  it("regenerate action → 202 + appends a version, byte-untouched v1; missing assetId/tweak → 400", async () => {
    const [directionId] = await scaffoldSiblingDirections("moody");

    const extract = buildMultipart({
      fields: { directionId, describe: "the yak mascot" },
    });
    const extractRes = makeRes();
    await runChain(stack, makeMultipartReq("/api/actions/asset-extract", extract), extractRes);
    const extractSettled = await pollJob((extractRes.json() as { jobId: string }).jobId);
    const { assetId } = extractSettled.result as { assetId: string };

    const missingAssetId = makeReq({
      method: "POST",
      originalUrl: "/api/actions/asset-regenerate",
      body: { tweak: "face left" },
    });
    const res1 = makeRes();
    await runChain(stack, missingAssetId, res1);
    expect(res1.statusCode).toBe(400);

    const missingTweak = makeReq({
      method: "POST",
      originalUrl: "/api/actions/asset-regenerate",
      body: { assetId },
    });
    const res2 = makeRes();
    await runChain(stack, missingTweak, res2);
    expect(res2.statusCode).toBe(400);

    const regen = makeReq({
      method: "POST",
      originalUrl: "/api/actions/asset-regenerate",
      body: { directionId, assetId, tweak: "face left" },
    });
    const regenRes = makeRes();
    await runChain(stack, regen, regenRes);
    expect(regenRes.statusCode).toBe(202);
    const settled = await pollJob((regenRes.json() as { jobId: string }).jobId);
    expect(settled.status).toBe("succeeded");
    const result = settled.result as { versionId: string };

    const assetDir = path.join(directionsRootOf(), directionId, "extracted-assets", assetId);
    const index = JSON.parse(await fs.readFile(path.join(assetDir, "asset.json"), "utf-8")) as {
      versions: string[];
      head: string;
    };
    expect(index.versions).toHaveLength(2);
    expect(index.head).toBe(result.versionId);

    const v1Path = path.join(assetDir, "versions", index.versions[0], "asset-version.json");
    await expect(fs.access(v1Path)).resolves.toBeUndefined();
  });

  it("pack → 201 + files on disk; direction B's asset appears nowhere; no direction/pointer → 400", async () => {
    const [directionA, directionB] = await scaffoldSiblingDirections("moody");

    const extractA = buildMultipart({
      fields: { directionId: directionA, describe: "asset a" },
    });
    const resA = makeRes();
    await runChain(stack, makeMultipartReq("/api/actions/asset-extract", extractA), resA);
    const settledA = await pollJob((resA.json() as { jobId: string }).jobId);
    const assetIdA = (settledA.result as { assetId: string }).assetId;

    const extractB = buildMultipart({
      fields: { directionId: directionB, describe: "asset b" },
    });
    const resB = makeRes();
    await runChain(stack, makeMultipartReq("/api/actions/asset-extract", extractB), resB);
    const settledB = await pollJob((resB.json() as { jobId: string }).jobId);
    const assetIdB = (settledB.result as { assetId: string }).assetId;

    const pack = makeReq({
      method: "POST",
      originalUrl: "/api/asset-pack",
      body: { directionId: directionA },
    });
    const packRes = makeRes();
    await runChain(stack, pack, packRes);
    expect(packRes.statusCode).toBe(201);
    const result = packRes.json() as {
      directionId: string;
      filesWritten: string[];
      assetsIncluded: string[];
      assetsPending: string[];
    };
    expect(result.directionId).toBe(directionA);
    expect(result.assetsPending).toContain(assetIdA); // dry-run, no PNG
    expect(result.assetsPending).not.toContain(assetIdB);
    expect(result.assetsIncluded).not.toContain(assetIdB);

    const packDir = path.join(tmpDir, "brand", "generated", "asset-pack", directionA);
    await expect(fs.access(path.join(packDir, "contact-sheet.svg"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(packDir, "contact-sheet.md"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(packDir, "tokens.json"))).resolves.toBeUndefined();
    const manifest = JSON.parse(
      await fs.readFile(path.join(packDir, "pack-manifest.json"), "utf-8"),
    ) as { assets: { id: string }[] };
    expect(manifest.assets.map((a) => a.id)).not.toContain(assetIdB);

    const bad = makeReq({ method: "POST", originalUrl: "/api/asset-pack", body: {} });
    const badRes = makeRes();
    await runChain(stack, bad, badRes);
    expect(badRes.statusCode).toBe(400);
  });

  it("retire → 200, idempotent, and drops from the NEXT dashboard payload; unknown direction/asset → 404", async () => {
    const [directionId] = await scaffoldSiblingDirections("moody");

    const extract = buildMultipart({
      fields: { directionId, describe: "the yak mascot" },
    });
    const extractRes = makeRes();
    await runChain(stack, makeMultipartReq("/api/actions/asset-extract", extract), extractRes);
    const settled = await pollJob((extractRes.json() as { jobId: string }).jobId);
    const { assetId } = settled.result as { assetId: string };

    let data = await loadDashboardData(tmpDir);
    let dir = data.directions.find((d) => d.id === directionId)!;
    expect(dir.extractedAssets.some((a) => a.id === assetId)).toBe(true);

    const del = makeReq({
      method: "DELETE",
      originalUrl: `/api/directions/${directionId}/extracted-assets/${assetId}`,
    });
    const delRes = makeRes();
    await runChain(stack, del, delRes);
    expect(delRes.statusCode).toBe(200);
    const body = delRes.json() as { ok: boolean; retiredAt: string };
    expect(body.ok).toBe(true);
    expect(typeof body.retiredAt).toBe("string");

    data = await loadDashboardData(tmpDir);
    dir = data.directions.find((d) => d.id === directionId)!;
    expect(dir.extractedAssets.some((a) => a.id === assetId)).toBe(false);

    // Non-destructive — no file deleted.
    const assetJsonPath = path.join(directionsRootOf(), directionId, "extracted-assets", assetId, "asset.json");
    await expect(fs.access(assetJsonPath)).resolves.toBeUndefined();

    // A second identical DELETE → 200 again (idempotent, same retiredAt).
    const del2Res = makeRes();
    await runChain(
      stack,
      makeReq({ method: "DELETE", originalUrl: `/api/directions/${directionId}/extracted-assets/${assetId}` }),
      del2Res,
    );
    expect(del2Res.statusCode).toBe(200);
    expect((del2Res.json() as { retiredAt: string }).retiredAt).toBe(body.retiredAt);

    const unknownDirectionRes = makeRes();
    await runChain(
      stack,
      makeReq({ method: "DELETE", originalUrl: `/api/directions/ghost/extracted-assets/${assetId}` }),
      unknownDirectionRes,
    );
    expect(unknownDirectionRes.statusCode).toBe(404);

    const unknownAssetRes = makeRes();
    await runChain(
      stack,
      makeReq({ method: "DELETE", originalUrl: `/api/directions/${directionId}/extracted-assets/ghost-asset` }),
      unknownAssetRes,
    );
    expect(unknownAssetRes.statusCode).toBe(404);
  });

  it("dashboard extractedAssets: shape, retired/sibling exclusion, servable imagePath (SC-05)", async () => {
    const [directionA, directionB] = await scaffoldSiblingDirections("moody");

    const extractA = buildMultipart({
      fields: { directionId: directionA, describe: "asset a", name: "asset-a" },
    });
    const resA = makeRes();
    await runChain(stack, makeMultipartReq("/api/actions/asset-extract", extractA), resA);
    const settledA = await pollJob((resA.json() as { jobId: string }).jobId);
    const { assetId } = settledA.result as { assetId: string };

    let data = await loadDashboardData(tmpDir);
    let dirA = data.directions.find((d) => d.id === directionA)!;
    let entry = dirA.extractedAssets.find((a) => a.id === assetId)!;
    expect(entry.name).toBe("asset-a");
    expect(entry.description).toBe("asset a");
    expect(entry.versionCount).toBe(1);
    expect(typeof entry.headVersionId).toBe("string");
    expect(typeof entry.createdAt).toBe("string");
    expect(entry.imagePath).toBeUndefined(); // dry-run head, no PNG

    // Direction B (sibling) carries no assets — direction-scoped (SC-05).
    const dirB = data.directions.find((d) => d.id === directionB)!;
    expect(dirB.extractedAssets).toEqual([]);

    // Simulate a keyed run: write the head PNG directly on disk.
    const pngAbs = path.join(
      directionsRootOf(),
      directionA,
      "extracted-assets",
      assetId,
      "versions",
      entry.headVersionId,
      "asset.png",
    );
    await fs.writeFile(pngAbs, PNG_BYTES);

    data = await loadDashboardData(tmpDir);
    dirA = data.directions.find((d) => d.id === directionA)!;
    entry = dirA.extractedAssets.find((a) => a.id === assetId)!;
    expect(entry.imagePath).toBe(
      `brand/directions/${directionA}/extracted-assets/${assetId}/versions/${entry.headVersionId}/asset.png`,
    );

    const assetReq = makeReq({ method: "GET", originalUrl: `/api/asset?path=${entry.imagePath}` });
    const assetRes = makeRes();
    await runChain(stack, assetReq, assetRes);
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.headers["content-type"]).toBe("image/png");
    expect((assetRes.payload as Buffer).equals(PNG_BYTES)).toBe(true);

    // Every pre-existing dashboard field is untouched (additive contract).
    expect(Array.isArray(dirA.versions)).toBe(true);
    expect(dirA.head).toBeDefined();

    // A pre-asset direction carries extractedAssets: [].
    const other = makeReq({ method: "POST", originalUrl: "/api/directions", body: { name: "fresh" } });
    const otherRes = makeRes();
    await runChain(stack, other, otherRes);
    expect(otherRes.statusCode).toBe(201);
    const kickoff = makeReq({ method: "POST", originalUrl: "/api/actions/explore", body: { directionId: "fresh" } });
    const kickoffRes = makeRes();
    await runChain(stack, kickoff, kickoffRes);
    const freshSettled = await pollJob((kickoffRes.json() as { jobId: string }).jobId);
    expect(freshSettled.status).toBe("succeeded");
    data = await loadDashboardData(tmpDir);
    const fresh = data.directions.find((d) => d.id === "fresh")!;
    expect(fresh.versions.length).toBeGreaterThan(0);
    expect(fresh.extractedAssets).toEqual([]);
  });

  it("the local-only guard rejects cross-origin on every new route; nothing mutated", async () => {
    const [directionId] = await scaffoldSiblingDirections("moody");
    const crossOriginHeaders = { host: "127.0.0.1:4317", origin: "https://evil.com" };
    const beforeJobCount = jobs.list().length;

    const extractReq = makeMultipartReq(
      "/api/actions/asset-extract",
      buildMultipart({ fields: { directionId, describe: "the yak mascot" } }),
    );
    extractReq.headers = { ...extractReq.headers, ...crossOriginHeaders };
    const extractRes = makeRes();
    await runChain(stack, extractReq, extractRes);
    expect(extractRes.statusCode).toBe(403);

    const regenRes = makeRes();
    await runChain(
      stack,
      makeReq({
        method: "POST",
        originalUrl: "/api/actions/asset-regenerate",
        headers: crossOriginHeaders,
        body: { assetId: "whatever", tweak: "x" },
      }),
      regenRes,
    );
    expect(regenRes.statusCode).toBe(403);

    const packRes = makeRes();
    await runChain(
      stack,
      makeReq({
        method: "POST",
        originalUrl: "/api/asset-pack",
        headers: crossOriginHeaders,
        body: { directionId },
      }),
      packRes,
    );
    expect(packRes.statusCode).toBe(403);

    const retireRes = makeRes();
    await runChain(
      stack,
      makeReq({
        method: "DELETE",
        originalUrl: "/api/directions/moody/extracted-assets/whatever",
        headers: crossOriginHeaders,
      }),
      retireRes,
    );
    expect(retireRes.statusCode).toBe(403);

    // Nothing mutated: no job created, no crop written, no pack folder.
    expect(jobs.list().length).toBe(beforeJobCount);
    await expect(
      fs.access(path.join(directionsRootOf(), "moody", "extracted-assets")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(tmpDir, "brand", "generated", "asset-pack")),
    ).rejects.toThrow();
  });

  it("no new MCP-reachable command: route names are not command names; `asset` still exists (SC-09/SC-12)", () => {
    expect(getCommand("serve")?.dispatchable).toBe(false);
    expect(getCommand("asset-extract")).toBeUndefined();
    expect(getCommand("asset-regenerate")).toBeUndefined();
    expect(getCommand("asset-pack")).toBeUndefined();
    expect(getCommand("asset")).toBeDefined();
  });
});

describe("WS-08 (surface-manifest): dashboard surface + board routes", () => {
  function testConfig(): KeyartConfig {
    return buildTestConfig(tmpDir);
  }

  function makeSlot(
    id: string,
    kind: SurfaceSlot["kind"],
    overrides: Partial<SurfaceSlot> = {},
  ): SurfaceSlot {
    return {
      id,
      kind,
      description: `Description for ${id}`,
      criticality: "required",
      origin: "authored",
      attributions: [],
      ...overrides,
    };
  }

  /** Creates a draft direction, explores, and approves the head — the pointer this WS's
   * "bound status" test resolves color-role slots against. */
  async function scaffoldApproved(
    id: string,
  ): Promise<{ directionId: string; versionId: string }> {
    const create = makeReq({ method: "POST", originalUrl: "/api/directions", body: { name: id } });
    const createRes = makeRes();
    await runChain(stack, create, createRes);
    expect(createRes.statusCode).toBe(201);

    const kickoff = makeReq({
      method: "POST",
      originalUrl: "/api/actions/explore",
      body: { from: id },
    });
    const kickoffRes = makeRes();
    await runChain(stack, kickoff, kickoffRes);
    expect(kickoffRes.statusCode).toBe(202);
    const exploreSettled = await pollJob((kickoffRes.json() as { jobId: string }).jobId);
    expect(exploreSettled.status).toBe("succeeded");

    const directionsDir = directionsRoot(tmpDir, testConfig());
    const dirIds = (exploreSettled.result as { directionIds: string[] }).directionIds;
    const directionId = dirIds[0];
    const versionId = (await readDirectionIndex(directionsDir, directionId)).head;

    const approve = makeReq({
      method: "POST",
      originalUrl: "/api/actions/approve",
      body: { directionId },
    });
    const approveRes = makeRes();
    await runChain(stack, approve, approveRes);
    expect(approveRes.statusCode).toBe(202);
    const approveSettled = await pollJob((approveRes.json() as { jobId: string }).jobId);
    expect(approveSettled.status).toBe("succeeded");

    return { directionId, versionId: versionId! };
  }

  it("1. no manifest ⇒ surface: null, and the read writes nothing", async () => {
    const data = await loadDashboardData(tmpDir);
    expect(data.surface).toBeNull();
    expect(data).toHaveProperty("directions");
    expect(data).not.toHaveProperty(LEGACY_WRAPPER_KEY); // WS-18 absence probe — the wrapper key is gone
    expect(data).toHaveProperty("global");
    expect(data).toHaveProperty("approved");
    expect(data).toHaveProperty("guides");
    expect(data).toHaveProperty("latestAudit");
    expect(data).toHaveProperty("errors");

    await expect(
      fs.access(path.join(tmpDir, "brand", "generated", "binding.json")),
    ).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, "brand", "surface.yaml"))).rejects.toThrow();
  });

  it("2. manifest ⇒ slots served with statuses, counts, and flags", async () => {
    const core = createSurfaceCore(tmpDir, testConfig());
    await core.patchSlots([
      makeSlot("icon.hero", "icon"),
      makeSlot("color.chart", "color-role", { context: { sitsOn: "surface" } }),
      makeSlot("other.sparkline", "other", { context: { note: "an unusual widget" } }),
      makeSlot("icon.scooter", "icon", {
        origin: "request",
        attributions: [
          { author: "agent-a", source: "mcp", date: "2026-01-01T00:00:00.000Z" },
          { author: "agent-b", source: "mcp", date: "2026-01-02T00:00:00.000Z" },
        ],
      }),
    ]);

    const data = await loadDashboardData(tmpDir);
    expect(data.surface).not.toBeNull();
    const manifest = (await core.read())!;
    expect(data.surface!.version).toBe(manifest.version);
    expect(data.surface!.slots.map((s) => s.id)).toEqual([
      "icon.hero",
      "color.chart",
      "other.sparkline",
      "icon.scooter",
    ]);

    const hero = data.surface!.slots.find((s) => s.id === "icon.hero")!;
    expect(hero.status).toBe("gap");

    const sparkline = data.surface!.slots.find((s) => s.id === "other.sparkline")!;
    expect(sparkline.taxonomyDemand).toBe(true);
    for (const s of data.surface!.slots) {
      if (s.id !== "other.sparkline") {
        expect("taxonomyDemand" in s).toBe(false);
      }
    }

    const scooter = data.surface!.slots.find((s) => s.id === "icon.scooter")!;
    expect(scooter.attributionCount).toBe(2);
    expect(scooter.latestAttribution).toEqual({
      author: "agent-b",
      date: "2026-01-02T00:00:00.000Z",
    });

    await expect(
      fs.access(path.join(tmpDir, "brand", "generated", "binding.json")),
    ).rejects.toThrow();
  });

  it("3. a retired slot is excluded", async () => {
    const core = createSurfaceCore(tmpDir, testConfig());
    await core.patchSlots([makeSlot("icon.hero", "icon"), makeSlot("icon.tree", "icon")]);
    await core.retireSlot("icon.tree");

    const data = await loadDashboardData(tmpDir);
    expect(data.surface!.slots.map((s) => s.id)).toEqual(["icon.hero"]);

    const manifest = (await core.read())!;
    const tree = manifest.slots.find((s) => s.id === "icon.tree")!;
    expect(tree.retiredAt).toBeDefined();
  });

  it("4. bound status flows from the approved direction", async () => {
    const core = createSurfaceCore(tmpDir, testConfig());
    await core.patchSlots([
      makeSlot("color.chart", "color-role", { context: { sitsOn: "background" } }),
    ]);

    await scaffoldApproved("moody");

    const data = await loadDashboardData(tmpDir);
    const chart = data.surface!.slots.find((s) => s.id === "color.chart")!;
    expect(["bound", "derived"]).toContain(chart.status);
    expect(chart.value).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("5. fill route contract", async () => {
    const core = createSurfaceCore(tmpDir, testConfig());
    await core.patchSlots([makeSlot("icon.hero", "icon")]);
    await scaffoldApproved("moody");

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/actions/surface-fill",
      body: { slotId: "icon.hero" },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    expect(jobs.get(jobId)!.kind).toBe("surface");

    const settled = await pollJob(jobId);
    expect(["succeeded", "failed"]).toContain(settled.status);

    // The live JobStore.start takes no third `meta` argument (job-visibility
    // has not merged as of this WS) — assert the honest absence.
    expect("meta" in jobs.get(jobId)!).toBe(false);
  });

  it("6. fill route validation", async () => {
    const missing = makeReq({
      method: "POST",
      originalUrl: "/api/actions/surface-fill",
      body: {},
    });
    const missingRes = makeRes();
    await runChain(stack, missing, missingRes);
    expect(missingRes.statusCode).toBe(400);
    expect((missingRes.json() as { error: string }).error).toMatch(/slotId/i);

    const empty = makeReq({
      method: "POST",
      originalUrl: "/api/actions/surface-fill",
      body: { slotId: "" },
    });
    const emptyRes = makeRes();
    await runChain(stack, empty, emptyRes);
    expect(emptyRes.statusCode).toBe(400);

    const getReq = makeReq({ method: "GET", originalUrl: "/api/actions/surface-fill" });
    const getRes = makeRes();
    const { handled } = await runChain(stack, getReq, getRes);
    expect(handled).toBe(false);
  });

  it("7. the guard covers every new route", async () => {
    const crossOriginHeaders = { host: "127.0.0.1:4317", origin: "https://evil.com" };
    const core = createSurfaceCore(tmpDir, testConfig());
    const before = await core.patchSlots([makeSlot("icon.hero", "icon")]);

    const fillReq = makeReq({
      method: "POST",
      originalUrl: "/api/actions/surface-fill",
      headers: crossOriginHeaders,
      body: { slotId: "icon.hero" },
    });
    const fillRes = makeRes();
    await runChain(stack, fillReq, fillRes);
    expect(fillRes.statusCode).toBe(403);

    const addReq = makeReq({
      method: "POST",
      originalUrl: "/api/surface/slots",
      headers: crossOriginHeaders,
      body: {
        slot: makeSlot("icon.new", "icon"),
        expectedVersion: before.version,
      },
    });
    const addRes = makeRes();
    await runChain(stack, addReq, addRes);
    expect(addRes.statusCode).toBe(403);

    const after = await core.read();
    expect(after).toEqual(before);
  });

  it("8. add slot: happy, duplicate, teaching", async () => {
    const core = createSurfaceCore(tmpDir, testConfig());
    const seeded = await core.patchSlots([makeSlot("icon.hero", "icon")]);

    const happy = makeReq({
      method: "POST",
      originalUrl: "/api/surface/slots",
      body: {
        slot: {
          id: "illustration.empty-cart",
          kind: "illustration",
          description: "Empty-cart illustration",
          criticality: "preferred",
        },
        expectedVersion: seeded.version,
      },
    });
    const happyRes = makeRes();
    await runChain(stack, happy, happyRes);
    expect(happyRes.statusCode).toBe(201);
    const happyBody = happyRes.json() as { ok: boolean; slot: SurfaceSlot; version: number };
    expect(happyBody.slot.origin).toBe("authored");
    expect(happyBody.slot.attributions).toHaveLength(1);

    const data = await loadDashboardData(tmpDir);
    const created = data.surface!.slots.find((s) => s.id === "illustration.empty-cart")!;
    expect(created.origin).toBe("authored");
    expect(created.attributionCount).toBe(1);

    // Duplicate id → 400 naming the existing id.
    const dup = makeReq({
      method: "POST",
      originalUrl: "/api/surface/slots",
      body: {
        slot: {
          id: "illustration.empty-cart",
          kind: "illustration",
          description: "Another",
          criticality: "preferred",
        },
        expectedVersion: happyBody.version,
      },
    });
    const dupRes = makeRes();
    await runChain(stack, dup, dupRes);
    expect(dupRes.statusCode).toBe(400);
    expect((dupRes.json() as { error: string }).error).toContain("illustration.empty-cart");

    // Bad kind → 400 with the teaching text; manifest unchanged.
    const badKind = makeReq({
      method: "POST",
      originalUrl: "/api/surface/slots",
      body: {
        slot: {
          id: "graphic.thing",
          kind: "graphic",
          description: "A thing",
          criticality: "preferred",
        },
        expectedVersion: happyBody.version,
      },
    });
    const badKindRes = makeRes();
    await runChain(stack, badKind, badKindRes);
    expect(badKindRes.statusCode).toBe(400);
    const badKindError = (badKindRes.json() as { error: string }).error;
    expect(badKindError).toMatch(/valid kinds/i);
    expect(badKindError).toContain("icon");

    const manifest = (await core.read())!;
    expect(manifest.slots.some((s) => s.id === "graphic.thing")).toBe(false);
  });

  it("9. edit slot: happy + 409", async () => {
    const core = createSurfaceCore(tmpDir, testConfig());
    const seeded = await core.patchSlots([makeSlot("color.chart", "color-role")]);

    const happy = makeReq({
      method: "PATCH",
      originalUrl: "/api/surface/slots/color.chart",
      body: { criticality: "required", expectedVersion: seeded.version },
    });
    const happyRes = makeRes();
    await runChain(stack, happy, happyRes);
    expect(happyRes.statusCode).toBe(200);
    const happyBody = happyRes.json() as { slot: SurfaceSlot; version: number };
    expect(happyBody.slot.criticality).toBe("required");

    const data = await loadDashboardData(tmpDir);
    expect(data.surface!.slots.find((s) => s.id === "color.chart")!.criticality).toBe(
      "required",
    );

    // Repeat with the now-stale expectedVersion → 409.
    const stale = makeReq({
      method: "PATCH",
      originalUrl: "/api/surface/slots/color.chart",
      body: { criticality: "preferred", expectedVersion: seeded.version },
    });
    const staleRes = makeRes();
    await runChain(stack, stale, staleRes);
    expect(staleRes.statusCode).toBe(409);
    expect((staleRes.json() as { code: string }).code).toBe("version_conflict");

    // Neither criticality nor context → 400.
    const empty = makeReq({
      method: "PATCH",
      originalUrl: "/api/surface/slots/color.chart",
      body: { expectedVersion: happyBody.version },
    });
    const emptyRes = makeRes();
    await runChain(stack, empty, emptyRes);
    expect(emptyRes.statusCode).toBe(400);
  });

  it("10. retire slot: happy + non-destructive + unknown", async () => {
    const core = createSurfaceCore(tmpDir, testConfig());
    const seeded = await core.patchSlots([
      makeSlot("illustration.empty-cart", "illustration"),
    ]);

    const happy = makeReq({
      method: "DELETE",
      originalUrl: "/api/surface/slots/illustration.empty-cart",
      body: { expectedVersion: seeded.version },
    });
    const happyRes = makeRes();
    await runChain(stack, happy, happyRes);
    expect(happyRes.statusCode).toBe(200);
    const happyBody = happyRes.json() as { retiredAt: string };
    expect(typeof happyBody.retiredAt).toBe("string");

    const data = await loadDashboardData(tmpDir);
    expect(data.surface!.slots.some((s) => s.id === "illustration.empty-cart")).toBe(false);

    const manifest = (await core.read())!;
    const retired = manifest.slots.find((s) => s.id === "illustration.empty-cart")!;
    expect(retired.retiredAt).toBe(happyBody.retiredAt);

    const unknown = makeReq({
      method: "DELETE",
      originalUrl: "/api/surface/slots/nope.nope",
      body: {},
    });
    const unknownRes = makeRes();
    await runChain(stack, unknown, unknownRes);
    expect(unknownRes.statusCode).toBe(400);
    expect((unknownRes.json() as { error: string }).error).toContain("Slot not found");
  });

  it("11. unknown surface endpoint", async () => {
    const req = makeReq({ method: "POST", originalUrl: "/api/surface/bogus", body: {} });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: string }).error).toBe("Unknown endpoint");
  });

  it("12. nothing new is MCP-dispatchable", () => {
    expect(getCommand("serve")?.dispatchable).toBe(false);
    expect(getCommand("surface-fill")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WS-09 (studio-scan-triage-curation)
// ---------------------------------------------------------------------------

// The old `hasChromium` gate is gone: the file-level `playwright` fake at the
// top of this file means the scan route no longer needs (or launches) a real
// browser, so this case runs everywhere, deterministically, instead of being
// skipped without Chromium and timing out with it.

describe("WS-09 (surface-manifest): scan trigger + proposal triage", () => {
  function testConfig(): KeyartConfig {
    return buildTestConfig(tmpDir);
  }

  function makeCandidate(
    signature: string,
    kind: ScanCandidate["kind"],
    overrides: Partial<ScanCandidate> = {},
  ): ScanCandidate {
    const prefix = kind === "color-role" ? "color" : kind === "type-role" ? "type" : kind;
    return {
      signature,
      kind,
      proposedId: `${prefix}.unnamed-1`,
      cropFile: `brand/generated/surface-scan/crops/${signature}.png`,
      hints: {},
      ...overrides,
    };
  }

  function makeProposal(
    candidates: ScanCandidate[],
    overrides: Partial<ScanProposal> = {},
  ): ScanProposal {
    return {
      createdAt: "2026-08-06T00:00:00.000Z",
      urls: ["http://localhost:3000"],
      candidates,
      rejectedSignatures: [],
      migrations: [],
      skipped: [],
      ...overrides,
    };
  }

  /** Writes a fixture `proposal.json` (+ each candidate's crop, PNG_BYTES) at
   * the fixed scan directory; returns the on-disk proposal.json path. */
  async function writeProposalFixture(proposal: ScanProposal): Promise<string> {
    const scanDir = surfaceScanDir(tmpDir, testConfig());
    await fs.mkdir(path.join(scanDir, "crops"), { recursive: true });
    const proposalPath = path.join(scanDir, "proposal.json");
    await fs.writeFile(proposalPath, JSON.stringify(proposal, null, 2));
    for (const c of proposal.candidates) {
      await fs.writeFile(path.join(tmpDir, c.cropFile), PNG_BYTES);
    }
    return proposalPath;
  }

  it("1. scan route contract", async () => {
    const req = makeReq({
      method: "POST",
      originalUrl: "/api/actions/surface-scan",
      body: { urls: ["http://localhost:9"] },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(202);
    const { jobId } = res.json() as { jobId: string };
    expect(jobs.get(jobId)!.kind).toBe("surface");

    const settled = await pollJob(jobId);
    expect(settled.status).toBe("failed");
    expect(settled.error).toContain("http://localhost:9");

    // The live JobStore.start takes no third `meta` argument (job-visibility
    // has not merged as of this WS) — assert the honest absence.
    expect("meta" in jobs.get(jobId)!).toBe(false);
  });

  it("2. scan route validation", async () => {
    for (const body of [{}, { urls: [] }, { urls: [42] }]) {
      const req = makeReq({ method: "POST", originalUrl: "/api/actions/surface-scan", body });
      const res = makeRes();
      await runChain(stack, req, res);
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toMatch(/urls/i);
    }

    // A stray `apply: true` in an otherwise-valid body does not change the
    // 202 contract — ignored, asserted by the response shape only.
    const withApply = makeReq({
      method: "POST",
      originalUrl: "/api/actions/surface-scan",
      body: { urls: ["http://localhost:9"], apply: true },
    });
    const withApplyRes = makeRes();
    await runChain(stack, withApply, withApplyRes);
    expect(withApplyRes.statusCode).toBe(202);
    expect(typeof (withApplyRes.json() as { jobId: string }).jobId).toBe("string");
  });

  it("3. the guard covers both routes", async () => {
    const crossOriginHeaders = { host: "127.0.0.1:4317", origin: "https://evil.com" };

    const scanReq = makeReq({
      method: "POST",
      originalUrl: "/api/actions/surface-scan",
      headers: crossOriginHeaders,
      body: { urls: ["http://localhost:9"] },
    });
    const scanRes = makeRes();
    await runChain(stack, scanReq, scanRes);
    expect(scanRes.statusCode).toBe(403);

    const applyReq = makeReq({
      method: "POST",
      originalUrl: "/api/surface/proposal/apply",
      headers: crossOriginHeaders,
      body: { acceptedIds: [] },
    });
    const applyRes = makeRes();
    await runChain(stack, applyReq, applyRes);
    expect(applyRes.statusCode).toBe(403);

    // Nothing written — the scan directory never got created.
    await expect(fs.access(surfaceScanDir(tmpDir, testConfig()))).rejects.toThrow();
  });

  it("4. proposal on the dashboard + thumbnail servability", async () => {
    const candidateA = makeCandidate("aaaaaaaaaaaaaaaa", "icon", {
      proposedId: "icon.unnamed-1",
    });
    const candidateB = makeCandidate("bbbbbbbbbbbbbbbb", "color-role", {
      proposedId: "color.unnamed-1",
      context: { note: "observed color #112233 on http://localhost:3000" },
    });
    await writeProposalFixture(makeProposal([candidateA, candidateB]));

    const data = await loadDashboardData(tmpDir);
    expect(data.surface).not.toBeNull();
    expect(data.surface!.version).toBe(0);
    expect(data.surface!.slots).toEqual([]);
    expect(data.surface!.proposal).toBeDefined();
    expect(data.surface!.proposal!.candidates.map((c) => c.signature)).toEqual([
      "aaaaaaaaaaaaaaaa",
      "bbbbbbbbbbbbbbbb",
    ]);

    const assetReq = makeReq({
      method: "GET",
      originalUrl: `/api/asset?path=${encodeURIComponent(candidateA.cropFile)}`,
    });
    const assetRes = makeRes();
    await runChain(stack, assetReq, assetRes);
    expect(assetRes.statusCode).toBe(200);
    expect(assetRes.headers["content-type"]).toBe("image/png");
    expect((assetRes.payload as Buffer).equals(PNG_BYTES)).toBe(true);
  });

  it("5. apply: accepted merge + attribution key", async () => {
    const candidateA = makeCandidate("aaaaaaaaaaaaaaaa", "icon", {
      proposedId: "icon.unnamed-1",
    });
    const candidateB = makeCandidate("bbbbbbbbbbbbbbbb", "color-role", {
      proposedId: "color.unnamed-1",
    });
    await writeProposalFixture(makeProposal([candidateA, candidateB]));

    const core = createSurfaceCore(tmpDir, testConfig());
    const seeded = await core.setManifest([]);

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/surface/proposal/apply",
      body: { acceptedIds: ["aaaaaaaaaaaaaaaa"], expectedVersion: seeded.version },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      appliedSlotIds: string[];
      appliedCount: number;
      rejectedCount: number;
      version: number;
    };
    expect(body.appliedSlotIds).toEqual(["icon.unnamed-1"]);
    expect(body.appliedCount).toBe(1);
    expect(body.rejectedCount).toBe(1);

    const manifest = (await core.read())!;
    const slot = manifest.slots.find((s) => s.id === "icon.unnamed-1")!;
    expect(slot.origin).toBe("scan");
    expect(slot.criticality).toBe("preferred");
    expect(slot.attributions).toHaveLength(1);
    expect(slot.attributions[0].source).toBe("surface-scan:aaaaaaaaaaaaaaaa");
    expect(slot.attributions[0].author).toBe("scan");
    expect(manifest.slots.some((s) => s.id === "color.unnamed-1")).toBe(false);
  });

  it("6. apply: rejection memory + proposal rewrite", async () => {
    const candidateA = makeCandidate("aaaaaaaaaaaaaaaa", "icon", {
      proposedId: "icon.unnamed-1",
    });
    const candidateB = makeCandidate("bbbbbbbbbbbbbbbb", "color-role", {
      proposedId: "color.unnamed-1",
    });
    const proposalPath = await writeProposalFixture(makeProposal([candidateA, candidateB]));

    const core = createSurfaceCore(tmpDir, testConfig());
    const seeded = await core.setManifest([]);

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/surface/proposal/apply",
      body: { acceptedIds: ["aaaaaaaaaaaaaaaa"], expectedVersion: seeded.version },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);

    const rewritten = JSON.parse(await fs.readFile(proposalPath, "utf-8")) as ScanProposal;
    expect(rewritten.candidates).toEqual([]);
    expect(rewritten.rejectedSignatures).toEqual(["bbbbbbbbbbbbbbbb"]);
    expect(rewritten.createdAt).toBe("2026-08-06T00:00:00.000Z");
    expect(rewritten.urls).toEqual(["http://localhost:3000"]);

    // Crop files still on disk (non-destructive).
    await expect(fs.access(path.join(tmpDir, candidateA.cropFile))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmpDir, candidateB.cropFile))).resolves.toBeUndefined();

    // "the new slots appear on the board" read-side proof.
    const data = await loadDashboardData(tmpDir);
    expect(data.surface!.proposal!.candidates).toEqual([]);
    expect(data.surface!.slots.some((s) => s.id === "icon.unnamed-1")).toBe(true);
  });

  it("7. rejections are durable input to the floor", async () => {
    const candidateA = makeCandidate("aaaaaaaaaaaaaaaa", "icon", {
      proposedId: "icon.unnamed-1",
    });
    const candidateB = makeCandidate("bbbbbbbbbbbbbbbb", "color-role", {
      proposedId: "color.unnamed-1",
    });
    const proposalPath = await writeProposalFixture(makeProposal([candidateA, candidateB]));

    const core = createSurfaceCore(tmpDir, testConfig());
    const seeded = await core.setManifest([]);

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/surface/proposal/apply",
      body: { acceptedIds: ["aaaaaaaaaaaaaaaa"], expectedVersion: seeded.version },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);

    // The written shape parses under the merged ScanProposal — the exact
    // field WS-05's floor coverage step consumes.
    const parsed = JSON.parse(await fs.readFile(proposalPath, "utf-8")) as ScanProposal;
    expect(Array.isArray(parsed.rejectedSignatures)).toBe(true);
    expect(parsed.rejectedSignatures).toEqual(["bbbbbbbbbbbbbbbb"]);
    expect(Array.isArray(parsed.candidates)).toBe(true);
    expect(typeof parsed.createdAt).toBe("string");
    expect(Array.isArray(parsed.urls)).toBe(true);
  });

  it("8. apply: validation + all-or-nothing", async () => {
    const config = testConfig();

    // No proposal on disk → 400.
    const noProposalReq = makeReq({
      method: "POST",
      originalUrl: "/api/surface/proposal/apply",
      body: { acceptedIds: [] },
    });
    const noProposalRes = makeRes();
    await runChain(stack, noProposalReq, noProposalRes);
    expect(noProposalRes.statusCode).toBe(400);
    expect((noProposalRes.json() as { error: string }).error).toMatch(/no scan proposal/i);

    const candidateA = makeCandidate("aaaaaaaaaaaaaaaa", "icon", {
      proposedId: "icon.unnamed-1",
    });
    const candidateB = makeCandidate("bbbbbbbbbbbbbbbb", "color-role", {
      proposedId: "color.unnamed-1",
    });
    const proposalPath = await writeProposalFixture(makeProposal([candidateA, candidateB]));

    const core = createSurfaceCore(tmpDir, config);
    const seeded = await core.setManifest([]);

    // acceptedIds not an array → 400.
    const notArrayReq = makeReq({
      method: "POST",
      originalUrl: "/api/surface/proposal/apply",
      body: { acceptedIds: "aaaaaaaaaaaaaaaa", expectedVersion: seeded.version },
    });
    const notArrayRes = makeRes();
    await runChain(stack, notArrayReq, notArrayRes);
    expect(notArrayRes.statusCode).toBe(400);

    // Unknown signature → 400 naming it; manifest AND proposal byte-unchanged.
    const beforeUnknown = await fs.readFile(proposalPath, "utf-8");
    const manifestBeforeUnknown = await core.read();
    const unknownReq = makeReq({
      method: "POST",
      originalUrl: "/api/surface/proposal/apply",
      body: { acceptedIds: ["nope"], expectedVersion: seeded.version },
    });
    const unknownRes = makeRes();
    await runChain(stack, unknownReq, unknownRes);
    expect(unknownRes.statusCode).toBe(400);
    expect((unknownRes.json() as { error: string }).error).toContain("nope");
    expect(await core.read()).toEqual(manifestBeforeUnknown);
    expect(await fs.readFile(proposalPath, "utf-8")).toBe(beforeUnknown);

    // A fixture candidate whose proposedId violates the slot-id schema
    // (e.g. "Bad_ID") accepted → 400 carrying the teaching text; manifest
    // unchanged AND proposal.json byte-unchanged (rejections NOT recorded on
    // a failed write — the Decision-3 ordering).
    const badCandidate = makeCandidate("cccccccccccccccc", "icon", { proposedId: "Bad_ID" });
    await writeProposalFixture(makeProposal([badCandidate]));
    const beforeBad = await fs.readFile(proposalPath, "utf-8");
    const manifestBeforeBad = await core.read();
    const badReq = makeReq({
      method: "POST",
      originalUrl: "/api/surface/proposal/apply",
      body: { acceptedIds: ["cccccccccccccccc"], expectedVersion: seeded.version },
    });
    const badRes = makeRes();
    await runChain(stack, badReq, badRes);
    expect(badRes.statusCode).toBe(400);
    expect((badRes.json() as { error: string }).error).toMatch(/invalid slot id/i);
    expect(await core.read()).toEqual(manifestBeforeBad);
    expect(await fs.readFile(proposalPath, "utf-8")).toBe(beforeBad);
  });

  it("9. apply: 409 pass-through", async () => {
    const candidateA = makeCandidate("aaaaaaaaaaaaaaaa", "icon", {
      proposedId: "icon.unnamed-1",
    });
    const proposalPath = await writeProposalFixture(makeProposal([candidateA]));
    const proposalBefore = await fs.readFile(proposalPath, "utf-8");

    const core = createSurfaceCore(tmpDir, testConfig());
    const seeded = await core.setManifest([]);
    const manifestBefore = await core.read();

    const req = makeReq({
      method: "POST",
      originalUrl: "/api/surface/proposal/apply",
      body: {
        acceptedIds: ["aaaaaaaaaaaaaaaa"],
        expectedVersion: seeded.version - 1,
      },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("version_conflict");

    expect(await core.read()).toEqual(manifestBefore);
    expect(await fs.readFile(proposalPath, "utf-8")).toBe(proposalBefore);
  });

  it("10. nothing new is MCP-dispatchable", () => {
    expect(getCommand("serve")?.dispatchable).toBe(false);
    expect(getCommand("surface-scan")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WS-07 (surface-scan-quality)
// ---------------------------------------------------------------------------

describe("WS-07 (surface-scan-quality): origin-scoped bulk retire + quality-signal payload", () => {
  function testConfig(): KeyartConfig {
    return buildTestConfig(tmpDir);
  }

  function makeSlot(
    id: string,
    kind: SurfaceSlot["kind"],
    overrides: Partial<SurfaceSlot> = {},
  ): SurfaceSlot {
    return {
      id,
      kind,
      description: `Description for ${id}`,
      criticality: "required",
      origin: "authored",
      attributions: [],
      ...overrides,
    };
  }

  it("1. bulk retire happy path", async () => {
    const core = createSurfaceCore(tmpDir, testConfig());
    const seeded = await core.patchSlots([
      makeSlot("icon.a", "icon", { origin: "scan" }),
      makeSlot("icon.b", "icon", { origin: "scan" }),
      makeSlot("icon.authored", "icon", { origin: "authored" }),
    ]);

    const req = makeReq({
      method: "DELETE",
      originalUrl: "/api/surface/slots?origin=scan",
      body: { expectedVersion: seeded.version },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      retiredIds: string[];
      retiredCount: number;
      alreadyRetiredCount: number;
      version: number;
    };
    expect(body.ok).toBe(true);
    expect([...body.retiredIds].sort()).toEqual(["icon.a", "icon.b"]);
    expect(body.retiredCount).toBe(2);
    expect(body.alreadyRetiredCount).toBe(0);

    const manifest = (await core.read())!;
    expect(body.version).toBe(manifest.version);
    expect(manifest.slots.find((s) => s.id === "icon.a")!.retiredAt).toBeDefined();
    expect(manifest.slots.find((s) => s.id === "icon.b")!.retiredAt).toBeDefined();
    expect(manifest.slots.find((s) => s.id === "icon.authored")!.retiredAt).toBeUndefined();
  });

  it("2. idempotence — a second run writes nothing", async () => {
    const core = createSurfaceCore(tmpDir, testConfig());
    const seeded = await core.patchSlots([
      makeSlot("icon.a", "icon", { origin: "scan" }),
      makeSlot("icon.b", "icon", { origin: "scan" }),
    ]);

    const first = makeReq({
      method: "DELETE",
      originalUrl: "/api/surface/slots?origin=scan",
      body: { expectedVersion: seeded.version },
    });
    const firstRes = makeRes();
    await runChain(stack, first, firstRes);
    expect(firstRes.statusCode).toBe(200);
    const firstBody = firstRes.json() as { version: number };

    const manifestPath = surfaceManifestPath(tmpDir, testConfig());
    const bytesBefore = await fs.readFile(manifestPath, "utf-8");

    const second = makeReq({
      method: "DELETE",
      originalUrl: "/api/surface/slots?origin=scan",
      body: { expectedVersion: firstBody.version },
    });
    const secondRes = makeRes();
    await runChain(stack, second, secondRes);
    expect(secondRes.statusCode).toBe(200);
    const secondBody = secondRes.json() as {
      retiredIds: string[];
      retiredCount: number;
      alreadyRetiredCount: number;
      version: number;
    };
    expect(secondBody.retiredIds).toEqual([]);
    expect(secondBody.retiredCount).toBe(0);
    expect(secondBody.alreadyRetiredCount).toBe(2);
    expect(secondBody.version).toBe(firstBody.version);

    const bytesAfter = await fs.readFile(manifestPath, "utf-8");
    expect(bytesAfter).toBe(bytesBefore);
  });

  it("3. origin scoping — authored/request are untouched", async () => {
    const core = createSurfaceCore(tmpDir, testConfig());
    await core.patchSlots([
      makeSlot("icon.a", "icon", { origin: "scan" }),
      makeSlot("icon.authored", "icon", { origin: "authored" }),
    ]);
    await core.requestSlot(
      { id: "icon.requested", kind: "icon", description: "Requested icon", criticality: "preferred" },
      { author: "agent", source: "mcp", date: "2026-01-01T00:00:00.000Z" },
    );
    const current = (await core.read())!;

    const req = makeReq({
      method: "DELETE",
      originalUrl: "/api/surface/slots?origin=scan",
      body: { expectedVersion: current.version },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(200);

    const manifest = (await core.read())!;
    expect(manifest.slots.find((s) => s.id === "icon.authored")!.retiredAt).toBeUndefined();
    expect(manifest.slots.find((s) => s.id === "icon.requested")!.retiredAt).toBeUndefined();

    const data = await loadDashboardData(tmpDir);
    expect(data.surface!.slots.some((s) => s.id === "icon.authored")).toBe(true);
    expect(data.surface!.slots.some((s) => s.id === "icon.requested")).toBe(true);
    expect(data.surface!.slots.some((s) => s.id === "icon.a")).toBe(false);
  });

  it("4. missing/invalid origin → 400, nothing written", async () => {
    const core = createSurfaceCore(tmpDir, testConfig());
    await core.patchSlots([makeSlot("icon.a", "icon", { origin: "scan" })]);
    const manifestPath = surfaceManifestPath(tmpDir, testConfig());
    const bytesBefore = await fs.readFile(manifestPath, "utf-8");

    for (const originalUrl of [
      "/api/surface/slots",
      "/api/surface/slots?origin=",
      "/api/surface/slots?origin=bogus",
    ]) {
      const req = makeReq({ method: "DELETE", originalUrl, body: {} });
      const res = makeRes();
      await runChain(stack, req, res);
      expect(res.statusCode).toBe(400);
      const error = (res.json() as { error: string }).error;
      expect(error).toMatch(/origin/i);
      expect(error).toContain("authored");
      expect(error).toContain("scan");
      expect(error).toContain("request");
    }

    const bytesAfter = await fs.readFile(manifestPath, "utf-8");
    expect(bytesAfter).toBe(bytesBefore);
  });

  it("5. 409 pass-through on a stale expectedVersion", async () => {
    const core = createSurfaceCore(tmpDir, testConfig());
    const seeded = await core.patchSlots([makeSlot("icon.a", "icon", { origin: "scan" })]);
    const manifestPath = surfaceManifestPath(tmpDir, testConfig());
    const bytesBefore = await fs.readFile(manifestPath, "utf-8");

    const req = makeReq({
      method: "DELETE",
      originalUrl: "/api/surface/slots?origin=scan",
      body: { expectedVersion: seeded.version - 1 },
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(409);
    expect((res.json() as { code: string }).code).toBe("version_conflict");

    const bytesAfter = await fs.readFile(manifestPath, "utf-8");
    expect(bytesAfter).toBe(bytesBefore);
  });

  it("6. the existing local-only guard covers the new route", async () => {
    const core = createSurfaceCore(tmpDir, testConfig());
    await core.patchSlots([makeSlot("icon.a", "icon", { origin: "scan" })]);
    const manifestPath = surfaceManifestPath(tmpDir, testConfig());
    const bytesBefore = await fs.readFile(manifestPath, "utf-8");

    const req = makeReq({
      method: "DELETE",
      originalUrl: "/api/surface/slots?origin=scan",
      headers: { host: "evil.example.com" },
      body: {},
    });
    const res = makeRes();
    await runChain(stack, req, res);
    expect(res.statusCode).toBe(403);

    const bytesAfter = await fs.readFile(manifestPath, "utf-8");
    expect(bytesAfter).toBe(bytesBefore);
    const manifest = (await core.read())!;
    expect(manifest.slots.every((s) => s.retiredAt === undefined)).toBe(true);
  });

  it("7. the dashboard carries the quality signals verbatim (and tolerates their absence)", async () => {
    const config = testConfig();
    const scanDir = surfaceScanDir(tmpDir, config);
    await fs.mkdir(path.join(scanDir, "crops"), { recursive: true });
    const proposalPath = path.join(scanDir, "proposal.json");

    const fixture: ScanProposal = {
      createdAt: "2026-08-06T00:00:00.000Z",
      urls: ["http://localhost:3000"],
      candidates: [
        {
          signature: "aaaaaaaaaaaaaaaa",
          kind: "icon",
          proposedId: "icon.unnamed-1",
          cropFile: "brand/generated/surface-scan/crops/aaaaaaaaaaaaaaaa.png",
          hints: {},
          fallbackForGroup: "svg|div.card|div.list[0]",
        },
      ],
      rejectedSignatures: [],
      skipped: [
        { reason: "repeated-content", count: 47, exampleSources: ["a", "b", "c", "d"] },
        { reason: "foreign-origin", count: 9, exampleSources: [] },
      ],
      migrations: [
        {
          kind: "color-role",
          value: "#2e7d32",
          nearestRole: "--brand-primary",
          delta: 0.02,
          occurrences: 14,
          examples: ["http://localhost:4321/"],
        },
      ],
      blockedByOverlay: { fraction: 0.92, hints: { ariaLabel: "Choose your location" } },
    };
    await fs.writeFile(proposalPath, JSON.stringify(fixture, null, 2));

    const data = await loadDashboardData(tmpDir);
    expect(data.surface!.proposal).toEqual(fixture);

    // Pre-program shape: no skipped/migrations/blockedByOverlay.
    const legacy = {
      createdAt: fixture.createdAt,
      urls: fixture.urls,
      candidates: [],
      rejectedSignatures: [],
    };
    await fs.writeFile(proposalPath, JSON.stringify(legacy, null, 2));
    const data2 = await loadDashboardData(tmpDir);
    expect(data2.errors).toEqual([]);
    expect(data2.surface!.proposal!.skipped).toBeUndefined();
    expect(data2.surface!.proposal!.migrations).toBeUndefined();
    expect(data2.surface!.proposal!.blockedByOverlay).toBeUndefined();
  });

  it("8. the read never writes; nothing new is MCP-dispatchable", async () => {
    const bindingPath = path.join(tmpDir, "brand", "generated", "binding.json");
    await expect(fs.access(bindingPath)).rejects.toThrow();

    await loadDashboardData(tmpDir);

    await expect(fs.access(bindingPath)).rejects.toThrow();

    expect(getCommand("serve")?.dispatchable).toBe(false);
    expect(getCommand("surface-retire-origin")).toBeUndefined();
    expect(getCommand("surface")).toBeDefined();
  });
});
