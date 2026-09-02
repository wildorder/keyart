import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createFileSingleDocStore,
  createFileCollectionStore,
  type Parse,
} from "./file-store.js";
import { VersionConflictError } from "./versioned-store.js";
import type { Versioned } from "./versioned-store.js";
import { CommandError } from "../errors.js";

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

describe("createFileSingleDocStore", () => {
  it("creates then reads back a versioned document", async () => {
    const filePath = path.join(tmpDir, "doc.yaml");
    const store = createFileSingleDocStore({ filePath, parse });

    expect(await store.read()).toBeNull();

    const created = await store.write({ version: 0, value: "a" });
    expect(created).toEqual({ version: 1, value: "a" });

    // The file exists on disk as YAML.
    const onDisk = await fs.readFile(filePath, "utf-8");
    expect(onDisk).toContain("value: a");
    expect(onDisk).toContain("version: 1");

    // A fresh store at the same path reads it back.
    const fresh = createFileSingleDocStore({ filePath, parse });
    expect(await fresh.read()).toEqual({ version: 1, value: "a" });
  });

  it("increments version and enforces the optimistic guard", async () => {
    const filePath = path.join(tmpDir, "doc.yaml");
    const store = createFileSingleDocStore({ filePath, parse });

    await store.write({ version: 0, value: "a" }); // version 1

    const v2 = await store.write(
      { version: 1, value: "b" },
      { expectedVersion: 1 },
    );
    expect(v2.version).toBe(2);

    await expect(
      store.write({ version: 1, value: "c" }, { expectedVersion: 1 }),
    ).rejects.toMatchObject({
      name: "VersionConflictError",
      expectedVersion: 1,
      actualVersion: 2,
    });

    const forced = await store.write({ version: 0, value: "d" }, { force: true });
    expect(forced.version).toBe(3);
  });

  it("accepts expectedVersion 0 and undefined for a create", async () => {
    const a = path.join(tmpDir, "a.yaml");
    const b = path.join(tmpDir, "b.yaml");

    const withZero = await createFileSingleDocStore({ filePath: a, parse }).write(
      { version: 0, value: "x" },
      { expectedVersion: 0 },
    );
    expect(withZero.version).toBe(1);

    const withNothing = await createFileSingleDocStore({
      filePath: b,
      parse,
    }).write({ version: 0, value: "y" });
    expect(withNothing.version).toBe(1);
  });

  it("surfaces a corrupt file as a CommandError naming the path", async () => {
    const filePath = path.join(tmpDir, "doc.yaml");
    await fs.writeFile(filePath, "{ : not yaml", "utf-8");
    const store = createFileSingleDocStore({ filePath, parse });

    await expect(store.read()).rejects.toBeInstanceOf(CommandError);
    await expect(store.read()).rejects.toThrow(filePath);
  });

  it("surfaces a parse rejection as a CommandError (not a silent null)", async () => {
    const filePath = path.join(tmpDir, "doc.yaml");
    await fs.writeFile(filePath, "value: ok\n", "utf-8");
    const strict: Parse<Doc> = () => {
      throw new Error("schema rejected");
    };
    const store = createFileSingleDocStore({ filePath, parse: strict });

    await expect(store.read()).rejects.toBeInstanceOf(CommandError);
    await expect(store.read()).rejects.toThrow(filePath);
  });
});

describe("createFileCollectionStore", () => {
  it("lists only directories containing the document, sorted", async () => {
    const dir = path.join(tmpDir, "directions");
    const store = createFileCollectionStore({
      dir,
      fileName: "direction.yaml",
      parse,
    });

    expect(await store.listKeys()).toEqual([]);

    await store.write("beta", { version: 0, value: "b" });
    await store.write("alpha", { version: 0, value: "a" });

    // A stray file and an empty dir lacking the document must be excluded.
    await fs.writeFile(path.join(dir, "notes.txt"), "hi", "utf-8");
    await fs.mkdir(path.join(dir, "ghost"), { recursive: true });

    expect(await store.listKeys()).toEqual(["alpha", "beta"]);
    expect(await store.has("alpha")).toBe(true);
    expect(await store.has("ghost")).toBe(false);
  });

  it("keeps per-key versions isolated", async () => {
    const dir = path.join(tmpDir, "directions");
    const store = createFileCollectionStore({
      dir,
      fileName: "direction.yaml",
      parse,
    });

    await store.write("a", { version: 0, value: "a1" }); // a -> 1
    await store.write("a", { version: 1, value: "a2" }, { expectedVersion: 1 }); // a -> 2
    await store.write("b", { version: 0, value: "b1" }); // b -> 1

    expect((await store.read("a"))?.version).toBe(2);
    expect((await store.read("b"))?.version).toBe(1);

    // Conflict on `a` does not affect `b`.
    await expect(
      store.write("a", { version: 0, value: "x" }, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect((await store.read("b"))?.version).toBe(1);

    expect(await store.read("missing")).toBeNull();
  });
});
