import { describe, it, expect, beforeEach } from "vitest";
import {
  readSelectedDirection,
  writeSelectedDirection,
  clearSelectedDirection,
  resolveInitialDirection,
} from "./selection.js";
import type { SelectionStorage } from "./selection.js";

/** In-memory mock for sessionStorage. */
function makeStorage(): SelectionStorage {
  const store = new Map<string, string>();
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, v); },
    removeItem: (k) => { store.delete(k); },
  };
}

describe("readSelectedDirection", () => {
  it("returns null when nothing is stored", () => {
    expect(readSelectedDirection(makeStorage())).toBeNull();
  });

  it("returns the stored value after a write", () => {
    const s = makeStorage();
    writeSelectedDirection("dir-abc", s);
    expect(readSelectedDirection(s)).toBe("dir-abc");
  });

  it("returns null after clearSelectedDirection", () => {
    const s = makeStorage();
    writeSelectedDirection("dir-abc", s);
    clearSelectedDirection(s);
    expect(readSelectedDirection(s)).toBeNull();
  });

  it("survives a storage.getItem that throws — returns null", () => {
    const throwing: SelectionStorage = {
      getItem: () => { throw new Error("quota"); },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(readSelectedDirection(throwing)).toBeNull();
  });
});

describe("writeSelectedDirection", () => {
  it("silently ignores storage.setItem that throws", () => {
    const throwing: SelectionStorage = {
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
      removeItem: () => {},
    };
    expect(() => writeSelectedDirection("dir-abc", throwing)).not.toThrow();
  });
});

describe("resolveInitialDirection", () => {
  let s: SelectionStorage;
  beforeEach(() => { s = makeStorage(); });

  it("returns null when directionIds is empty", () => {
    expect(resolveInitialDirection([], s)).toBeNull();
  });

  it("returns the last id when nothing is persisted", () => {
    expect(resolveInitialDirection(["a", "b", "c"], s)).toBe("c");
  });

  it("returns the persisted id when it still exists", () => {
    writeSelectedDirection("b", s);
    expect(resolveInitialDirection(["a", "b", "c"], s)).toBe("b");
  });

  it("falls back to last id when persisted id is gone", () => {
    writeSelectedDirection("deleted-id", s);
    expect(resolveInitialDirection(["a", "b", "c"], s)).toBe("c");
  });

  it("falls back to last id when nothing was ever persisted", () => {
    expect(resolveInitialDirection(["x", "y"], s)).toBe("y");
  });
});
