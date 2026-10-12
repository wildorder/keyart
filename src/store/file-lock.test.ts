import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "./file-lock.js";

let directory: string;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-lock-")); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

describe("short filesystem transactions", () => {
  it("serializes independent writers without repeating their actions", async () => {
    let active = 0;
    let completed = 0;
    await Promise.all(Array.from({ length: 20 }, () => withFileLock(path.join(directory, "record.json"), async () => {
      expect(++active).toBe(1);
      await fs.readdir(directory);
      completed++;
      active--;
    })));
    expect(completed).toBe(20);
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it.skipIf(process.platform !== "win32")("retries Windows delete-pending opens, but not persistent permission failures", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EPERM" });
    const open = vi.spyOn(fs, "open").mockRejectedValueOnce(error);
    const action = vi.fn(async () => "done");
    expect(await withFileLock(path.join(directory, "record.json"), action)).toBe("done");
    expect(action).toHaveBeenCalledTimes(1);
    open.mockRejectedValue(error);
    await expect(withFileLock(path.join(directory, "record.json"), action)).rejects.toBe(error);
    expect(action).toHaveBeenCalledTimes(1);
  });
});
