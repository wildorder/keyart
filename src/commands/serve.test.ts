import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadViteDeps,
  VITE_MISSING_MESSAGE,
  resolveDevUiRoot,
  DEV_UI_MISSING_MESSAGE,
  createApiMounts,
} from "./serve.js";
import { assertBundlePresent, STUDIO_BUNDLE_MISSING_MESSAGE } from "../ui/static-server.js";
import { createJobStore } from "../ui/jobs.js";
import { CommandError } from "../errors.js";

const serveSourcePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "serve.ts",
);

describe("loadViteDeps", () => {
  it("resolves both modules and returns them", async () => {
    const sentinelA = {};
    const sentinelB = {};
    const importer = vi.fn(async (specifier: string) => {
      if (specifier === "vite") return { createServer: sentinelA };
      if (specifier === "@vitejs/plugin-react") return { default: sentinelB };
      throw new Error(`unexpected specifier: ${specifier}`);
    });

    const deps = await loadViteDeps(importer);

    expect(deps.createServer).toBe(sentinelA);
    expect(deps.react).toBe(sentinelB);
    expect(importer.mock.calls).toEqual([["vite"], ["@vitejs/plugin-react"]]);
  });

  it("an unresolvable vite becomes a teaching CommandError", async () => {
    const importer = vi.fn(async (specifier: string) => {
      if (specifier === "vite") throw new Error("ERR_MODULE_NOT_FOUND");
      return { default: {} };
    });

    await expect(loadViteDeps(importer)).rejects.toBeInstanceOf(CommandError);
    try {
      await loadViteDeps(importer);
      expect.unreachable();
    } catch (err) {
      const commandError = err as CommandError;
      expect(commandError.message).toBe(VITE_MISSING_MESSAGE);
      expect(commandError.exitCode).toBe(1);
      expect(commandError.message).not.toContain("ERR_MODULE_NOT_FOUND");
      expect(commandError.message).not.toContain("node_modules");
    }
  });

  it("an unresolvable plugin fails the same way", async () => {
    const importer = vi.fn(async (specifier: string) => {
      if (specifier === "vite") return { createServer: () => {} };
      if (specifier === "@vitejs/plugin-react") {
        throw new Error("ERR_MODULE_NOT_FOUND");
      }
      throw new Error(`unexpected specifier: ${specifier}`);
    });

    try {
      await loadViteDeps(importer);
      expect.unreachable();
    } catch (err) {
      const commandError = err as CommandError;
      expect(commandError).toBeInstanceOf(CommandError);
      expect(commandError.message).toBe(VITE_MISSING_MESSAGE);
    }
  });

  it("the message teaches the fix", () => {
    expect(VITE_MISSING_MESSAGE).toContain("npm install");
    expect(VITE_MISSING_MESSAGE).toContain("git clone");
    expect(VITE_MISSING_MESSAGE).not.toContain("<repo-url>");
  });

  it("the default importer really is dynamic (regression)", () => {
    const source = fs.readFileSync(serveSourcePath, "utf-8");
    expect(source.match(/^import .*from ["']vite["']/m)).toBeNull();
    expect(source.match(/^import .*@vitejs\/plugin-react/m)).toBeNull();
  });
});

describe("assertBundlePresent (SC-04)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "keyart-serve-bundle-"));
  });

  afterEach(async () => {
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it("a missing bundle teaches `npm run build`", async () => {
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

describe("resolveDevUiRoot (SC-04)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "keyart-serve-dev-ui-"));
  });

  afterEach(async () => {
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it("`--dev` without src/ui teaches \"repo clone\"", async () => {
    // Neither `<moduleDir>/../../src/ui/index.html` nor `<moduleDir>/../ui/index.html`
    // exists under a bare temp dir.
    const moduleDir = path.join(dir, "dist", "commands");
    await fsPromises.mkdir(moduleDir, { recursive: true });

    await expect(resolveDevUiRoot(moduleDir)).rejects.toBeInstanceOf(CommandError);
    try {
      await resolveDevUiRoot(moduleDir);
      expect.unreachable();
    } catch (err) {
      const commandError = err as CommandError;
      expect(commandError.message).toBe(DEV_UI_MISSING_MESSAGE);
      expect(commandError.message).toContain("git clone");
      expect(commandError.message).toContain("npm install");
      expect(commandError.message).not.toContain("<repo-url>");
    }
  });
});

describe("--dev without vite reuses WS-01's message (SC-04)", () => {
  it("the message equals VITE_MISSING_MESSAGE", async () => {
    const importer = vi.fn(async () => {
      throw new Error("ERR_MODULE_NOT_FOUND");
    });
    try {
      await loadViteDeps(importer);
      expect.unreachable();
    } catch (err) {
      const commandError = err as CommandError;
      expect(commandError.message).toBe(VITE_MISSING_MESSAGE);
    }
  });
});

describe("createApiMounts (SC-03/SC-14)", () => {
  it("the guard is mount index 0 and every handler is present, in order", async () => {
    const cwd = await fsPromises.mkdtemp(path.join(os.tmpdir(), "keyart-serve-mounts-"));
    try {
      const jobs = createJobStore();
      const mounts = createApiMounts({ cwd, jobs });

      expect(mounts[0].prefix).toBe("/api");

      // Identity comparison on the guard handler is brittle (it's a closure);
      // instead drive it with a foreign Host and observe the 403 it alone produces.
      let ended = false;
      let body = "";
      const res = {
        statusCode: 200,
        setHeader() {
          /* no-op */
        },
        end(payload?: string) {
          ended = true;
          body = payload ?? "";
        },
      };
      const req = { headers: { host: "evil.example" }, url: "/api/dashboard" };
      mounts[0].handler(req as never, res as never, () => {
        throw new Error("guard must not call next() on a foreign Host");
      });
      expect(res.statusCode).toBe(403);
      expect(ended).toBe(true);
      expect(JSON.parse(body).error).toContain("Forbidden");

      const prefixes = mounts.map((m) => m.prefix);
      expect(prefixes).toEqual([
        "/api", // local-only guard
        "/api", // reconciliation GETs (before createWriteApi)
        "/api", // write api
        "/api", // tokens
        "/api", // settings
        "/api/asset",
        "/api/uploads",
        "/api/element-feedback",
        "/api/actions",
        "/api/actions",
        "/api/actions",
        "/api/jobs",
        "/api/surface",
        "/api/chat",
        "/api/asset-pack",
        "/api/audit-screenshot",
        "/api/dashboard",
      ]);
    } finally {
      await fsPromises.rm(cwd, { recursive: true, force: true });
    }
  });
});
