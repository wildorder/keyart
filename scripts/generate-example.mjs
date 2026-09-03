#!/usr/bin/env node
/**
 * scripts/generate-example.mjs
 *
 * OWNER-INVOKED. This performs one real, PAID generation run and copies the
 * selected output into docs/examples/starter-brand/ — the only genuine,
 * generated example of Keyart's output committed to this repo (see
 * docs/examples/starter-brand/README.md).
 *
 *   node scripts/generate-example.mjs --yes [--keep] [--direction <id>]
 *
 * The key is read from `.env.local` at the repo root (via the project's own
 * loader, so `keyart init`'s storage location works), or from a real
 * OPENAI_API_KEY environment variable, which takes precedence.
 *
 * Node ESM, builtins only. Never referenced by package.json, .github/**, or any
 * test — this is not run in CI and never regenerates the committed artifacts
 * automatically.
 *
 * What it does, in order: refuses to run without a key or without --yes
 * (zero model calls on either refusal); creates a temp consuming project
 * OUTSIDE this repo; drives `init`, `concept brief patch`, `explore --count 3`,
 * `approve <directionId>` (id discovered from disk), and `asset pack` through
 * the real `keyart` CLI (linked into the temp project's node_modules —
 * keyart.config.ts imports the `keyart` package, same as any real
 * consumer); copies the selected artifacts into docs/examples/starter-brand/
 * with a sha256 checksum recorded for each; writes RUN.md (the verbatim
 * transcript); and cleans up the temp project unless --keep is given.
 */
import fs from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BIN = path.join(REPO_ROOT, "bin", "keyart.js");
const EXAMPLE_DIR = path.join(REPO_ROOT, "docs", "examples", "starter-brand");
const BRIEF_PATH = path.join(EXAMPLE_DIR, "brief.json");
const RUN_MD_PATH = path.join(EXAMPLE_DIR, "RUN.md");

/**
 * The exact `name` strings of the keyless dry-run placeholder templates
 * (src/explore/placeholders.ts). A real keyed generation names directions from
 * the live model; these three names are unreachable from a live run. If a
 * would-be-committed direction matches one, something ran keyless — refuse to
 * commit rather than silently ship a placeholder as "generated" output.
 */
const DRY_RUN_DIRECTION_NAMES = [
  "Bold & Modern",
  "Warm & Approachable",
  "Minimal & Refined",
];

function fail(message) {
  console.error(`FAIL: ${message}`);
}

function parseArgs(argv) {
  const yes = argv.includes("--yes");
  const keep = argv.includes("--keep");
  const dIdx = argv.indexOf("--direction");
  const direction = dIdx >= 0 ? argv[dIdx + 1] : undefined;
  return { yes, keep, direction };
}

async function importDist(relPath) {
  return import(pathToFileURL(path.join(REPO_ROOT, "dist", relPath)).href);
}

/**
 * Load the repo's `.env` / `.env.keyart` / `.env.local` through the
 * project's OWN loader (src/env.ts) rather than reparsing them here — a key
 * stored the way `keyart init` stores it must count here too.
 *
 * This has to run BEFORE the key guard and before any child spawn. `runCli`
 * passes `process.env` down, and the child's own `loadEnvFiles(cwd)` resolves
 * against the TEMP project, which has no `.env.local` — so without this the
 * run would silently dry-run and write placeholders. A real environment
 * variable still wins: the loader never overwrites one.
 */
async function loadRepoEnv() {
  let loadEnvFiles;
  try {
    ({ loadEnvFiles } = await importDist("env.js"));
  } catch {
    fail("dist/ is not built — run `npm run build` first.");
    process.exit(1);
  }
  return loadEnvFiles(REPO_ROOT);
}

/**
 * `keyart.config.ts` (written by `init`) does `import { defineKeyartConfig }
 * from "@wildorder/keyart"` — exactly like any real consuming project. A temp project
 * has no npm install step, so this links the temp project's node_modules/@wildorder/keyart
 * straight at this checkout (Node's own module resolution, no new dependency).
 */
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
  const fullArgv = ["--cwd", cwd, ...argv];
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [BIN, ...fullArgv], {
    encoding: "utf-8",
    env: process.env,
  });
  return {
    argv: ["node", "bin/keyart.js", ...fullArgv],
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: Date.now() - startedAt,
  };
}

function assertOk(step) {
  console.log(
    `$ ${step.argv.join(" ")}  → exit ${step.exitCode} (${step.durationMs}ms)`,
  );
  if (step.exitCode !== 0) {
    throw new Error(
      `Command failed: ${step.argv.join(" ")}\n` +
        `--- stdout ---\n${step.stdout}\n--- stderr ---\n${step.stderr}`,
    );
  }
}

function redact(text, tempDir) {
  return text.split(tempDir).join("<tmp>");
}

async function sha256(filePath) {
  const buf = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function fileExists(p) {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

function renderRunMd(opts) {
  const {
    version,
    date,
    models,
    transcript,
    directionId,
    selectionNote,
    checksums,
    tempDir,
    durationMs,
  } = opts;

  const cmdBlocks = transcript
    .map((r, i) => {
      const argv = redact(r.argv.join(" "), tempDir);
      const stdout = redact(r.stdout, tempDir).trim();
      const stderr = redact(r.stderr, tempDir).trim();
      return `### ${i + 1}. \`${argv}\`

- exit code: ${r.exitCode}
- duration: ${r.durationMs}ms

<details><summary>stdout</summary>

\`\`\`
${stdout || "(empty)"}
\`\`\`

</details>

<details><summary>stderr</summary>

\`\`\`
${stderr || "(empty)"}
\`\`\`

</details>`;
    })
    .join("\n\n");

  const checksumTable = checksums
    .map((c) => `| \`${c.file}\` | \`${c.sha256}\` |`)
    .join("\n");

  return `# Run Transcript — starter-brand

Produced by \`scripts/generate-example.mjs\` on ${date} using \`keyart\` v${version}.
Wall-clock duration: ${(durationMs / 1000).toFixed(1)}s.

Resolved models (\`keyart.config.ts\` merged with the package's \`DEFAULT_MODELS\` at run
time — read at run time, not copied from source): text=\`${models.text}\`,
vision=\`${models.vision}\`, image=\`${models.image}\`.

Selected direction: \`${directionId}\` (${selectionNote}).

The commands ran, in order, in a temporary consuming project created with \`fs.mkdtemp\`
under the OS temp dir (never inside this repo) with \`keyart\` linked into its
\`node_modules\`. The temp path is redacted below as \`<tmp>\`.

## Commands

${cmdBlocks}

## Artifact checksums (sha256)

Computed immediately after copying each file from the run's temp project into
\`docs/examples/starter-brand/\` — proof the committed file is byte-identical to the run's
own output (nothing hand-edited after the fact).

| File | sha256 |
|------|--------|
${checksumTable}
`;
}

async function main() {
  const argv = process.argv.slice(2);
  const { yes, keep, direction: explicitDirection } = parseArgs(argv);

  const { loaded } = await loadRepoEnv();
  if (loaded.length > 0) {
    console.log(`Loaded ${loaded.join(", ")} from ${REPO_ROOT}`);
  }

  if (!process.env.OPENAI_API_KEY) {
    fail(
      "this script performs a real, paid generation run and needs OPENAI_API_KEY.\n" +
        "Put it in .env.local at the repo root — the same place `keyart init`\n" +
        "writes it:\n" +
        "  OPENAI_API_KEY=sk-...\n" +
        "or supply it for one run:\n" +
        "  OPENAI_API_KEY=sk-... node scripts/generate-example.mjs --yes",
    );
    process.exit(1);
  }

  if (!yes) {
    fail(
      "This will call the image model N times (explore --count 3 = 3 style tiles + 3 " +
        "mockups) and the text/vision models. Re-run with --yes to proceed.\n" +
        "No model calls were made.",
    );
    process.exit(1);
  }

  const briefRaw = await fs.readFile(BRIEF_PATH, "utf-8");
  const briefJson = JSON.stringify(JSON.parse(briefRaw));

  const runStartedAt = Date.now();
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "keyart-example-"),
  );
  console.log(`Working in a temp consuming project: ${tempDir}`);

  const transcript = [];

  try {
    await linkLocalPackage(tempDir);

    for (const step of [
      ["init", "--yes"],
      ["concept", "brief", "patch", "default", briefJson],
      ["explore", "--count", "3"],
    ]) {
      const r = runCli(step, tempDir);
      transcript.push(r);
      assertOk(r);
    }

    // Discover the directions from disk — never hard-coded.
    const { loadConfig } = await importDist("config.js");
    const { resolveConcept } = await importDist("concept/resolve.js");
    const { listDirectionIds, readDirectionIndex, readHead } =
      await importDist("concept/direction-store.js");

    const config = await loadConfig(tempDir);
    const concept = await resolveConcept(tempDir, config, undefined);
    const directionIds = await listDirectionIds(concept.directionsDir);
    if (directionIds.length === 0) {
      throw new Error("explore produced no directions.");
    }
    console.log(`Directions available: ${directionIds.join(", ")}`);

    let directionId;
    let selectionNote;
    if (explicitDirection) {
      if (!directionIds.includes(explicitDirection)) {
        throw new Error(
          `--direction ${explicitDirection} not found among: ${directionIds.join(", ")}`,
        );
      }
      directionId = explicitDirection;
      selectionNote = "explicit --direction";
    } else {
      directionId = directionIds[0];
      selectionNote = "default: first discovered direction";
    }
    console.log(`Selected direction: ${directionId} (${selectionNote})`);

    for (const step of [
      ["approve", directionId],
      ["asset", "pack"],
    ]) {
      const r = runCli(step, tempDir);
      transcript.push(r);
      assertOk(r);
    }

    // Refuse to commit a dry-run placeholder (belt-and-braces — unreachable
    // given the key check above, but this is the anti-fabrication backstop).
    const headVersion = await readHead(concept.directionsDir, directionId);
    if (DRY_RUN_DIRECTION_NAMES.includes(headVersion.name)) {
      throw new Error(
        `Direction "${headVersion.name}" matches a keyless dry-run placeholder template ` +
          "name. Refusing to commit — this looks like a dry-run artifact, not real output.",
      );
    }

    // Resolve every source path from the run's REAL config — never guessed.
    const brandRoot = path.resolve(tempDir, config.brand.root);
    const approvedDir = path.resolve(tempDir, config.brand.approved);
    // "guides" / "generated" / "generated/asset-pack/<id>" are not themselves
    // configurable — they mirror src/commands/approve.ts's own hardcoded
    // layout under the configurable brand.root, exactly as approve.ts writes it.
    const guidesDir = path.join(brandRoot, "guides");
    const generatedDir = path.join(brandRoot, "generated");
    const cssPath = path.resolve(tempDir, config.outputs.cssVars);
    const packDir = path.join(generatedDir, "asset-pack", directionId);

    const index = await readDirectionIndex(concept.directionsDir, directionId);
    void index; // (kept for RUN.md readability if extended later)

    const copyManifest = [
      { dest: "style-tile.png", src: path.join(approvedDir, "style-tile.png"), required: true },
      { dest: "homepage-mockup.png", src: path.join(approvedDir, "homepage-mockup.png"), required: true },
      { dest: "palette-type-board.svg", src: path.join(guidesDir, "style-board.svg"), required: true },
      { dest: "palette-type-board.md", src: path.join(guidesDir, "style-board.md"), required: true },
      { dest: "brand.css", src: cssPath, required: true },
      { dest: "visual-style-guide.md", src: path.join(guidesDir, "visual-style-guide.md"), required: true },
      { dest: "brand-guide.md", src: path.join(guidesDir, "brand-guide.md"), required: true },
      { dest: "cursor-brand.mdc", src: path.join(generatedDir, "cursor-brand.mdc"), required: true },
      { dest: "tokens.json", src: path.join(packDir, "tokens.json"), required: false },
      { dest: "contact-sheet.svg", src: path.join(packDir, "contact-sheet.svg"), required: false },
      { dest: "contact-sheet.md", src: path.join(packDir, "contact-sheet.md"), required: false },
    ];

    const checksums = [];
    for (const entry of copyManifest) {
      if (!(await fileExists(entry.src))) {
        if (entry.required) {
          throw new Error(
            `Expected artifact missing: ${entry.src}\n` +
              "The image model may have skipped generation — check the approve step's " +
              "output above (imageSkips warnings) and re-run.",
          );
        }
        continue;
      }
      const destPath = path.join(EXAMPLE_DIR, entry.dest);
      await fs.copyFile(entry.src, destPath);
      const [srcHash, destHash] = await Promise.all([
        sha256(entry.src),
        sha256(destPath),
      ]);
      if (srcHash !== destHash) {
        throw new Error(
          `Checksum mismatch after copying ${entry.dest} — the copy did not complete cleanly.`,
        );
      }
      checksums.push({ file: entry.dest, sha256: srcHash });
      console.log(
        `  ✓ docs/examples/starter-brand/${entry.dest} (sha256 ${srcHash.slice(0, 12)}…)`,
      );
    }

    const pkg = JSON.parse(
      await fs.readFile(path.join(REPO_ROOT, "package.json"), "utf-8"),
    );

    const runMd = renderRunMd({
      version: pkg.version,
      date: new Date().toISOString(),
      models: config.models,
      transcript,
      directionId,
      selectionNote,
      checksums,
      tempDir,
      durationMs: Date.now() - runStartedAt,
    });
    await fs.writeFile(RUN_MD_PATH, runMd, "utf-8");
    console.log(`  ✓ docs/examples/starter-brand/RUN.md`);

    console.log(
      "\nDone. Review the committed artifacts (look at every image — no real company " +
        "name/logo/likeness), then fill in docs/examples/starter-brand/README.md (Phase C).",
    );
  } finally {
    if (keep) {
      console.log(`--keep: left the temp project at ${tempDir}`);
    } else {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
