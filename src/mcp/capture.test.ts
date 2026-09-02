import { describe, it, expect, vi, afterEach } from "vitest";
import { captureCommandOutput } from "./capture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("captureCommandOutput", () => {
  it("buffers console.* and process.stdout.write; nothing reaches real stdout", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const result = await captureCommandOutput(async () => {
      console.log("a");
      console.warn("b");
      process.stdout.write("c");
      return 42;
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(42);
      expect(result.output).toContain("a");
      expect(result.output).toContain("b");
      expect(result.output).toContain("c");
    }
    // The real stdout spy must not have received anything during capture
    // (process.stdout.write was patched over the top of it).
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("restores console.log and process.stdout.write on success", async () => {
    const preLog = console.log;
    const preWrite = process.stdout.write;

    await captureCommandOutput(async () => {
      console.log("x");
      return undefined;
    });

    expect(console.log).toBe(preLog);
    expect(process.stdout.write).toBe(preWrite);
  });

  it("restores console.log and process.stdout.write on error", async () => {
    const preLog = console.log;
    const preWrite = process.stdout.write;

    await captureCommandOutput(async () => {
      throw new Error("boom");
    });

    expect(console.log).toBe(preLog);
    expect(process.stdout.write).toBe(preWrite);
  });

  it("captures output before a throw and does not reject", async () => {
    const result = await captureCommandOutput(async () => {
      console.log("before throw");
      throw new Error("kaboom");
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.output).toContain("before throw");
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe("kaboom");
    }
  });

  it("serializes overlapping captures without cross-contamination", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstPromise = captureCommandOutput(async () => {
      console.log("first-1");
      await firstGate;
      console.log("first-2");
      return "first";
    });

    // Start the second capture before the first's fn resolves.
    const secondPromise = captureCommandOutput(async () => {
      console.log("second-1");
      return "second";
    });

    // Let the first capture finish; the second is queued behind the mutex.
    releaseFirst();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.output).toContain("first-1");
      expect(first.output).toContain("first-2");
      expect(first.output).not.toContain("second-1");

      expect(second.output).toContain("second-1");
      expect(second.output).not.toContain("first-1");
      expect(second.output).not.toContain("first-2");
    }
  });
});
