#!/usr/bin/env node
// The TIER above the in-suite floor (src/integration/package-contents.test.ts):
// pack -> install (production deps only) -> run every consumer command -> boot
// `serve` on a real port -> assert the studio answers -> tear down. Networked
// by necessity (npm install resolves from the registry), so this is wired only
// to `test:package`/`prepublishOnly`/CI — NEVER `vitest run`. Node builtins only.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const KEEP = process.argv.includes("--keep");

class SmokeFailure extends Error {}

function fail(message) {
  throw new SmokeFailure(message);
}

let assertionCount = 0;
function assertTrue(condition, message, details) {
  assertionCount++;
  if (!condition) {
    if (details) {
      console.error("--- details ---");
      console.error(details);
    }
    fail(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `npm` and `.cmd` shims are not real Win32 executables — CreateProcess can't
 * launch them directly, so they need `shell: true` to resolve through
 * `cmd.exe`. A real executable (node.exe) must NOT go through the shell: when
 * `shell: true`, Node joins `[file, ...args]` into one string for `cmd /c`
 * without quoting `file` itself, so an install under "C:\Program Files"
 * splits at the space and cmd.exe reports "'C:\Program' is not recognized".
 */
function needsShell(cmd) {
  if (process.platform !== "win32") return false;
  const base = path.basename(cmd).toLowerCase();
  return base === "npm" || base.endsWith(".cmd");
}

/**
 * Thin spawnSync wrapper. Prints both streams and throws on an unexpected
 * exit code (default: anything but 0) so a failure is always loud.
 */
function run(cmd, args, opts = {}) {
  const { allowedExitCodes = [0], ...spawnOpts } = opts;
  const result = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: needsShell(cmd),
    ...spawnOpts,
  });
  if (!allowedExitCodes.includes(result.status)) {
    console.error(`FAIL: command exited ${result.status}: ${[cmd, ...args].join(" ")}`);
    console.error("--- stdout ---");
    console.error(result.stdout ?? "");
    console.error("--- stderr ---");
    console.error(result.stderr ?? "");
    fail(`command exited ${result.status}: ${[cmd, ...args].join(" ")}`);
  }
  return result;
}

async function step(name, fn) {
  console.log(`→ ${name}`);
  const result = await fn();
  console.log(`✓ ${name}`);
  return result;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function preflight() {
  for (const rel of ["dist/cli.js", "dist/index.js", "dist/ui/index.html"]) {
    if (!fs.existsSync(path.join(repoRoot, rel))) {
      fail(`dist/ is not built (missing ${rel}). Run \`npm run build\` first.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Pack + install
// ---------------------------------------------------------------------------

function packTarball(tmpRoot) {
  const result = run("npm", ["pack", "--json", "--pack-destination", tmpRoot], {
    cwd: repoRoot,
  });
  // Newer npm versions append human-readable notice/warn text around the
  // JSON on stdout: drop npm-prefixed lines, then parse the bracketed span.
  const clean = result.stdout
    .split("\n")
    .filter((line) => !/^npm (notice|warn|error)\b/.test(line))
    .join("\n");
  const start = clean.indexOf("[");
  const end = clean.lastIndexOf("]");
  const [packed] = JSON.parse(clean.slice(start, end + 1));
  const { filename, entryCount, unpackedSize } = packed;
  console.log(`packed ${filename}: ${entryCount} files, ${unpackedSize} bytes unpacked`);
  return { filename, entryCount, unpackedSize, tarballPath: path.join(tmpRoot, filename) };
}

async function installProject(tmpRoot, tarballPath) {
  const proj = path.join(tmpRoot, "project");
  await fsp.mkdir(proj, { recursive: true });
  await fsp.writeFile(
    path.join(proj, "package.json"),
    JSON.stringify({ name: "keyart-smoke", private: true, version: "0.0.0", type: "module" }, null, 2),
  );
  run("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", tarballPath], { cwd: proj });
  return proj;
}

/**
 * `vite`/`vitest`/`@vitejs/plugin-react`/`react-dom` prove no devDependency
 * toolchain leaked into a production install. Bare `react` is deliberately
 * NOT asserted absent: `react-markdown` is a real `dependencies` entry (used
 * client-side by the studio bundle) that declares `react` as a
 * peerDependency, which npm auto-installs even under `--omit=dev` — its
 * presence proves peer resolution works, not that devDeps leaked.
 */
function assertProdOnlyDeps(proj) {
  const nm = (name) => path.join(proj, "node_modules", ...name.split("/"));
  for (const dev of ["vite", "vitest", "@vitejs/plugin-react", "react-dom"]) {
    assertTrue(
      !fs.existsSync(nm(dev)),
      `${dev} present in node_modules — --omit=dev did not exclude devDependencies`,
    );
  }
  for (const prod of ["commander", "@modelcontextprotocol/sdk"]) {
    assertTrue(fs.existsSync(nm(prod)), `${prod} missing from node_modules — the production install is broken`);
  }
}

/** Deleted, not just unset-checked: a developer with a key exported would
 *  otherwise smoke a keyed path and never notice the keyless one broke. */
function buildEnv() {
  const env = { ...process.env, NO_COLOR: "1" };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  return env;
}

function binShimPath(proj) {
  const bin = process.platform === "win32" ? "keyart.cmd" : "keyart";
  return path.join(proj, "node_modules", ".bin", bin);
}

function keyartModulePath(proj) {
  return path.join(proj, "node_modules", "@wildorder", "keyart", "bin", "keyart.js");
}

function runKeyart(proj, env, args, opts = {}) {
  return run(process.execPath, [keyartModulePath(proj), ...args], { cwd: proj, env, ...opts });
}

// ---------------------------------------------------------------------------
// serve boot
// ---------------------------------------------------------------------------

let serverOutput = "";
let serverExited = false;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitUntilAnswering(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverExited) {
      fail(`serve exited before it started answering.\n${serverOutput}`);
    }
    try {
      const res = await fetch(url);
      await res.arrayBuffer();
      return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  fail(`serve did not answer ${url} within ${timeoutMs}ms.\n${serverOutput}`);
}

async function killServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await sleep(500);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: true });
    } else {
      child.kill("SIGKILL");
    }
    await sleep(200);
  }
}

async function assertPortFree(port) {
  let stillListening = true;
  for (let attempt = 0; attempt < 3 && stillListening; attempt++) {
    if (attempt > 0) await sleep(300);
    stillListening = await new Promise((resolve) => {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      sock.setTimeout(500);
      sock.once("connect", () => {
        sock.destroy();
        resolve(true);
      });
      sock.once("timeout", () => {
        sock.destroy();
        resolve(false);
      });
      sock.once("error", () => resolve(false));
    });
  }
  assertTrue(!stillListening, `port ${port} is still accepting connections after teardown`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await step("preflight: dist/ is built", () => preflight());

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "keyart-smoke-"));
  let serverChild = null;

  try {
    const packInfo = await step("npm pack", () => packTarball(tmpRoot));

    const proj = await step("install --omit=dev", () => installProject(tmpRoot, packInfo.tarballPath));
    await step("assert production-only install", () => assertProdOnlyDeps(proj));

    const env = buildEnv();
    const installedVersion = JSON.parse(
      fs.readFileSync(path.join(proj, "node_modules", "@wildorder", "keyart", "package.json"), "utf8"),
    ).version;

    await step("bin shim exists and works", () => {
      const shim = binShimPath(proj);
      assertTrue(fs.existsSync(shim), `bin shim missing: ${shim}`);
      const res = run(shim, ["--version"], { cwd: proj, env });
      const out = res.stdout.trim();
      assertTrue(/^\d+\.\d+\.\d+$/.test(out), `--version output is not a semver: "${out}"`);
      assertTrue(
        out === installedVersion,
        `--version "${out}" does not equal installed package.json version "${installedVersion}"`,
      );
    });

    await step("--help lists the real command set", () => {
      const res = runKeyart(proj, env, ["--help"]);
      const names = [
        "init", "explore", "regenerate", "approve", "brief", "audit",
        "serve", "doctor", "mcp", "direction", "asset",
        "surface", "rule", "promote",
      ];
      const missing = names.filter((n) => !res.stdout.includes(n));
      assertTrue(missing.length === 0, `--help is missing: ${missing.join(", ")}`, res.stdout);
    });

    await step("init --yes scaffolds a real project", () => {
      runKeyart(proj, env, ["init", "--yes"]);
      assertTrue(fs.existsSync(path.join(proj, "keyart.config.ts")), "keyart.config.ts was not scaffolded");
      assertTrue(
        fs.existsSync(path.join(proj, "brand/directions/default/direction.yaml")),
        "brand/directions/default/direction.yaml was not scaffolded",
      );
    });

    await step("doctor runs to completion without a stack trace", () => {
      const res = run(process.execPath, [keyartModulePath(proj), "doctor"], {
        cwd: proj,
        env,
        allowedExitCodes: [0, 1],
      });
      assertTrue(res.stdout.trim().length > 0, "doctor produced no stdout", res.stdout);
      assertTrue(!/\n\s+at /.test(res.stderr ?? ""), "doctor stderr looks like a stack trace", res.stderr);
      assertTrue(!/ERR_MODULE_NOT_FOUND/.test(res.stderr ?? ""), "doctor stderr has ERR_MODULE_NOT_FOUND", res.stderr);
    });

    const directionId = "default";
    await step("keyless explore generates v1 into the scaffolded draft", () => {
      const res = runKeyart(proj, env, ["explore", directionId]);
      const versionsRoot = path.join(proj, "brand/directions", directionId, "versions");
      const entries = fs.existsSync(versionsRoot)
        ? fs.readdirSync(versionsRoot, { withFileTypes: true }).filter((d) => d.isDirectory())
        : [];
      assertTrue(entries.length >= 1, "no version directories exist after explore", res.stdout);
      assertTrue(
        /OPENAI_API_KEY|dry-run|placeholder/i.test(res.stdout),
        "explore stdout does not indicate the dry-run/no-key path was taken",
        res.stdout,
      );
    });

    await step("approve codifies the discovered direction", () => {
      runKeyart(proj, env, ["approve", directionId]);
      const brandYamlPath = path.join(proj, "brand/brand.yaml");
      assertTrue(fs.existsSync(brandYamlPath), "brand/brand.yaml is missing after approve");
      const brandYaml = fs.readFileSync(brandYamlPath, "utf8");
      assertTrue(brandYaml.includes(directionId), `brand/brand.yaml does not name direction "${directionId}"`);
      const guidesDir = path.join(proj, "brand/guides");
      assertTrue(
        fs.existsSync(guidesDir) && fs.readdirSync(guidesDir).length > 0,
        "brand/guides is empty after approve",
      );
    });

    // Substring taken from the REAL built bundle, so the assertion tracks it
    // rather than an assumption about what index.html contains.
    const indexHtml = fs.readFileSync(path.join(repoRoot, "dist/ui/index.html"), "utf8");
    const rootMatch = indexHtml.match(/<div id="root"[^>]*>/);
    assertTrue(rootMatch !== null, 'dist/ui/index.html has no <div id="root"> marker to assert against');
    const bundleMarker = rootMatch[0];

    const port = await getFreePort();
    await step(`boot serve on port ${port}`, async () => {
      serverOutput = "";
      serverExited = false;
      serverChild = spawn(process.execPath, [keyartModulePath(proj), "serve", "--port", String(port)], {
        cwd: proj,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      serverChild.stdout.on("data", (d) => (serverOutput += d.toString()));
      serverChild.stderr.on("data", (d) => (serverOutput += d.toString()));
      serverChild.once("exit", () => {
        serverExited = true;
      });
      await waitUntilAnswering(`http://127.0.0.1:${port}/`, 30_000);
    });

    await step("GET / serves the packaged studio bundle", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      assertTrue(res.status === 200, `GET / expected 200, got ${res.status}`);
      const ct = res.headers.get("content-type") ?? "";
      assertTrue(ct.startsWith("text/html"), `GET / content-type is "${ct}"`);
      const body = await res.text();
      assertTrue(body.includes(bundleMarker), "GET / body is missing the studio bundle marker");
    });

    await step("GET /api/dashboard answers with the scaffolded project", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`);
      assertTrue(res.status === 200, `GET /api/dashboard expected 200, got ${res.status}`);
      const ct = res.headers.get("content-type") ?? "";
      assertTrue(ct.startsWith("application/json"), `GET /api/dashboard content-type is "${ct}"`);
      const body = await res.json();
      assertTrue(
        Array.isArray(body.directions) && body.directions.some((d) => d.id === "default"),
        'GET /api/dashboard directions[] has no "default" entry',
        JSON.stringify(body.directions),
      );
    });

    await step("a deep link falls back to the SPA shell", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/directions/default`);
      assertTrue(res.status === 200, `GET /directions/default expected 200, got ${res.status}`);
      const ct = res.headers.get("content-type") ?? "";
      assertTrue(ct.startsWith("text/html"), `GET /directions/default content-type is "${ct}"`);
      const body = await res.text();
      assertTrue(body.includes(bundleMarker), "GET /directions/default body is missing the studio bundle marker");
    });

    await step("the local-only guard still rejects a foreign Origin", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/api/dashboard`, {
        headers: { Origin: "http://evil.example" },
      });
      assertTrue(res.status === 403, `foreign-Origin request expected 403, got ${res.status}`);
      const body = await res.text();
      assertTrue(body.includes("Forbidden"), '403 body is missing "Forbidden"', body);
      assertTrue(!body.includes("directions"), '403 body leaked "directions"', body);
    });

    await step("teardown: server stops and the port frees up", async () => {
      await killServer(serverChild);
      serverChild = null;
      await assertPortFree(port);
    });

    return packInfo;
  } finally {
    if (serverChild) await killServer(serverChild);
    if (KEEP) {
      console.log(`--keep: retained ${tmpRoot}`);
    } else {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  }
}

main()
  .then((packInfo) => {
    console.log(
      `PASS: packaged install smoke (${assertionCount} checks) — ` +
        `${packInfo.filename}: ${packInfo.entryCount} files, ${packInfo.unpackedSize} bytes unpacked`,
    );
    process.exitCode = 0;
  })
  .catch((err) => {
    process.exitCode = 1;
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
  });
