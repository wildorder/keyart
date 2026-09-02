import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CommandError } from "../errors.js";
import type { ConnectHandler } from "./server-api.js";
import {
  createRequestListener,
  createStaticFileHandler,
  matchesPrefix,
  staticContentTypeFor,
  bundleRoot,
  assertBundlePresent,
  STUDIO_BUNDLE_MISSING_MESSAGE,
  type Mount,
} from "./static-server.js";

// --- fake connect req/res harness (mirrors src/integration/serve-api.test.ts) ---

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

interface FakeReq {
  method: string;
  url: string;
  originalUrl: string;
  headers: Record<string, string>;
}

function makeReq(opts: { method?: string; url: string; originalUrl?: string }): FakeReq {
  return {
    method: opts.method ?? "GET",
    url: opts.url,
    originalUrl: opts.originalUrl ?? opts.url,
    headers: { host: "127.0.0.1:4317" },
  };
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

/** Drives one request through a composed listener and waits for the response to end. */
function drive(listener: Listener, req: FakeReq, res: FakeRes): Promise<void> {
  listener(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res._done;
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

describe("createRequestListener", () => {
  it("mounts run in order and next() advances (SC-03)", async () => {
    const order: string[] = [];
    const handler = (name: string): ConnectHandler => (_req, _res, next) => {
      order.push(name);
      next();
    };
    const mounts: Mount[] = [
      { prefix: "/", handler: handler("a") },
      { prefix: "/", handler: handler("b") },
      { prefix: "/", handler: handler("c") },
    ];
    const listener = createRequestListener(mounts);
    const req = makeReq({ url: "/anything" });
    const res = makeRes();
    await drive(listener, req, res);

    expect(order).toEqual(["a", "b", "c"]);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringContaining("/anything") });
  });

  it("a handler that responds stops the chain", async () => {
    const order: string[] = [];
    const mounts: Mount[] = [
      {
        prefix: "/",
        handler: (_req, _res, next) => {
          order.push("a");
          next();
        },
      },
      {
        prefix: "/",
        handler: (_req, res) => {
          order.push("b");
          res.statusCode = 200;
          res.end("ok");
        },
      },
      {
        prefix: "/",
        handler: (_req, _res, next) => {
          order.push("c");
          next();
        },
      },
    ];
    const listener = createRequestListener(mounts);
    const req = makeReq({ url: "/x" });
    const res = makeRes();
    await drive(listener, req, res);

    expect(order).toEqual(["a", "b"]);
    expect(res.statusCode).toBe(200);
  });

  it("prefix matching is segment-aware — the mount-order guarantee (SC-03)", async () => {
    let assetCalls = 0;
    let dashboardCalls = 0;
    let apiCalls = 0;
    const mounts: Mount[] = [
      {
        prefix: "/api",
        handler: (_req, _res, next) => {
          apiCalls++;
          next();
        },
      },
      {
        prefix: "/api/asset",
        handler: (_req, _res, next) => {
          assetCalls++;
          next();
        },
      },
      {
        prefix: "/api/dashboard",
        handler: (_req, res) => {
          dashboardCalls++;
          res.statusCode = 200;
          res.end("{}");
        },
      },
    ];
    const listener = createRequestListener(mounts);

    await drive(listener, makeReq({ url: "/api/dashboard" }), makeRes());
    expect(assetCalls).toBe(0);
    expect(dashboardCalls).toBe(1);
    expect(apiCalls).toBe(1);

    apiCalls = 0;
    await drive(listener, makeReq({ url: "/apix" }), makeRes());
    expect(apiCalls).toBe(0);
  });

  it("next(err) becomes a 500 JSON, and a synchronous throw does too", async () => {
    const mounts: Mount[] = [
      {
        prefix: "/",
        handler: (_req, _res, next) => {
          next(new Error("boom via next"));
        },
      },
    ];
    const listener = createRequestListener(mounts);
    const req = makeReq({ url: "/x" });
    const res = makeRes();
    await drive(listener, req, res);
    expect(res.statusCode).toBe(500);
    expect((res.json() as { error: string }).error).toBe("boom via next");

    const throwingMounts: Mount[] = [
      {
        prefix: "/",
        handler: () => {
          throw new Error("boom via throw");
        },
      },
    ];
    const throwingListener = createRequestListener(throwingMounts);
    const req2 = makeReq({ url: "/y" });
    const res2 = makeRes();
    await drive(throwingListener, req2, res2);
    expect(res2.statusCode).toBe(500);
    expect((res2.json() as { error: string }).error).toBe("boom via throw");
  });

  it("req.url is not rewritten", async () => {
    let observedUrl: string | undefined;
    let observedFullPath: string | undefined;
    const mounts: Mount[] = [
      {
        prefix: "/api/chat",
        handler: (req, res) => {
          observedUrl = req.url;
          observedFullPath = new URL(
            (req as { originalUrl?: string }).originalUrl ?? req.url ?? "/",
            "http://localhost",
          ).pathname;
          res.statusCode = 200;
          res.end("ok");
        },
      },
    ];
    const listener = createRequestListener(mounts);
    const req = makeReq({ url: "/api/chat/abc/approve?x=1" });
    const res = makeRes();
    await drive(listener, req, res);

    expect(observedUrl).toBe("/api/chat/abc/approve?x=1");
    expect(observedFullPath).toBe("/api/chat/abc/approve");
  });
});

describe("matchesPrefix", () => {
  it("matches at a segment boundary only", () => {
    expect(matchesPrefix("/api", "/api")).toBe(true);
    expect(matchesPrefix("/api/x", "/api")).toBe(true);
    expect(matchesPrefix("/apix", "/api")).toBe(false);
    expect(matchesPrefix("/anything", "/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The static file handler
// ---------------------------------------------------------------------------

describe("createStaticFileHandler", () => {
  let workDir: string;
  let root: string;
  let secretPath: string;
  const secretContents = "top-secret-contents";

  beforeEach(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-static-"));
    root = path.join(workDir, "root");
    await fs.mkdir(path.join(root, "assets"), { recursive: true });
    await fs.writeFile(path.join(root, "index.html"), "<!doctype html><title>studio</title>");
    await fs.writeFile(path.join(root, "assets", "app-abc123.js"), "console.log('js')");
    await fs.writeFile(path.join(root, "assets", "app-abc123.css"), "body{}");
    secretPath = path.join(workDir, "secret.txt");
    await fs.writeFile(secretPath, secretContents);
  });

  afterEach(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  function listener(): Listener {
    const mounts: Mount[] = [{ prefix: "/", handler: createStaticFileHandler({ root }) }];
    return createRequestListener(mounts);
  }

  it("serves index.html at / with the right type (SC-03)", async () => {
    const req = makeReq({ url: "/" });
    const res = makeRes();
    await drive(listener(), req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(String(res.payload)).toContain("studio");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("serves a hashed asset with the right type and immutable caching (SC-03)", async () => {
    const req = makeReq({ url: "/assets/app-abc123.js" });
    const res = makeRes();
    await drive(listener(), req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  it("deep-link SPA fallback (SC-03)", async () => {
    const req = makeReq({ url: "/directions/dir-1" });
    const res = makeRes();
    await drive(listener(), req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(String(res.payload)).toBe("<!doctype html><title>studio</title>");
  });

  it("/api/* never falls back to the SPA (SC-03)", async () => {
    let nexted = false;
    const mounts: Mount[] = [
      {
        prefix: "/",
        handler: createStaticFileHandler({ root }),
      },
    ];
    // Wrap so we can observe whether the static handler called next().
    const handler = mounts[0].handler;
    mounts[0].handler = (req, res, next) => {
      handler(req, res, (err?: unknown) => {
        nexted = true;
        next(err);
      });
    };
    const l = createRequestListener(mounts);
    const req = makeReq({ url: "/api/does-not-exist" });
    const res = makeRes();
    await drive(l, req, res);

    expect(nexted).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(String(res.payload)).not.toContain("<!doctype");
  });

  it("traversal is refused (SC-03)", async () => {
    const req = makeReq({ url: "/../secret.txt" });
    const res = makeRes();
    await drive(listener(), req, res);

    expect(res.statusCode).toBe(403);
    expect(String(res.payload)).not.toContain(secretContents);
  });

  it("encoded traversal is refused (SC-03)", async () => {
    for (const url of ["/%2e%2e%2fsecret.txt", "/..%2fsecret.txt"]) {
      const req = makeReq({ url });
      const res = makeRes();
      await drive(listener(), req, res);
      expect(res.statusCode).toBe(403);
      expect(String(res.payload)).not.toContain(secretContents);
    }
  });

  it("an absolute path cannot escape (SC-03)", async () => {
    const urls = ["//etc/passwd", "/C:/Windows/win.ini"];
    for (const url of urls) {
      const req = makeReq({ url });
      const res = makeRes();
      await drive(listener(), req, res);
      expect([403, 404]).toContain(res.statusCode);
      expect(String(res.payload)).not.toContain(secretContents);
    }
  });

  it("a symlink out of the bundle is refused — the case resolveUnderCwd alone misses (SC-03)", async () => {
    const linkPath = path.join(root, "escape.txt");
    try {
      await fs.symlink(secretPath, linkPath, "file");
    } catch (err) {
      console.warn(
        `Skipping symlink-escape test: symlink creation unavailable in this environment (${String(err)}).`,
      );
      return;
    }

    const req = makeReq({ url: "/escape.txt" });
    const res = makeRes();
    await drive(listener(), req, res);

    expect(res.statusCode).toBe(403);
    expect(String(res.payload)).not.toContain(secretContents);
  });

  it("non-GET falls through; a malformed escape is a 400", async () => {
    let nexted = false;
    const mounts: Mount[] = [{ prefix: "/", handler: createStaticFileHandler({ root }) }];
    const handler = mounts[0].handler;
    mounts[0].handler = (req, res, next) => {
      handler(req, res, (err?: unknown) => {
        nexted = true;
        next(err);
      });
    };
    const l = createRequestListener(mounts);

    const postReq = makeReq({ method: "POST", url: "/" });
    const postRes = makeRes();
    await drive(l, postReq, postRes);
    expect(nexted).toBe(true);

    const badReq = makeReq({ url: "/%E0%A4%A" });
    const badRes = makeRes();
    await drive(listener(), badReq, badRes);
    expect(badRes.statusCode).toBe(400);
  });
});

describe("staticContentTypeFor", () => {
  it("maps known extensions and defaults to a binary blob", () => {
    expect(staticContentTypeFor(".js")).toBe("text/javascript; charset=utf-8");
    expect(staticContentTypeFor(".HTML")).toBe("text/html; charset=utf-8");
    expect(staticContentTypeFor(".unknown")).toBe("application/octet-stream");
  });
});

// ---------------------------------------------------------------------------
// Bundle presence check
// ---------------------------------------------------------------------------

describe("assertBundlePresent", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-bundle-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("resolves when index.html exists", async () => {
    await fs.writeFile(path.join(dir, "index.html"), "<!doctype html>");
    await expect(assertBundlePresent(dir)).resolves.toBeUndefined();
  });

  it("teaches npm run build when the bundle is missing", async () => {
    await expect(assertBundlePresent(dir)).rejects.toBeInstanceOf(CommandError);
    try {
      await assertBundlePresent(dir);
      expect.unreachable();
    } catch (err) {
      const commandError = err as CommandError;
      expect(commandError.message).toBe(STUDIO_BUNDLE_MISSING_MESSAGE);
      expect(commandError.message).toContain("npm run build");
      expect(commandError.message).not.toContain("ENOENT");
    }
  });
});

describe("bundleRoot", () => {
  it("resolves dist/ui from a dist/commands module dir", () => {
    const moduleDir = path.resolve("/repo/dist/commands");
    expect(bundleRoot(moduleDir)).toBe(path.resolve("/repo/dist/ui"));
  });
});
