import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CommandError } from "../errors.js";

/** Short filesystem transaction, shared across processes. Never hold during generation. */
export async function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lock = `${path.resolve(file)}.lock`;
  await fs.mkdir(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 10_000;
  let handle;
  let transientPermissionRetries = 0;
  for (;;) {
    try {
      handle = await fs.open(lock, "wx");
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows can report a delete-pending lock as EPERM rather than EEXIST.
      // Retry that narrow open race briefly; genuine permission errors still
      // escape, and the protected action is never retried or run unlocked.
      if (code === "EPERM" && process.platform === "win32" && transientPermissionRetries < 10) {
        transientPermissionRetries++;
        await delay(10);
        continue;
      }
      if (code !== "EEXIST") throw error;
      transientPermissionRetries = 0;
      if (Date.now() >= deadline) {
        throw new CommandError(`Write is busy: ${file}. Retry after the other writer finishes. If it stopped unexpectedly, verify no writer is running before removing ${lock}.`);
      }
      await delay(10);
    }
  }
  try {
    await handle.writeFile(`pid=${process.pid}\n`);
    return await action();
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}

/** Readers see either the previous complete document or the next complete document. */
export async function atomicWriteText(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWriteText(file, JSON.stringify(value, null, 2) + "\n");
}
