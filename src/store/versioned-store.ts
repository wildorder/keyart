import { CommandError } from "../errors.js";

/** A persisted document carrying an optimistic-concurrency version counter. */
export interface Versioned {
  version: number; // monotonically increasing; 0 means "never persisted"
}

/** Options accepted by every write. */
export interface WriteOptions {
  /**
   * The version the caller believes is currently persisted. When provided and
   * it does NOT match what is on disk, the write rejects with VersionConflictError
   * (unless `force` is true). Omit on first create (treated as expectedVersion 0).
   */
  expectedVersion?: number;
  /** Bypass the optimistic check and overwrite whatever is there. */
  force?: boolean;
}

/** A store holding exactly ONE document at a fixed location (e.g. brand.yaml). */
export interface SingleDocStore<T extends Versioned> {
  /** Returns the document, or null when it has never been written. Never throws on absence. */
  read(): Promise<T | null>;
  /**
   * Persists `doc`. Enforces optimistic concurrency against the on-disk version,
   * then writes the document with `version` set to (current ?? 0) + 1. Returns the
   * persisted document (with its new version).
   */
  write(doc: T, opts?: WriteOptions): Promise<T>;
}

/** A store holding many documents keyed by string id (e.g. one per concept). */
export interface CollectionStore<T extends Versioned> {
  /** All keys present, sorted ascending (localeCompare). Empty when the collection is absent. */
  listKeys(): Promise<string[]>;
  /** True when a document exists for `key`. */
  has(key: string): Promise<boolean>;
  /** Returns the document for `key`, or null when absent. Never throws on absence. */
  read(key: string): Promise<T | null>;
  /** Persists the document for `key` with the same optimistic-concurrency semantics as SingleDocStore.write. */
  write(key: string, doc: T, opts?: WriteOptions): Promise<T>;
}

/** Thrown when a write's expectedVersion does not match the persisted version. */
export class VersionConflictError extends CommandError {
  readonly expectedVersion: number;
  readonly actualVersion: number;
  constructor(location: string, expectedVersion: number, actualVersion: number) {
    super(
      `Version conflict at ${location}: expected ${expectedVersion}, found ${actualVersion}. ` +
        `Re-read and retry, or force the write.`,
    );
    this.name = "VersionConflictError";
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}
