import fs from "node:fs";
import path from "node:path";
import { writeTextFile, readTextFile, pathExists } from "./fs.js";

export interface LoadEnvResult {
  loaded: string[]; // filenames actually read+parsed, in precedence-applied order, e.g. [".env", ".env.local"]
  keysSet: string[]; // env var names this call newly set (deduped, in first-set order)
}

/** Files loaded by {@link loadEnvFiles}, in ascending-precedence order. */
const ENV_FILES = [".env", ".env.keyart", ".env.local"] as const;

/**
 * Parse `KEY=VALUE` lines from raw env-file text. Blank lines, `#` comments,
 * and lines without `=` are skipped. The value is split on the FIRST `=`, both
 * sides are trimmed, and a single matching pair of surrounding quotes is
 * stripped from the value. No variable expansion is performed.
 */
function parseEnv(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === "") continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out.push([key, value]);
  }
  return out;
}

/**
 * Load `.env`, `.env.keyart`, and `.env.local` (if present) from `cwd` into
 * process.env. A variable already present in process.env when this is called
 * (i.e. from the real environment) is NEVER overwritten. Among the files,
 * `.env.local` takes precedence over `.env.keyart`, which takes precedence
 * over `.env`. Writes nothing to stdout. Never throws on a missing/malformed
 * file — unparseable lines are skipped.
 */
export function loadEnvFiles(cwd: string): LoadEnvResult {
  // Snapshot of keys from the real environment — immutable for this call.
  const realEnv = new Set(Object.keys(process.env));
  const loaded: string[] = [];
  const keysSet: string[] = [];
  const seen = new Set<string>();

  for (const file of ENV_FILES) {
    const filePath = path.join(cwd, file);
    let raw: string;
    try {
      if (!fs.existsSync(filePath)) continue;
      raw = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    loaded.push(file);
    for (const [key, value] of parseEnv(raw)) {
      if (realEnv.has(key)) continue; // real env always wins
      process.env[key] = value; // a later file overwrites an earlier file's value
      if (!seen.has(key)) {
        seen.add(key);
        keysSet.push(key);
      }
    }
  }

  return { loaded, keysSet };
}

/** Serialize an env value, quoting only when it contains whitespace or `#`. */
function serializeValue(value: string): string {
  return /[\s#]/.test(value) ? `"${value}"` : value;
}

/**
 * Set each key in `kv` inside the env file at `filePath`, preserving all other
 * lines, comments, and ordering. An existing `KEY=...` line has its value
 * replaced in place; a new key is appended. Creates the file (and parent dirs)
 * if absent. Values are written verbatim (no quoting) unless they contain
 * whitespace or `#`, in which case they are double-quoted.
 */
export async function upsertEnvFile(
  filePath: string,
  kv: Record<string, string>,
): Promise<void> {
  const existing = (await pathExists(filePath))
    ? await readTextFile(filePath)
    : "";

  const lines = existing === "" ? [] : existing.split("\n");
  const pending = new Set(Object.keys(kv));

  for (let i = 0; i < lines.length; i++) {
    for (const key of pending) {
      const re = new RegExp(`^(\\s*)${escapeRegExp(key)}\\s*=`);
      if (re.test(lines[i])) {
        lines[i] = `${key}=${serializeValue(kv[key])}`;
        pending.delete(key);
        break;
      }
    }
  }

  const appended: string[] = [];
  for (const key of Object.keys(kv)) {
    if (pending.has(key)) {
      appended.push(`${key}=${serializeValue(kv[key])}`);
    }
  }

  // Drop trailing empty lines so we can rejoin with exactly one trailing newline.
  const body = [...lines, ...appended];
  while (body.length > 0 && body[body.length - 1] === "") {
    body.pop();
  }

  await writeTextFile(filePath, body.join("\n") + "\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Best-effort check of whether `name` (a repo-root-relative path such as
 * ".env.local") would be ignored by `<cwd>/.gitignore`. Handles the common
 * cases: exact names, `*` globs, directory (`trailing/`) patterns, and negation
 * (`!pattern`) with last-match-wins semantics. Returns false when there is no
 * `.gitignore`. This is a deliberate subset of the full gitignore spec —
 * sufficient for the `.env*` / `!.env.example` case; never throws.
 */
export async function isGitignored(
  cwd: string,
  name: string,
): Promise<boolean> {
  const gitignorePath = path.join(cwd, ".gitignore");
  let raw: string;
  try {
    if (!(await pathExists(gitignorePath))) return false;
    raw = await readTextFile(gitignorePath);
  } catch {
    return false;
  }

  let ignored = false;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    let pattern = trimmed;
    const isNegation = pattern.startsWith("!");
    if (isNegation) pattern = pattern.slice(1);
    if (pattern.startsWith("/")) pattern = pattern.slice(1);

    const isDir = pattern.endsWith("/");
    if (isDir) pattern = pattern.slice(0, -1);

    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");

    const source = isDir ? `^${escaped}(/|$)` : `^${escaped}$`;
    if (new RegExp(source).test(name)) {
      ignored = !isNegation; // last match wins
    }
  }

  return ignored;
}
