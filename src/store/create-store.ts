import type {
  Versioned,
  SingleDocStore,
  CollectionStore,
} from "./versioned-store.js";
import {
  createFileSingleDocStore,
  createFileCollectionStore,
  type Parse,
} from "./file-store.js";

/**
 * Storage backend for memory. `file` is the only driver: state lives in the
 * project's working directory, which is also the isolation boundary a hosting
 * layer would partition on (one root per workspace). Alternative backends
 * implement the `VersionedStore` port (`versioned-store.ts`) and compose their
 * own factories — this enum stays honest about what ships.
 */
export type StoreDriver = "file";

export function createSingleDocStore<T extends Versioned>(opts: {
  driver: StoreDriver;
  filePath: string;
  parse: Parse<T>;
}): SingleDocStore<T> {
  switch (opts.driver) {
    case "file":
      return createFileSingleDocStore({
        filePath: opts.filePath,
        parse: opts.parse,
      });
  }
}

export function createCollectionStore<T extends Versioned>(opts: {
  driver: StoreDriver;
  dir: string;
  fileName: string;
  parse: Parse<T>;
}): CollectionStore<T> {
  switch (opts.driver) {
    case "file":
      return createFileCollectionStore({
        dir: opts.dir,
        fileName: opts.fileName,
        parse: opts.parse,
      });
  }
}
