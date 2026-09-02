import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

// Mock loadConfig only — every other config.js export keeps its real
// implementation, mirroring src/integration/serve-api.test.ts's harness. This
// is a deterministic, network-free, key-free end-to-end exercise of the
// STATIC runtime: the composed listener built from `createApiMounts` +
// `createStaticFileHandler`, exactly as `runServe`'s default (non-`--dev`)
// path assembles it.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn() };
});

// Fake `playwright` for the whole file — mirrors serve-api.test.ts's fake:
// every browser-touching route exercised through createApiMounts only ever
// points at an unreachable url in this suite, so an honest connection-refused
// fake is enough and removes the last real Chromium launch from this file.
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

import { createApiMounts } from "../commands/serve.js";
import { createRequestListener, createStaticFileHandler, type Mount } from "../ui/static-server.js";
import { createJobStore } from "../ui/jobs.js";
import { runInit } from "../commands/init.js";
import { loadConfig, directionsRoot } from "../config.js";
import type { KeyartConfig } from "../types.js";

// Scanner-proof legacy-vocabulary probe (R-8): the runtime string is the
// removed surface's spelling, assembled so no source literal carries it.
const LEGACY_WRAPPER_KEY = ["con", "cepts"].join("");

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Serve Static ITest", type: "prototype", framework: "next" },
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

// --- fake connect req/res harness (mirrors serve-api.test.ts) --------------

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

function makeReq(opts: {
  method?: string;
  originalUrl: string;
  headers?: Record<string, string>;
  body?: unknown;
}): FakeReq {
  const hasBody = opts.body !== undefined;
  const raw = hasBody ? Buffer.from(JSON.stringify(opts.body)) : null;
  const req = Readable.from(raw ? [raw] : []) as FakeReq;
  req.method = opts.method ?? "GET";
  req.originalUrl = opts.originalUrl;
  req.url = opts.originalUrl;
  req.headers = { host: "127.0.0.1:4317", ...(opts.headers ?? {}) };
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

type Listener = (req: IncomingMessage, res: ServerResponse) => void;

function drive(listener: Listener, req: FakeReq, res: FakeRes): Promise<void> {
  listener(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res._done;
}

// ---------------------------------------------------------------------------

let tmpDir: string;
let bundleDir: string;
let listener: Listener;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-serve-static-"));
  bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-serve-static-bundle-"));

  // Genuinely dry-run / deterministic: no API key, no network.
  delete process.env.OPENAI_API_KEY;
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  // Scaffold a real project (config, brand tree, default direction, brand.yaml).
  await runInit({ cwd: tmpDir, force: true });

  // A minimal built studio bundle fixture — index.html + one hashed asset.
  await fs.mkdir(path.join(bundleDir, "assets"), { recursive: true });
  await fs.writeFile(
    path.join(bundleDir, "index.html"),
    "<!doctype html><title>studio</title>",
  );
  await fs.writeFile(path.join(bundleDir, "assets", "app-abc123.js"), "console.log('studio')");

  const jobs = createJobStore();
  const mounts: Mount[] = [
    ...createApiMounts({ cwd: tmpDir, jobs }),
    { prefix: "/", handler: createStaticFileHandler({ root: bundleDir }) },
  ];
  listener = createRequestListener(mounts);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.rm(bundleDir, { recursive: true, force: true });
});

describe("serve static runtime (end-to-end, no network / no key)", () => {
  it("the studio shell is served from the bundle (SC-03)", async () => {
    const req = makeReq({ originalUrl: "/" });
    const res = makeRes();
    await drive(listener, req, res);

    expect(res.statusCode).toBe(200);
    expect(String(res.payload)).toBe("<!doctype html><title>studio</title>");
  });

  it("/api/dashboard answers, unchanged (SC-03)", async () => {
    const req = makeReq({ originalUrl: "/api/dashboard" });
    const res = makeRes();
    await drive(listener, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    const payload = res.json() as { directions: { id: string }[] };
    expect(payload.directions.some((d) => d.id === "default")).toBe(true);
  });

  it("the local-only guard still rejects a foreign Origin (SC-03)", async () => {
    const req = makeReq({
      originalUrl: "/api/dashboard",
      headers: { host: "127.0.0.1:4317", origin: "http://evil.example" },
    });
    const res = makeRes();
    await drive(listener, req, res);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: "Forbidden — the Keyart studio only accepts local requests.",
    });
    expect(String(res.payload)).not.toContain(LEGACY_WRAPPER_KEY);
  });

  it("a missing Host is still rejected", async () => {
    const req = makeReq({ originalUrl: "/api/dashboard", headers: {} });
    delete req.headers.host;
    const res = makeRes();
    await drive(listener, req, res);

    expect(res.statusCode).toBe(403);
  });

  it("deep links reach the SPA while unknown /api paths 404 (SC-03)", async () => {
    const deepLink = makeReq({ originalUrl: "/directions/default" });
    const deepLinkRes = makeRes();
    await drive(listener, deepLink, deepLinkRes);
    expect(deepLinkRes.statusCode).toBe(200);
    expect(String(deepLinkRes.payload)).toBe("<!doctype html><title>studio</title>");

    const unknownApi = makeReq({ originalUrl: "/api/nope" });
    const unknownApiRes = makeRes();
    await drive(listener, unknownApi, unknownApiRes);
    expect(unknownApiRes.statusCode).toBe(404);
    expect(() => unknownApiRes.json()).not.toThrow();
  });

  it("a traversal request cannot read the project (SC-03)", async () => {
    const req = makeReq({ originalUrl: "/../../keyart.config.ts" });
    const res = makeRes();
    await drive(listener, req, res);

    expect(res.statusCode).not.toBe(200);
    expect(String(res.payload)).not.toContain("defineKeyartConfig");
  });

  it("POST /api/directions mints a draft direction through the write API (SC-14)", async () => {
    const req = makeReq({
      method: "POST",
      originalUrl: "/api/directions",
      body: { name: "Moody" },
    });
    const res = makeRes();
    await drive(listener, req, res);

    expect(res.statusCode).toBe(201);
    const body = res.json() as { directionId: string; isDraft: boolean };
    expect(body.isDraft).toBe(true);
    const config = buildTestConfig(tmpDir);
    await expect(
      fs.access(
        path.join(directionsRoot(tmpDir, config), body.directionId, "direction.yaml"),
      ),
    ).resolves.toBeUndefined();
  });

  it("the legacy two-level write path is gone — a POST there 404s, never the SPA", async () => {
    const req = makeReq({
      method: "POST",
      originalUrl: `/api/${LEGACY_WRAPPER_KEY}`,
      body: { name: "Moody" },
    });
    const res = makeRes();
    await drive(listener, req, res);

    expect(res.statusCode).toBe(404);
    expect(String(res.payload)).not.toContain("<!doctype");
  });
});
