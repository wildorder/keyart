import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { runDeleteDirectionVersion, withFoundationMutationLock } from "./delete-version.js";
import { createDirectionCore } from "./core.js";
import { versionOrdinal, parseDirectionRecord } from "./schema.js";
import { createBrandCore } from "../brand/core.js";
import { loadConfig, directionsRoot, globalBrandPath } from "../config.js";
import { buildPlaceholderDirections } from "../explore/placeholders.js";
import { writeDirectionVersion } from "../explore/write-direction-version.js";
import { runApprove } from "../commands/approve.js";
import type { KeyartConfig } from "../types.js";

vi.mock("../config.js", async (original) => ({
  ...await original<typeof import("../config.js")>(), loadConfig: vi.fn(),
}));

let cwd: string;
let config: KeyartConfig;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-delete-foundation-"));
  config = { project: { name: "Foundation", type: "test", framework: "none" },
    brand: { root: "brand", references: "brand/references", approved: "brand/approved", rejected: "brand/rejected" },
    models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
    outputs: { cursorRules: ".cursor/rules/brand.mdc", cssVars: "brand/brand.css", implementationBrief: "brand/implementation.md" } };
  vi.mocked(loadConfig).mockResolvedValue(config);
  await createDirectionCore(cwd, config).create({ id: "alpha", name: "Alpha" });
});
afterEach(async () => { vi.useRealTimers(); vi.restoreAllMocks(); await fs.rm(cwd, { recursive: true, force: true }); });

const remove = (versionId: string, expectedVersion?: number) => runDeleteDirectionVersion({ cwd, directionId: "alpha", versionId, expectedVersion });
async function write(id: string) {
  return writeDirectionVersion({ cwd, config, directionsDir: directionsRoot(cwd, config), directionId: "alpha",
    version: { ...buildPlaceholderDirections("Frozen brief")[0], id, createdAt: "2026-10-11T00:00:00Z",
      briefSnapshot: "Frozen brief", contextSnapshot: "Frozen context" }, referenceImagePaths: [], skipImages: true });
}

describe("permanent foundation deletion", () => {
  it("never remints a deleted timestamp identity in the same millisecond", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    const first = await write("");
    await remove(first.versionId);
    const second = await write("");
    expect(second.versionId).toBe(`${first.versionId}-2`);
    expect(versionOrdinal(await createDirectionCore(cwd, config).get("alpha"), second.versionId)).toBe(2);
  });

  it("deletes only the exact version tree, preserves derived outputs/provenance and stable labels", async () => {
    await write("one");
    const removed = await write("two");
    const third = await write("three");
    const core = createDirectionCore(cwd, config);
    const dir = path.dirname(path.dirname(removed.versionDir));
    const derivedFiles = ["boards/hero/revisions/r1/board.png", "boards/hero/revisions/r1/revision.json",
      "extracted-assets/logo/versions/a1/asset.png", "extracted-assets/logo/versions/a1/asset-version.json", "memory.yaml"];
    const before = new Map<string, string>();
    for (const file of derivedFiles) {
      const target = path.join(dir, file);
      if (file !== "memory.yaml") {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, JSON.stringify({ foundation: { directionId: "alpha", versionId: "two" }, data: "preserve" }));
      }
      before.set(file, await fs.readFile(target, "utf8"));
    }
    const original = await fs.readFile(path.join(third.versionDir, "direction-version.json"), "utf8");
    const result = await remove("two");
    expect(result).toMatchObject({ deleted: true, versions: ["one", "three"], head: "three" });
    await expect(fs.access(removed.versionDir)).rejects.toThrow();
    expect(await fs.readFile(path.join(third.versionDir, "direction-version.json"), "utf8")).toBe(original);
    for (const [file, content] of before) expect(await fs.readFile(path.join(dir, file), "utf8")).toBe(content);
    expect(versionOrdinal(await core.get("alpha"), "three")).toBe(3);
    await write("four");
    expect(versionOrdinal(await core.get("alpha"), "four")).toBe(4);
    await expect(write("two")).rejects.toThrow("was deleted");
    await expect(core.appendVersion("alpha", "two")).rejects.toThrow("cannot be reused");
    await expect(fs.access(removed.versionDir)).rejects.toThrow();
  });

  it("recomputes head and permits an empty draft without reusing ordinals", async () => {
    await write("one"); await write("two");
    expect((await remove("two")).head).toBe("one");
    expect((await remove("one")).head).toBeNull();
    await write("three");
    const record = await createDirectionCore(cwd, config).get("alpha");
    expect(record.versions).toEqual(["three"]);
    expect(versionOrdinal(record, "three")).toBe(3);
  });

  it("refuses the approved foundation without changing history, files, or approval", async () => {
    const first = await write("one"); await write("two");
    await createBrandCore(cwd, config).setPointer({ directionId: "alpha", versionId: "one" });
    const pointer = await fs.readFile(globalBrandPath(cwd, config), "utf8");
    const core = createDirectionCore(cwd, config);
    const before = await core.get("alpha");
    await expect(remove("one")).rejects.toThrow("Approve another foundation first");
    expect(await core.get("alpha")).toEqual(before);
    expect(await fs.readFile(globalBrandPath(cwd, config), "utf8")).toBe(pointer);
    await fs.access(first.versionDir);
  });

  it("checks expectedVersion before deletion and fails path escapes closed", async () => {
    const first = await write("one");
    const core = createDirectionCore(cwd, config);
    const record = await core.get("alpha");
    await core.setBriefFields("alpha", { oneLiner: "Changed" });
    await expect(remove("one", record.version)).rejects.toThrow("Version conflict");
    await fs.access(first.versionDir);
    await expect(remove("../one")).rejects.toThrow("Invalid version");
    await expect(remove("unknown")).rejects.toThrow("history");
  });

  it("refuses a junction pointing at a sibling version", async () => {
    const first = await write("one"); const second = await write("two");
    await fs.rm(first.versionDir, { recursive: true });
    await fs.symlink(second.versionDir, first.versionDir, "junction");
    try {
      await expect(remove("one")).rejects.toThrow("symlink, junction");
      await fs.access(path.join(second.versionDir, "direction-version.json"));
      expect((await createDirectionCore(cwd, config).get("alpha")).versions).toEqual(["one", "two"]);
    } finally { await fs.unlink(first.versionDir); }
  });

  it("initializes legacy ordinal history before deleting a middle version", async () => {
    await write("one"); await write("two"); await write("three");
    const file = path.join(directionsRoot(cwd, config), "alpha", "direction.yaml");
    const raw = YAML.parse(await fs.readFile(file, "utf8"));
    delete raw.versionOrdinals;
    await fs.writeFile(file, YAML.stringify(raw));
    await remove("two");
    expect((await createDirectionCore(cwd, config).get("alpha")).versionOrdinals).toEqual({ one: 1, two: 2, three: 3 });
    expect(() => parseDirectionRecord({ ...raw, versionOrdinals: { one: 1, two: 1, three: 3 } })).toThrow("unique");
  });

  it("can retry exact cleanup after interruption without changing history twice", async () => {
    const first = await write("one");
    const originalRm = fs.rm.bind(fs);
    const spy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === first.versionDir) throw new Error("test interruption");
      return originalRm(target, options);
    });
    await expect(remove("one")).rejects.toThrow("Retry the same deletion");
    const record = await createDirectionCore(cwd, config).get("alpha");
    expect(record.versions).toEqual([]);
    await fs.access(first.versionDir);
    spy.mockRestore();
    expect((await remove("one")).filesDeleted).toHaveLength(1);
    expect((await remove("one")).filesDeleted).toEqual([]);
    expect(await createDirectionCore(cwd, config).get("alpha")).toEqual(record);
  });

  it("serializes approval against deletion, so waiting approval cannot publish a removed version", async () => {
    await write("one");
    let approve: ReturnType<typeof runApprove> | undefined;
    await withFoundationMutationLock(cwd, config, async () => {
      approve = runApprove({ cwd, directionId: "alpha", versionId: "one", force: true });
      // Attach rejection immediately while approval waits on our transaction lock.
      void approve.catch(() => {});
      const core = createDirectionCore(cwd, config);
      await core.update("alpha", (record) => ({ ...record, versions: [], head: null }));
    });
    await expect(approve).rejects.toThrow("history");
    expect((await createBrandCore(cwd, config).read()).approvedPointer).toBeNull();
    await expect(fs.access(path.join(cwd, config.brand.approved, "current-direction.json"))).rejects.toThrow();
  });
});
