import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createArtifactStore } from "./artifact-store.js";
import { CommandError } from "../errors.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-artifacts-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("createArtifactStore", () => {
  it("probe returns a forward-slash handle for an existing artifact, undefined otherwise", async () => {
    const store = createArtifactStore(tmpDir);
    const abs = path.join(tmpDir, "brand", "guides", "style-board.svg");
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "<svg/>");

    expect(await store.probe(abs)).toBe("brand/guides/style-board.svg");
    expect(await store.probe(path.join(tmpDir, "missing.png"))).toBeUndefined();
  });

  it("handleFor/resolveHandle round-trip", async () => {
    const store = createArtifactStore(tmpDir);
    const abs = path.join(tmpDir, "brand", "audits", "a1", "screenshot.png");

    const handle = store.handleFor(abs);
    expect(handle).toBe("brand/audits/a1/screenshot.png");
    expect(store.resolveHandle(handle)).toBe(path.resolve(abs));
  });

  it("rejects any path or handle that escapes the root with a 403 CommandError", async () => {
    const store = createArtifactStore(tmpDir);
    const outside = path.join(tmpDir, "..", "evil.png");

    for (const fn of [
      () => store.handleFor(outside),
      () => store.resolveHandle("../evil.png"),
      () => store.resolveHandle(path.resolve(tmpDir, "..", "evil.png")),
    ]) {
      try {
        fn();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(CommandError);
        expect((err as CommandError).exitCode).toBe(403);
      }
    }
    await expect(store.exists(outside)).rejects.toBeInstanceOf(CommandError);
    await expect(store.probe(outside)).rejects.toBeInstanceOf(CommandError);
    await expect(store.readText(outside)).rejects.toBeInstanceOf(CommandError);
    await expect(store.listDirs(outside)).rejects.toBeInstanceOf(CommandError);
  });

  it("rejects a sibling directory sharing the root's name as a prefix", () => {
    // `C:\proj-evil` must not pass a `C:\proj` containment check.
    const store = createArtifactStore(tmpDir);
    expect(() => store.handleFor(`${tmpDir}-evil${path.sep}x.png`)).toThrow(CommandError);
  });

  it("readText returns contents and rejects on a missing file", async () => {
    const store = createArtifactStore(tmpDir);
    const abs = path.join(tmpDir, "guide.md");
    await fs.writeFile(abs, "# hi");

    expect(await store.readText(abs)).toBe("# hi");
    await expect(store.readText(path.join(tmpDir, "nope.md"))).rejects.toThrow();
  });

  it("listDirs returns sorted subdirectory names and [] for a missing directory", async () => {
    const store = createArtifactStore(tmpDir);
    const audits = path.join(tmpDir, "audits");
    await fs.mkdir(path.join(audits, "b"), { recursive: true });
    await fs.mkdir(path.join(audits, "a"), { recursive: true });
    await fs.writeFile(path.join(audits, "not-a-dir.txt"), "x");

    expect(await store.listDirs(audits)).toEqual(["a", "b"]);
    expect(await store.listDirs(path.join(tmpDir, "missing"))).toEqual([]);
  });
});
