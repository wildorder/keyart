import path from "node:path";
import { loadConfig, directionsRoot } from "../config.js";
import { hasApiKey } from "../openai.js";
import { loadEnvFiles } from "../env.js";
import { pathExists } from "../fs.js";
import type { KeyartConfig } from "../types.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string; // "config" | "openai-key" | "playwright" | "brand-scaffold"
  status: CheckStatus;
  detail: string; // human-readable current state
  hint?: string; // remediation, shown when not ok
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean; // false iff any check has status "fail" (hard prerequisite)
}

/** Left-column label per status, padded so the check names line up. */
const STATUS_LABEL: Record<CheckStatus, string> = {
  ok: "[OK]  ",
  warn: "[WARN]",
  fail: "[FAIL]",
};

/**
 * config (hard) — load + schema-validate `keyart.config.ts`. Returns the
 * check plus the loaded config (or null) so the brand-scaffold check can reuse
 * it without loading twice.
 */
async function checkConfig(
  cwd: string,
): Promise<{ check: DoctorCheck; config: KeyartConfig | null }> {
  try {
    const config = await loadConfig(cwd);
    return {
      check: {
        name: "config",
        status: "ok",
        detail: `keyart.config.ts valid (project: ${config.project.name}).`,
      },
      config,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      check: {
        name: "config",
        status: "fail",
        detail: message,
        hint: "Run `keyart init` to create keyart.config.ts.",
      },
      config: null,
    };
  }
}

/**
 * openai-key (soft) — load `.env*` first so a `.env.local` key counts, then
 * probe `process.env.OPENAI_API_KEY`. A missing key is a warning: every command
 * still runs in dry-run mode.
 */
function checkOpenAiKey(cwd: string): DoctorCheck {
  loadEnvFiles(cwd);
  if (hasApiKey()) {
    return {
      name: "openai-key",
      status: "ok",
      detail: "OPENAI_API_KEY is set (live model calls enabled).",
    };
  }
  return {
    name: "openai-key",
    status: "warn",
    detail: "OPENAI_API_KEY is not set — commands run in dry-run (placeholders).",
    hint: "Add OPENAI_API_KEY to .env.local (see keyart init) to enable live output.",
  };
}

/**
 * playwright (soft) — probe for the module + Chromium binary WITHOUT launching a
 * browser. Any failure is a warning with the install command; this check never
 * throws and never reports "fail" (audit degrades gracefully without it).
 */
async function checkPlaywright(): Promise<DoctorCheck> {
  let pw: typeof import("playwright");
  try {
    pw = await import("playwright");
  } catch {
    return {
      name: "playwright",
      status: "warn",
      detail: "Playwright is not installed.",
      hint: "npm i -D playwright && npx playwright install chromium (needed for `audit`).",
    };
  }

  try {
    const exe = pw.chromium.executablePath();
    if (await pathExists(exe)) {
      return {
        name: "playwright",
        status: "ok",
        detail: "Playwright + Chromium available.",
      };
    }
    return {
      name: "playwright",
      status: "warn",
      detail: "Playwright installed but Chromium is missing.",
      hint: "npx playwright install chromium",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: "playwright",
      status: "warn",
      detail: `Playwright check failed: ${message}`,
      hint: "npx playwright install chromium",
    };
  }
}

/**
 * brand-scaffold (hard) — only meaningful when the config loaded. Confirms the
 * brand root and the `default` direction exist. When config failed to load,
 * this is skipped as a warning so we do not double-fail the same root cause.
 */
async function checkBrandScaffold(
  cwd: string,
  config: KeyartConfig | null,
): Promise<DoctorCheck> {
  if (config === null) {
    return {
      name: "brand-scaffold",
      status: "warn",
      detail: "Skipped (config not loaded).",
    };
  }

  const brandRoot = path.resolve(cwd, config.brand.root);
  const defaultDirection = path.join(directionsRoot(cwd, config), "default");
  const [brandOk, defaultOk] = await Promise.all([
    pathExists(brandRoot),
    pathExists(defaultDirection),
  ]);

  if (brandOk && defaultOk) {
    return {
      name: "brand-scaffold",
      status: "ok",
      detail: "brand/ scaffold present (default direction found).",
    };
  }
  return {
    name: "brand-scaffold",
    status: "fail",
    detail: "brand/ scaffold or default direction is missing.",
    hint: "Run `keyart init`.",
  };
}

/** Print the human-readable readiness report via console.log (captured cleanly under MCP). */
function printReport(result: DoctorResult): void {
  for (const check of result.checks) {
    console.log(`${STATUS_LABEL[check.status]} ${check.name}: ${check.detail}`);
    if (check.hint && check.status !== "ok") {
      console.log(`         ↳ ${check.hint}`);
    }
  }
  console.log(
    result.ok
      ? "Keyart is ready."
      : "Keyart is NOT ready — resolve the [FAIL] items above.",
  );
}

/**
 * Report project readiness. Runs four checks (config, openai-key, playwright,
 * brand-scaffold) in order, prints a report, and returns `{ checks, ok }`.
 * Never throws for a failing check — a hard-prerequisite miss is a report
 * outcome, surfaced through `ok === false`.
 */
export async function runDoctor(opts: { cwd: string }): Promise<DoctorResult> {
  const { cwd } = opts;

  const checks: DoctorCheck[] = [];

  const { check: configCheck, config } = await checkConfig(cwd);
  checks.push(configCheck);
  checks.push(checkOpenAiKey(cwd));
  checks.push(await checkPlaywright());
  checks.push(await checkBrandScaffold(cwd, config));

  const ok = checks.every((c) => c.status !== "fail");
  const result: DoctorResult = { checks, ok };

  printReport(result);

  return result;
}
