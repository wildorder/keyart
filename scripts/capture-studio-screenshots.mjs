#!/usr/bin/env node
/**
 * scripts/capture-studio-screenshots.mjs
 *
 * KEYLESS. Captures docs/examples/starter-brand/studio-*.png against the
 * prebuilt STATIC studio (`npm run build` → dist/ui, then `keyart serve`
 * with NO --dev) — what a consumer actually gets, never the dev server.
 *
 *   node scripts/capture-studio-screenshots.mjs [--project <dir>]
 *
 * Without --project: creates its own temp consuming project, scaffolds a
 * direction, splices in the committed style-tile.png/homepage-mockup.png (if
 * already generated) so the studio shows real generated imagery, and cleans
 * up afterward. With --project <dir>: reuses an existing, already-approved
 * temp project verbatim (e.g. one kept via `generate-example.mjs --keep`) and
 * never deletes it — this script did not create it.
 *
 * Node ESM + Playwright (an existing devDependency; not a new dependency).
 * Never referenced by package.json, .github/**, or any test.
 */
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "keyart.js");
const DIST_UI_INDEX = path.join(REPO_ROOT, "dist", "ui", "index.html");
const EXAMPLE_DIR = path.join(REPO_ROOT, "docs", "examples", "starter-brand");

function fail(message) {
  console.error(`FAIL: ${message}`);
}

async function importDist(relPath) {
  return import(pathToFileURL(path.join(REPO_ROOT, "dist", relPath)).href);
}

async function linkLocalPackage(tempDir) {
  const nodeModules = path.join(tempDir, "node_modules");
  await fs.mkdir(path.join(nodeModules, "@wildorder"), { recursive: true });
  const target = path.join(nodeModules, "@wildorder", "keyart");
  await fs.symlink(
    REPO_ROOT,
    target,
    process.platform === "win32" ? "junction" : "dir",
  );
}

function runCli(argv, cwd) {
  const result = spawnSync(process.execPath, [BIN, "--cwd", cwd, ...argv], {
    encoding: "utf-8",
    env: process.env,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function assertOk(label, step) {
  if (step.exitCode !== 0) {
    throw new Error(
      `${label} failed (exit ${step.exitCode}):\n--- stdout ---\n${step.stdout}\n--- stderr ---\n${step.stderr}`,
    );
  }
}

async function fileExists(p) {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `Studio did not become ready at ${url} within ${timeoutMs}ms.` +
      (lastErr ? ` Last error: ${lastErr.message}` : ""),
  );
}

/**
 * Builds a fresh temp project with one real, approved direction so the studio
 * has content to show. The direction's TEXT is a keyless placeholder (this
 * script never calls a model) — but its IMAGES, when the committed run
 * artifacts already exist, are the genuine PNGs from the real keyed run,
 * spliced in before `approve` so they flow through the real copy path.
 */
async function scaffoldProject() {
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "keyart-screens-"),
  );
  await linkLocalPackage(tempDir);

  assertOk("init", runCli(["init", "--yes"], tempDir));
  assertOk("explore", runCli(["explore", "--count", "1"], tempDir));

  const { loadConfig } = await importDist("config.js");
  const { resolveConcept } = await importDist("concept/resolve.js");
  const { listDirectionIds, readDirectionIndex } = await importDist(
    "concept/direction-store.js",
  );

  const config = await loadConfig(tempDir);
  const concept = await resolveConcept(tempDir, config, undefined);
  const directionIds = await listDirectionIds(concept.directionsDir);
  if (directionIds.length === 0) {
    throw new Error("explore produced no directions to scaffold with.");
  }
  const directionId = directionIds[0];
  const index = await readDirectionIndex(concept.directionsDir, directionId);
  const versionDir = path.join(
    concept.directionsDir,
    directionId,
    "versions",
    index.head,
  );

  let splicedRealImagery = false;
  for (const name of ["style-tile.png", "homepage-mockup.png"]) {
    const src = path.join(EXAMPLE_DIR, name);
    if (await fileExists(src)) {
      await fs.copyFile(src, path.join(versionDir, name));
      splicedRealImagery = true;
    }
  }
  if (!splicedRealImagery) {
    console.warn(
      "  (no committed style-tile.png/homepage-mockup.png yet — capturing without " +
        "real generated imagery; re-run after generate-example.mjs has landed the real run)",
    );
  }

  assertOk("approve", runCli(["approve", directionId], tempDir));

  return { tempDir, ownsTempDir: true, directionId };
}

async function reuseProject(tempDir) {
  const { loadConfig } = await importDist("config.js");
  const { resolveConcept } = await importDist("concept/resolve.js");
  const { listDirectionIds } = await importDist("concept/direction-store.js");
  const config = await loadConfig(tempDir);
  const concept = await resolveConcept(tempDir, config, undefined);
  const directionIds = await listDirectionIds(concept.directionsDir);
  return { tempDir, ownsTempDir: false, directionId: directionIds[0] };
}

async function main() {
  const argv = process.argv.slice(2);
  const projectIdx = argv.indexOf("--project");
  const explicitProject = projectIdx >= 0 ? argv[projectIdx + 1] : undefined;

  if (!(await fileExists(DIST_UI_INDEX))) {
    fail("run npm run build first (no dist/ui/index.html).");
    process.exit(1);
  }

  const { tempDir, ownsTempDir } = explicitProject
    ? await reuseProject(path.resolve(explicitProject))
    : await scaffoldProject();
  console.log(
    explicitProject
      ? `Reusing existing project: ${tempDir}`
      : `Scaffolded a temp project: ${tempDir}`,
  );

  let server;
  let browser;
  try {
    const port = await findFreePort();

    // Keyless throughout: strip OPENAI_API_KEY from the child env so the
    // studio the screenshots depict is exactly what a keyless stranger sees.
    const childEnv = { ...process.env };
    delete childEnv.OPENAI_API_KEY;

    server = spawn(
      process.execPath,
      [BIN, "--cwd", tempDir, "serve", "--port", String(port)],
      { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
    );
    let serverOutput = "";
    server.stdout.on("data", (d) => (serverOutput += d.toString()));
    server.stderr.on("data", (d) => (serverOutput += d.toString()));
    server.on("exit", (code) => {
      if (code !== null && code !== 0) {
        console.error(`serve exited early (${code}):\n${serverOutput}`);
      }
    });

    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(`${baseUrl}/`, 15_000);

    // Assert this is the STATIC build, not the dev server: the served HTML
    // must reference a HASHED asset path, which the dev server never emits.
    const html = await (await fetch(`${baseUrl}/`)).text();
    const hashedAssetMatch = html.match(/\/assets\/[\w.-]+-[\w-]{6,}\.(?:js|css)/);
    if (!hashedAssetMatch) {
      throw new Error(
        "Served HTML does not reference a hashed /assets/*-<hash>.(js|css) path — this " +
          "does not look like the STATIC build. Refusing to capture (would silently " +
          "invalidate the SC-03 proof). HTML head:\n" +
          html.slice(0, 500),
      );
    }
    console.log(
      `Static-build check passed: ${hashedAssetMatch[0]} found in the served HTML.`,
    );

    let chromium;
    try {
      const pw = await import("playwright");
      chromium = pw.chromium;
    } catch {
      throw new Error(
        "Playwright is not installed. Run `npx playwright install chromium` to set it up.",
      );
    }
    try {
      browser = await chromium.launch();
    } catch {
      throw new Error(
        "Chromium browser not found. Run `npx playwright install chromium` to install it.",
      );
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30_000 });

    // View 1: the concept workspace with the focused direction (also the
    // default first view of real generated imagery — the hero image).
    await page.screenshot({
      path: path.join(EXAMPLE_DIR, "studio-workspace.png"),
    });
    console.log("  ✓ docs/examples/starter-brand/studio-workspace.png");

    // View 2: the palette/token surface — best-effort click; a UI-text change
    // degrades to "capture current state" rather than failing the whole run.
    try {
      await page
        .getByText("Edit palette", { exact: false })
        .first()
        .click({ timeout: 3_000 });
      await page.waitForTimeout(300);
    } catch {
      console.warn(
        '  ("Edit palette" control not found — capturing current state instead)',
      );
    }
    await page.screenshot({
      path: path.join(EXAMPLE_DIR, "studio-palette.png"),
    });
    console.log("  ✓ docs/examples/starter-brand/studio-palette.png");

    // View 3: a closer look at the real generated imagery. Re-navigate first —
    // view 2 left the palette editor expanded and the page scrolled to it, so
    // clicking `img` first-match here lands on a sidebar thumbnail and captures
    // the SAME surface as studio-palette.png. Reset, then open the LARGEST
    // image on the page (the hero), which is the generated imagery itself.
    // Same best-effort degradation: a UI change costs a view, not the run.
    try {
      await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30_000 });
      await page.waitForTimeout(500);

      const images = page.locator("img");
      const count = await images.count();
      let hero = null;
      let heroArea = 0;
      for (let i = 0; i < count; i++) {
        const box = await images.nth(i).boundingBox();
        if (!box) continue;
        const area = box.width * box.height;
        if (area > heroArea) {
          heroArea = area;
          hero = images.nth(i);
        }
      }
      if (!hero) throw new Error("no visible image");
      await hero.scrollIntoViewIfNeeded();
      await hero.click({ timeout: 3_000 });
      await page.waitForTimeout(500);
    } catch {
      console.warn(
        "  (no clickable generated image found — capturing current state instead)",
      );
    }
    await page.screenshot({
      path: path.join(EXAMPLE_DIR, "studio-imagery.png"),
    });
    console.log("  ✓ docs/examples/starter-brand/studio-imagery.png");
  } finally {
    if (browser) await browser.close();
    if (server) server.kill();
    if (ownsTempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    } else {
      console.log(`Left the reused project in place: ${tempDir}`);
    }
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
