import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { z } from "zod";
import type { KeyartConfig } from "./types.js";
import { DEFAULT_MODELS } from "./types.js";
import { configureModelClient } from "./openai.js";
import type { StoreDriver } from "./store/create-store.js";

/** One cookie seeded BEFORE navigation. `domain` absent ⇒ scoped to the URL being
 *  scanned; `domain` present ⇒ `path` defaults to "/". */
export const ScanCookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().optional(),
});

/**
 * Optional, additive, TOP-LEVEL scan behavior. Deliberately NOT nested under
 * `brand`: `brand.surface` is the manifest PATH, whereas every key here is
 * page-visit BEHAVIOR. Absent ⇒ the scan behaves exactly as it did before this
 * block existed.
 */
export const ScanConfigSchema = z.object({
  /** Selector awaited (bounded) after load, before observing. */
  waitFor: z.string().optional(),
  /** Selectors clicked IN ORDER after load. Absence-tolerant: a selector that
   *  never appears is recorded as a note, never an error. */
  dismiss: z.array(z.string()).optional(),
  /** localStorage entries seeded pre-navigation via page.addInitScript. */
  storage: z.record(z.string()).optional(),
  /** Cookies seeded pre-navigation via context.addCookies. */
  cookies: z.array(ScanCookieSchema).optional(),
  /** Selectors whose subtree is never a candidate. DECLARED here; consumed by a
   *  later workstream — this one neither reads nor forwards it. */
  ignore: z.array(z.string()).optional(),
  /** Extra hosts / path fragments that mean "user content". DECLARED here;
   *  consumed by a later workstream. */
  contentOrigins: z.array(z.string()).optional(),
});

/**
 * Zod schema mirroring {@link KeyartConfig}. Every field introduced after
 * v1 is optional (and defaulted where it has a sensible default) so configs
 * written before those fields existed continue to load unchanged.
 */
export const KeyartConfigSchema = z.object({
  project: z.object({
    name: z.string(),
    type: z.string(),
    framework: z.string(),
  }),
  brand: z.object({
    root: z.string(),
    references: z.string(),
    approved: z.string(),
    rejected: z.string(),
    directions: z.string().optional(),
    global: z.string().optional(),
    surface: z.string().optional(),
  }),
  models: z
    .object({
      text: z.string().optional(),
      vision: z.string().optional(),
      image: z.string().optional(),
      baseURL: z.string().url().optional(),
    })
    .optional(),
  outputs: z.object({
    cursorRules: z.string(),
    cssVars: z.string(),
    implementationBrief: z.string(),
    binding: z.string().optional(),
  }),
  store: z
    .object({
      driver: z.enum(["file"]).default("file"),
    })
    .default({ driver: "file" }),
  scan: ScanConfigSchema.optional(),
});

export function configNotFoundError(): Error {
  return new Error(
    "keyart.config.ts not found. Run `keyart init` to create one.",
  );
}

function formatConfigLoadError(configPath: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof Error && "code" in err
      ? String((err as NodeJS.ErrnoException).code)
      : "";

  if (
    code === "ERR_UNKNOWN_FILE_EXTENSION" ||
    message.includes('Unknown file extension ".ts"')
  ) {
    return new Error(
      `Cannot load ${configPath}: Node.js cannot execute .ts files on this version. ` +
        "Upgrade to Node.js 22.18+ or run with NODE_OPTIONS=--experimental-strip-types.",
    );
  }

  if (
    message.includes("Cannot find package 'keyart'") ||
    message.includes('Cannot find module \'keyart\'')
  ) {
    return new Error(
      `Cannot load ${configPath}: the "keyart" package is not installed. ` +
        "Run `npm install keyart` or `npm link keyart` from the project root.",
    );
  }

  if (message.includes("dist/index.js")) {
    return new Error(
      `Cannot load ${configPath}: keyart is not built. ` +
        "Run `npm run build` in the keyart package directory.",
    );
  }

  return new Error(`Failed to load ${configPath}: ${message}`);
}

export async function loadConfig(
  cwd?: string,
  opts?: { bustCache?: boolean },
): Promise<KeyartConfig> {
  const dir = cwd ?? process.cwd();
  const configPath = path.resolve(dir, "keyart.config.ts");

  try {
    await fs.access(configPath);
  } catch {
    throw configNotFoundError();
  }

  let mod: Record<string, unknown>;
  try {
    // Node's ESM loader caches modules by URL for the life of the process, so a
    // long-running host (the `serve` studio) would keep reading the FIRST config
    // it imported even after the file is rewritten on disk. `bustCache` appends a
    // unique query so the just-saved config is re-read; callers that don't need
    // freshness omit it and keep the cheap cached import.
    let fileUrl = pathToFileURL(configPath).href;
    if (opts?.bustCache) {
      fileUrl += `?v=${Date.now()}`;
    }
    mod = (await import(fileUrl)) as Record<string, unknown>;
  } catch (err) {
    throw formatConfigLoadError(configPath, err);
  }

  const raw = (mod.default ?? mod) as unknown;

  const result = KeyartConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const at = issue.path.length ? issue.path.join(".") : "(root)";
        return `  - ${at}: ${issue.message}`;
      })
      .join("\n");
    throw new Error(`Invalid keyart.config.ts:\n${issues}`);
  }

  const config = result.data;
  const resolved = {
    ...config,
    models: {
      ...DEFAULT_MODELS,
      ...config.models,
    },
  } as KeyartConfig;

  // loadConfig is the one chokepoint every command passes through, so the
  // configured endpoint reaches src/openai.ts here rather than being threaded
  // through every model-call signature. Deliberately module-global: one config
  // per process is the CLI's reality; an embedding host wraps the seam instead.
  configureModelClient({ baseURL: resolved.models.baseURL });

  return resolved;
}

/** Absolute path to the directions collection root (`<brand.root>/directions` by default). */
export function directionsRoot(cwd: string, config: KeyartConfig): string {
  return path.resolve(
    cwd,
    config.brand.directions ?? path.join(config.brand.root, "directions"),
  );
}

/** Absolute path to the global brand document (`<brand.root>/brand.yaml` by default). */
export function globalBrandPath(cwd: string, config: KeyartConfig): string {
  return path.resolve(
    cwd,
    config.brand.global ?? path.join(config.brand.root, "brand.yaml"),
  );
}

/** Absolute path to the surface manifest (`<brand.root>/surface.yaml` by default). */
export function surfaceManifestPath(cwd: string, config: KeyartConfig): string {
  return path.resolve(
    cwd,
    config.brand.surface ?? path.join(config.brand.root, "surface.yaml"),
  );
}

/** Absolute path of the surface binding lockfile (`<brand.root>/generated/binding.json` by default). */
export function bindingOutputPath(cwd: string, config: KeyartConfig): string {
  return path.resolve(
    cwd,
    config.outputs.binding ??
      path.join(config.brand.root, "generated", "binding.json"),
  );
}

/** The configured store driver, defaulting to `"file"`. */
export function storeDriver(config: KeyartConfig): StoreDriver {
  return config.store?.driver ?? "file";
}
