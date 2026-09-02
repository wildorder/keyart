import path from "node:path";
import fs from "node:fs/promises";
import { CommandError } from "../errors.js";

/**
 * An opaque, URL-safe handle to a generated artifact under the project root.
 *
 * Clients receive handles in read payloads (e.g. `DashboardData`) and pass
 * them back verbatim — `GET /api/asset?path=<handle>` — without parsing,
 * joining, or otherwise interpreting them. Today a handle happens to be the
 * cwd-relative forward-slash path of the file, but that is an implementation
 * detail of the file driver: a hosted backend is free to mint ids or signed
 * URLs instead, and clients that treat handles as opaque keep working.
 */
export type ArtifactHandle = string;

/**
 * Read-only accessor for generated artifacts (PNGs, SVGs, guides, audits…)
 * under a single project root. The dashboard read surface goes through this
 * instead of probing the disk directly, so the filesystem layout stays an
 * implementation detail rather than a wire contract, and a hosted backend can
 * swap the implementation without touching the readers.
 *
 * All `absPath` arguments must resolve to at or under the root; anything else
 * throws a 403 `CommandError` (same contract as `resolveUnderCwd` on the
 * serving side).
 */
export interface ArtifactStore {
  /** True when the artifact exists. */
  exists(absPath: string): Promise<boolean>;
  /** The artifact's handle when it exists, else `undefined` — the one-call
   * form of the probe-then-relativize pattern. */
  probe(absPath: string): Promise<ArtifactHandle | undefined>;
  /** The handle for an artifact (containment-checked; no existence probe). */
  handleFor(absPath: string): ArtifactHandle;
  /** The absolute path a handle denotes, strictly under the root. */
  resolveHandle(handle: ArtifactHandle): string;
  /** UTF-8 contents; rejects when the artifact is missing or unreadable. */
  readText(absPath: string): Promise<string>;
  /** Sorted immediate-subdirectory names, `[]` when the directory is missing. */
  listDirs(absPath: string): Promise<string[]>;
}

/** The file-driver `ArtifactStore`, rooted at `cwd`. */
export function createArtifactStore(cwd: string): ArtifactStore {
  const root = path.resolve(cwd);

  function contained(absPath: string): string {
    const abs = path.resolve(root, absPath);
    if (abs === root || abs.startsWith(root + path.sep)) {
      return abs;
    }
    throw new CommandError("Forbidden path", 403);
  }

  function handleFor(absPath: string): ArtifactHandle {
    return path.relative(root, contained(absPath)).split(path.sep).join("/");
  }

  async function exists(absPath: string): Promise<boolean> {
    try {
      await fs.access(contained(absPath));
      return true;
    } catch (err) {
      if (err instanceof CommandError) throw err;
      return false;
    }
  }

  return {
    exists,
    handleFor,
    async probe(absPath) {
      const abs = contained(absPath);
      return (await exists(abs)) ? handleFor(abs) : undefined;
    },
    resolveHandle(handle) {
      return contained(handle);
    },
    async readText(absPath) {
      return fs.readFile(contained(absPath), "utf-8");
    },
    async listDirs(absPath) {
      try {
        const entries = await fs.readdir(contained(absPath), { withFileTypes: true });
        return entries
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      } catch (err) {
        if (err instanceof CommandError) throw err;
        return [];
      }
    },
  };
}
