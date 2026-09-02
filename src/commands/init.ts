import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ensureDir,
  writeIfAbsent,
  writeWithConfirm,
  readTextFile,
  writeTextFile,
  pathExists,
} from "../fs.js";
import { mergeMcpConfig } from "../init/mcp-config.js";
import { globalBrandPath, storeDriver, loadConfig } from "../config.js";
import { createDirectionCore } from "../direction/core.js";
import { createSingleDocStore } from "../store/create-store.js";
import { parseGlobalBrand } from "../brand/schema.js";
import { DEFAULT_MODELS, type KeyartConfig } from "../types.js";
import {
  type WizardIO,
  createReadlineIO,
  askDefault,
  askYesNo,
  askChoice,
} from "../init/prompts.js";
import { upsertEnvFile, isGitignored } from "../env.js";
import { maskSecret } from "../secret-hint.js";
import {
  type WizardAnswers,
  FRAMEWORK_CHOICES,
  defaultAnswers,
  renderConfig,
} from "../init/config-template.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.resolve(__dirname, "../../templates");

const BRAND_DIRS = [
  "brand/input/references",
  "brand/approved",
  "brand/rejected",
  "brand/guides",
  "brand/generated/page-briefs",
  "brand/audits",
  "brand/directions",
];

const GITKEEP_DIRS = [
  "brand/rejected",
];

/**
 * Minimal config mirroring `templates/keyart.config.ts` defaults, used to
 * construct the direction/brand stores during scaffolding.
 *
 * `init` deliberately does NOT `loadConfig(cwd)` here: importing the just-written
 * `.ts` config would (a) fail in a target project where `keyart` is not yet
 * installed, and (b) poison Node's ESM module cache for that path — a cached
 * import (success OR rejection) would then be served to every later command in
 * the same process (e.g. the MCP server), masking subsequent config edits. Since
 * `init` already hardcodes the default `brand/...` layout throughout, the
 * template defaults are the correct, side-effect-free basis for these stores.
 */
function defaultInitConfig(): KeyartConfig {
  return {
    project: { name: "My Project", type: "prototype", framework: "next" },
    brand: {
      root: "./brand",
      references: "./brand/input/references",
      approved: "./brand/approved",
      rejected: "./brand/rejected",
      directions: "./brand/directions",
      global: "./brand/brand.yaml",
    },
    models: { ...DEFAULT_MODELS },
    outputs: {
      cursorRules: ".cursor/rules/keyart-brand.mdc",
      cssVars: "brand/generated/brand.css",
      implementationBrief: "brand/generated/implementation-brief.md",
    },
    store: { driver: "file" },
  };
}

const NPM_SCRIPTS: Record<string, string> = {
  keyart: "keyart serve",
  "keyart:explore": "keyart explore",
  "keyart:audit": "keyart audit",
};

export interface InitResult {
  created: string[];
  skipped: string[];
}

export async function runInit(opts: {
  cwd: string;
  force?: boolean;
  configText?: string;
}): Promise<InitResult> {
  const cwd = path.resolve(opts.cwd);
  const force = opts.force ?? false;
  const created: string[] = [];
  const skipped: string[] = [];

  function track(relPath: string, written: boolean): void {
    if (written) {
      created.push(relPath);
    } else {
      skipped.push(relPath);
    }
  }

  // 1. Write keyart.config.ts
  const configTemplate =
    opts.configText ??
    (await fs.readFile(
      path.join(TEMPLATES_DIR, "keyart.config.ts"),
      "utf-8",
    ));
  const configPath = path.join(cwd, "keyart.config.ts");
  track(
    "keyart.config.ts",
    await writeWithConfirm(configPath, configTemplate, { force }),
  );

  // 2. Create brand directories
  for (const dir of BRAND_DIRS) {
    await ensureDir(path.join(cwd, dir));
  }

  // 3. Write .gitkeep files in empty dirs
  for (const dir of GITKEEP_DIRS) {
    await writeIfAbsent(path.join(cwd, dir, ".gitkeep"), "");
  }

  // 4. Scaffold the default DIRECTION, using the template-default config (see
  // `defaultInitConfig` — `init` must not import the user config). Guard the
  // whole step: any failure records a tracked skip line rather than crashing
  // init.
  try {
    const config = defaultInitConfig();
    const directionCore = createDirectionCore(cwd, config);

    if (!(await directionCore.exists("default"))) {
      // brief.md is a projection: `create` writes it from the structured brief,
      // which starts empty (its projection is the placeholder). We never write a
      // freeform template over the projection — the brief is authored through
      // `direction brief set|patch|map`, the studio form, or an MCP host agent.
      await directionCore.create({ id: "default", name: "Default", brief: {} });
      track("brand/directions/default/direction.yaml", true);
      track("brand/directions/default/memory.yaml", true);
      track("brand/directions/default/brief.md", true);
    } else {
      // Existing direction — never clobber its structured brief / projection.
      track("brand/directions/default/direction.yaml", false);
      track("brand/directions/default/memory.yaml", false);
      track("brand/directions/default/brief.md", false);
    }

    // Initial empty brand.yaml — written through the store (the only yaml
    // writer), persisted at version 1. Never overwrite an existing brand.yaml,
    // even with --force: it holds user-authored rules + the approved pointer.
    const brandPath = globalBrandPath(cwd, config);
    if (!(await pathExists(brandPath))) {
      const brandStore = createSingleDocStore({
        driver: storeDriver(config),
        filePath: brandPath,
        parse: parseGlobalBrand,
      });
      const now = new Date().toISOString();
      await brandStore.write({
        approvedPointer: null,
        rules: [],
        version: 0,
        createdAt: now,
        updatedAt: now,
      });
      track("brand/brand.yaml", true);
    } else {
      track("brand/brand.yaml", false);
    }
  } catch {
    skipped.push("brand/directions/default (config load failed)");
  }

  // 5. Write .env.keyart.example
  const envTemplate = await fs.readFile(
    path.join(TEMPLATES_DIR, "env.keyart.example"),
    "utf-8",
  );
  const envPath = path.join(cwd, ".env.keyart.example");
  track(".env.keyart.example", await writeIfAbsent(envPath, envTemplate));

  // 6. Merge npm scripts into package.json if it exists
  const pkgPath = path.join(cwd, "package.json");
  if (await pathExists(pkgPath)) {
    const pkgRaw = await readTextFile(pkgPath);
    const pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    let changed = false;

    for (const [key, value] of Object.entries(NPM_SCRIPTS)) {
      if (scripts[key] === undefined) {
        scripts[key] = value;
        changed = true;
        created.push(`package.json script "${key}"`);
      } else if (scripts[key] !== value && force) {
        scripts[key] = value;
        changed = true;
        created.push(`package.json script "${key}" (overwritten)`);
      } else if (scripts[key] !== value) {
        skipped.push(`package.json script "${key}" (exists, use --force)`);
      }
    }

    if (changed) {
      pkg.scripts = scripts;
      await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8");
    }
  }

  // 7. Scaffold / JSON-merge .cursor/mcp.json
  const mcpPath = path.join(cwd, ".cursor", "mcp.json");
  const mcpRaw = (await pathExists(mcpPath)) ? await readTextFile(mcpPath) : null;
  const mcpResult = mergeMcpConfig(mcpRaw, { force });
  switch (mcpResult.action) {
    case "created":
    case "merged":
      await writeTextFile(mcpPath, mcpResult.content!);
      track(".cursor/mcp.json", true);
      break;
    case "unchanged":
      // No write, no summary line — keeps repeat init runs quiet.
      break;
    case "skipped-exists":
    case "skipped-invalid":
      skipped.push(`.cursor/mcp.json (${mcpResult.reason})`);
      break;
  }

  // 8. Print summary
  if (created.length > 0) {
    console.log("\nCreated:");
    for (const p of created) {
      console.log(`  + ${p}`);
    }
  }
  if (skipped.length > 0) {
    console.log("\nSkipped (already exists):");
    for (const p of skipped) {
      console.log(`  - ${p}`);
    }
  }

  if (created.length === 0 && skipped.length === 0) {
    console.log("Nothing to do.");
  } else {
    console.log(
      "\nDone! Describe your project to get started:\n" +
        '  keyart direction brief set default oneLiner "<what you are building>"\n' +
        '  keyart direction brief map default "<a freeform ramble>"   (needs OPENAI_API_KEY)\n' +
        "  keyart serve                                            (edit the brief in the studio)\n" +
        "\nNote: brand/directions/default/brief.md is GENERATED from that structured brief.\n" +
        "Edits to it are ignored by explore and overwritten on the next brief write.",
    );
  }

  return { created, skipped };
}

export interface InitInteractiveResult extends InitResult {
  configWritten: boolean;
  keyPersisted: boolean;
}

/**
 * Interactive `keyart init`. Prompts for the essentials via an injectable
 * {@link WizardIO}, renders a populated `keyart.config.ts`, scaffolds the
 * brand tree through the silent {@link runInit} (the single write path), and —
 * if provided — persists an `OPENAI_API_KEY` to `.env.local` (masked hint +
 * gitignore warning). The API key is NEVER written into the config. The IO is
 * always closed. CLI-only: the MCP `init` path calls {@link runInit} directly.
 */
export async function runInitInteractive(opts: {
  cwd: string;
  force?: boolean;
  io?: WizardIO;
}): Promise<InitInteractiveResult> {
  const cwd = path.resolve(opts.cwd);
  const force = opts.force ?? false;
  const io = opts.io ?? createReadlineIO();

  try {
    // Seed prompt defaults from an existing config, if one loads. Any failure
    // (no config, `keyart` not importable in the target project, …) is
    // expected — fall back to the shipped defaults silently.
    let defaults: WizardAnswers = { ...defaultAnswers };
    try {
      const cfg = await loadConfig(cwd);
      defaults = {
        projectName: cfg.project.name ?? defaultAnswers.projectName,
        projectType: cfg.project.type ?? defaultAnswers.projectType,
        framework: cfg.project.framework ?? defaultAnswers.framework,
      };
    } catch {
      /* fall back to defaultAnswers */
    }

    // Prompt for the essentials.
    const projectName = await askDefault(io, "Project name", defaults.projectName);
    const projectType = await askDefault(io, "Project type", defaults.projectType);
    const frameworkChoices: string[] = [...FRAMEWORK_CHOICES];
    const defaultFrameworkIndex = Math.max(
      0,
      frameworkChoices.indexOf(defaults.framework),
    );
    const framework = await askChoice(
      io,
      "Framework",
      frameworkChoices,
      defaultFrameworkIndex,
    );
    const openaiApiKey = (
      await askDefault(io, "OpenAI API key (optional, blank to skip)", "")
    ).trim();

    const answers: WizardAnswers = {
      projectName,
      projectType,
      framework,
      openaiApiKey: openaiApiKey || undefined,
    };

    // Overwrite guard for an existing config: confirm before clobbering.
    const configExists = await pathExists(
      path.join(cwd, "keyart.config.ts"),
    );
    let overwrite = false;
    if (configExists && !force) {
      overwrite = await askYesNo(
        io,
        "keyart.config.ts exists — overwrite?",
        false,
      );
    }
    const effectiveForce = force || overwrite;

    // Scaffold everything through the silent path, injecting the populated
    // config so it is written exactly once (honoring skip/force semantics).
    const result = await runInit({
      cwd,
      force: effectiveForce,
      configText: renderConfig(answers),
    });

    // Persist the API key to `.env.local` — never anywhere else.
    let keyPersisted = false;
    if (answers.openaiApiKey) {
      await upsertEnvFile(path.join(cwd, ".env.local"), {
        OPENAI_API_KEY: answers.openaiApiKey,
      });
      console.log(
        `Saved OPENAI_API_KEY to .env.local (${maskSecret(answers.openaiApiKey)}).`,
      );
      if (!(await isGitignored(cwd, ".env.local"))) {
        console.log(
          "\n⚠  WARNING: .env.local is NOT gitignored.\n" +
            "   Add `.env.local` to your .gitignore so your API key is never committed.",
        );
      }
      keyPersisted = true;
    }

    // Chained next-steps.
    console.log("\nNext steps:");
    console.log("  1. Edit brand/directions/default/brief.md with your product brief.");
    console.log("  2. Run `keyart explore` to generate visual directions.");
    console.log("  3. Run `keyart doctor` to check your setup is ready.");

    return {
      ...result,
      configWritten: result.created.includes("keyart.config.ts"),
      keyPersisted,
    };
  } finally {
    io.close();
  }
}
