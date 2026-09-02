import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { readTextFile, writeTextFile, pathExists } from "../fs.js";
import { CommandError } from "../errors.js";
import type {
  Versioned,
  WriteOptions,
  SingleDocStore,
  CollectionStore,
} from "./versioned-store.js";
import { VersionConflictError } from "./versioned-store.js";

/** A pure validator/normalizer applied to every read (typically `schema.parse`). */
export type Parse<T> = (raw: unknown) => T;

/**
 * Reads a single YAML document at `filePath`.
 * - Genuine absence → `null` (never throws).
 * - Present-but-corrupt (malformed YAML or `parse` rejects) → `CommandError`
 *   naming the path. Absence and corruption are deliberately distinguished.
 */
async function readDoc<T extends Versioned>(
  filePath: string,
  parse: Parse<T>,
): Promise<T | null> {
  if (!(await pathExists(filePath))) {
    return null;
  }

  let text: string;
  try {
    text = await readTextFile(filePath);
  } catch (err) {
    // The file existed a moment ago; a read failure is not mere absence.
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Failed to read ${filePath}: ${message}`);
  }

  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Malformed YAML in ${filePath}: ${message}`);
  }

  try {
    return parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CommandError(`Invalid document in ${filePath}: ${message}`);
  }
}

/**
 * Writes `doc` to `filePath`, enforcing the optimistic-concurrency versioning
 * contract against whatever is currently on disk. Returns the persisted doc
 * (with its newly-assigned `version`).
 */
async function writeDoc<T extends Versioned>(
  filePath: string,
  doc: T,
  parse: Parse<T>,
  opts: WriteOptions | undefined,
): Promise<T> {
  const current = await readDoc(filePath, parse);
  const currentVersion = current?.version ?? 0;

  if (!opts?.force) {
    const expected = opts?.expectedVersion ?? 0;
    if (expected !== currentVersion) {
      throw new VersionConflictError(filePath, expected, currentVersion);
    }
  }

  const persisted: T = { ...doc, version: currentVersion + 1 };
  let serialized = YAML.stringify(persisted);
  if (!serialized.endsWith("\n")) {
    serialized += "\n";
  }
  await writeTextFile(filePath, serialized);
  return persisted;
}

export function createFileSingleDocStore<T extends Versioned>(opts: {
  filePath: string;
  parse: Parse<T>;
}): SingleDocStore<T> {
  const { filePath, parse } = opts;
  return {
    read() {
      return readDoc(filePath, parse);
    },
    write(doc, writeOpts) {
      return writeDoc(filePath, doc, parse, writeOpts);
    },
  };
}

export function createFileCollectionStore<T extends Versioned>(opts: {
  dir: string;
  fileName: string;
  parse: Parse<T>;
}): CollectionStore<T> {
  const { dir, fileName, parse } = opts;

  const keyFile = (key: string): string => path.join(dir, key, fileName);

  return {
    async listKeys() {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return [];
      }

      const keys: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (await pathExists(keyFile(entry.name))) {
          keys.push(entry.name);
        }
      }
      keys.sort((a, b) => a.localeCompare(b));
      return keys;
    },

    has(key) {
      return pathExists(keyFile(key));
    },

    read(key) {
      return readDoc(keyFile(key), parse);
    },

    write(key, doc, writeOpts) {
      return writeDoc(keyFile(key), doc, parse, writeOpts);
    },
  };
}
