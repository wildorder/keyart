import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createSingleDocStore,
  createCollectionStore,
} from "./create-store.js";
import { type Parse } from "./file-store.js";
import type { Versioned } from "./versioned-store.js";

interface Doc extends Versioned {
  value: string;
}

const parse: Parse<Doc> = (raw) => raw as Doc;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-store-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("file driver", () => {
  it("returns a working single-doc store", async () => {
    const filePath = path.join(tmpDir, "doc.yaml");
    const store = createSingleDocStore({ driver: "file", filePath, parse });

    const created = await store.write({ version: 0, value: "a" });
    expect(created).toEqual({ version: 1, value: "a" });
    expect(await store.read()).toEqual({ version: 1, value: "a" });
  });

  it("returns a working collection store", async () => {
    const dir = path.join(tmpDir, "directions");
    const store = createCollectionStore({
      driver: "file",
      dir,
      fileName: "direction.yaml",
      parse,
    });

    await store.write("alpha", { version: 0, value: "a" });
    expect(await store.listKeys()).toEqual(["alpha"]);
    expect(await store.read("alpha")).toEqual({ version: 1, value: "a" });
  });
});
