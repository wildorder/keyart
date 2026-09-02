import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  writeIfAbsent,
  readTextFile,
  pathExists,
  ensureDir,
  writeTextFile,
  writeJsonFile,
  writeWithConfirm,
} from "./fs.js";

describe("fs helpers", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writeIfAbsent writes the file on first call", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    const written = await writeIfAbsent(filePath, "hello");
    expect(written).toBe(true);
    expect(await readTextFile(filePath)).toBe("hello");
  });

  it("writeIfAbsent does not overwrite on second call", async () => {
    const filePath = path.join(tmpDir, "test.txt");
    await writeIfAbsent(filePath, "first");
    const written = await writeIfAbsent(filePath, "second");
    expect(written).toBe(false);
    expect(await readTextFile(filePath)).toBe("first");
  });

  it("pathExists returns false for missing files", async () => {
    expect(await pathExists(path.join(tmpDir, "nope.txt"))).toBe(false);
  });

  it("ensureDir creates nested directories", async () => {
    const nested = path.join(tmpDir, "a", "b", "c");
    await ensureDir(nested);
    const stat = await fs.stat(nested);
    expect(stat.isDirectory()).toBe(true);
  });

  it("writeTextFile creates parent directories automatically", async () => {
    const filePath = path.join(tmpDir, "deep", "nested", "file.txt");
    await writeTextFile(filePath, "content");
    expect(await readTextFile(filePath)).toBe("content");
  });

  it("writeJsonFile writes formatted JSON with trailing newline", async () => {
    const filePath = path.join(tmpDir, "data.json");
    const data = { name: "test", items: [1, 2, 3] };
    await writeJsonFile(filePath, data);
    const raw = await readTextFile(filePath);
    expect(raw).toBe(JSON.stringify(data, null, 2) + "\n");
    expect(JSON.parse(raw)).toEqual(data);
  });

  it("writeWithConfirm skips existing file without force", async () => {
    const filePath = path.join(tmpDir, "guarded.txt");
    await writeTextFile(filePath, "original");
    const wrote = await writeWithConfirm(filePath, "new content");
    expect(wrote).toBe(false);
    expect(await readTextFile(filePath)).toBe("original");
  });

  it("writeWithConfirm overwrites with force", async () => {
    const filePath = path.join(tmpDir, "guarded.txt");
    await writeTextFile(filePath, "original");
    const wrote = await writeWithConfirm(filePath, "new content", {
      force: true,
    });
    expect(wrote).toBe(true);
    expect(await readTextFile(filePath)).toBe("new content");
  });

  it("pathExists returns true for existing file", async () => {
    const filePath = path.join(tmpDir, "exists.txt");
    await writeTextFile(filePath, "hi");
    expect(await pathExists(filePath)).toBe(true);
  });

  it("pathExists returns true for existing directory", async () => {
    const dirPath = path.join(tmpDir, "subdir");
    await ensureDir(dirPath);
    expect(await pathExists(dirPath)).toBe(true);
  });

  it("ensureDir is idempotent", async () => {
    const nested = path.join(tmpDir, "x", "y");
    await ensureDir(nested);
    await ensureDir(nested); // should not throw
    const stat = await fs.stat(nested);
    expect(stat.isDirectory()).toBe(true);
  });
});
