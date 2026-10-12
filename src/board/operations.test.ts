import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";

vi.mock("../config.js", async (original) => ({ ...await original<typeof import("../config.js")>(), loadConfig: vi.fn() }));
vi.mock("../openai.js", async (original) => ({ ...await original<typeof import("../openai.js")>(), hasApiKey: vi.fn(), generateImage: vi.fn() }));
import { loadConfig, directionsRoot } from "../config.js";
import { hasApiKey, generateImage } from "../openai.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { buildPlaceholderDirections } from "../explore/placeholders.js";
import { writeDirectionVersion } from "../explore/write-direction-version.js";
import { atomicWriteJson } from "../store/file-lock.js";
import { runBoardCreate, runBoardRevise, runBoardUpdate, resolveBoardRevisionInputs, captureBoardUpdate } from "./operations.js";
import { readBoardIndex, readBoardRevision, listBoardRevisions, retireBoard, listBoards, boardBatchFile, readBoardBatch, selectBoardRevision, resolveBoardImage, finishBoardRevision } from "./board-store.js";

let cwd: string;
let dir: string;
let config: KeyartConfig;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-board-"));
  config = { project: { name: "Boards", type: "test", framework: "none" },
    brand: { root: "brand", references: "brand/references", approved: "brand/approved", rejected: "brand/rejected" },
    models: { text: "mock", vision: "mock", image: "mock" },
    outputs: { cursorRules: ".cursor/rules", cssVars: "brand/brand.css", implementationBrief: "brand/implementation.md" } };
  vi.mocked(loadConfig).mockResolvedValue(config);
  vi.mocked(hasApiKey).mockReturnValue(true);
  vi.mocked(generateImage).mockReset().mockImplementation(async ({ outPath }) => {
    await fs.writeFile(outPath, "image"); return { written: true, dryRun: false };
  });
  await createDirectionCore(cwd, config).create({ id: "alpha", name: "Alpha" });
  dir = path.join(directionsRoot(cwd, config), "alpha");
  await foundation("v1");
});
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });
async function foundation(id: string, tile = true) {
  const written = await writeDirectionVersion({ cwd, config, directionsDir: directionsRoot(cwd, config), directionId: "alpha",
    version: { ...buildPlaceholderDirections("Original foundation")[0], id, createdAt: new Date().toISOString(),
      briefSnapshot: `Frozen brief ${id}`, contextSnapshot: "Old snapshot" }, referenceImagePaths: [], skipImages: true });
  if (tile) await fs.writeFile(path.join(written.versionDir, "style-tile.png"), `tile ${id}`);
}
function create(name = "Instagram") { return runBoardCreate({ cwd, directionId: "alpha", versionId: "v1", name, describe: "An editorial social campaign" }); }

describe("Board history and captured updates", () => {
  it("pins independent source and foundation, current signals and durable local intent without changing history", async () => {
    const first = await create();
    const prior = await readBoardRevision(dir, first.boardId, first.revisionId);
    await foundation("v2");
    await createDirectionCore(cwd, config).setBriefFields("alpha", { oneLiner: "Live draft is not authority" });
    await createBrandCore(cwd, config).addRule({ text: "Never include stock photography", severity: "hard", author: "test", source: "test", channel: "visual" });
    const second = await runBoardRevise({ cwd, directionId: "alpha", boardId: first.boardId, revisionId: first.revisionId, tweak: "Use generous whitespace" });
    const call = vi.mocked(generateImage).mock.calls.at(-1)![0];
    expect(call.referenceImagePaths).toEqual([path.join(dir, "versions/v2/style-tile.png"), path.join(dir, prior.files.image!)]);
    expect(call.prompt).toContain("Frozen brief v2");
    expect(call.prompt).not.toContain("Live draft is not authority");
    expect(call.prompt).toContain("Never include stock photography");
    const third = await runBoardRevise({ cwd, directionId: "alpha", boardId: first.boardId, versionId: "v1", revisionId: first.revisionId });
    expect((await readBoardRevision(dir, third.boardId, third.revisionId)).instructions).toContain("Use generous whitespace");
    expect(await readBoardRevision(dir, first.boardId, first.revisionId)).toEqual(prior);
    expect(selectBoardRevision(await listBoardRevisions(dir, first.boardId), "v2")?.id).toBe(second.revisionId);
    await expect(finishBoardRevision(dir, prior)).rejects.toThrow("immutable");
  });

  it("keeps dry-run/missing-tile/failure attempts inspectable without advancing the completed head", async () => {
    vi.mocked(hasApiKey).mockReturnValue(false);
    const first = await create();
    expect(first.status).toBe("pending");
    expect((await readBoardIndex(dir, first.boardId)).head).toBeNull();
    expect(await fs.readFile(path.join(cwd, first.filesWritten.find((f) => f.endsWith("board-prompt.md"))!), "utf8")).toContain("editorial");
    vi.mocked(hasApiKey).mockReturnValue(true);
    await foundation("v2", false);
    expect((await runBoardRevise({ cwd, directionId: "alpha", boardId: first.boardId })).status).toBe("pending");
    expect(generateImage).not.toHaveBeenCalled();
    const success = await runBoardRevise({ cwd, directionId: "alpha", boardId: first.boardId, versionId: "v1" });
    vi.mocked(generateImage).mockRejectedValueOnce(new Error("Injected failure"));
    expect((await runBoardRevise({ cwd, directionId: "alpha", boardId: first.boardId, versionId: "v1" })).status).toBe("failed");
    expect((await readBoardIndex(dir, first.boardId)).head).toBe(success.revisionId);
  });

  it("collision-safe creation and instruction CAS prevent concurrent loss or stale confirmed requests", async () => {
    const [a, b] = await Promise.all([create(), create()]);
    expect(a.boardId).not.toBe(b.boardId);
    const pinned = await resolveBoardRevisionInputs({ cwd, directionId: "alpha", boardId: a.boardId });
    await runBoardRevise({ cwd, ...pinned, tweak: "Use a compact layout" });
    await expect(runBoardRevise({ cwd, ...pinned, tweak: "Use a broad layout" })).rejects.toThrow("Version conflict");
    const fresh = await resolveBoardRevisionInputs({ cwd, directionId: "alpha", boardId: a.boardId });
    const results = await Promise.allSettled([
      runBoardRevise({ cwd, ...fresh, tweak: "More whitespace" }),
      runBoardRevise({ cwd, ...fresh, tweak: "Less whitespace" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("captures active set, resumes partial outcomes, and reconciles a success persisted before its batch entry", async () => {
    const a = await create("A"); const b = await create("B"); const retired = await create("Retired");
    await retireBoard(dir, retired.boardId);
    await foundation("v2");
    vi.mocked(generateImage).mockResolvedValueOnce({ written: false, dryRun: false, skippedReason: "service down" });
    const batch = await runBoardUpdate({ cwd, directionId: "alpha", versionId: "v2" });
    expect(batch.entries.map((e) => e.boardId)).toEqual([a.boardId, b.boardId]);
    expect(batch.status).toBe("partial");
    const before = (await listBoardRevisions(dir, b.boardId)).length;
    // Simulate interruption after the successful revision record but before its manifest result.
    const stored = await readBoardBatch(dir, batch.batchId);
    stored.entries[1].status = "pending";
    delete stored.entries[1].revisionId;
    await atomicWriteJson(boardBatchFile(dir, batch.batchId), stored);
    const staleIndex = await readBoardIndex(dir, b.boardId);
    const completedId = staleIndex.head;
    await atomicWriteJson(path.join(dir, "boards", b.boardId, "board.json"), { ...staleIndex, head: b.revisionId });
    await create("Later Board");
    vi.mocked(generateImage).mockClear();
    const resumed = await runBoardUpdate({ cwd, directionId: "alpha", resume: batch.batchId });
    expect(resumed.status).toBe("completed");
    expect(resumed.entries).toHaveLength(2);
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect((await listBoardRevisions(dir, b.boardId)).length).toBe(before);
    expect((await readBoardIndex(dir, b.boardId)).head).toBe(completedId);
    const after = await readBoardIndex(dir, b.boardId);
    await runBoardUpdate({ cwd, directionId: "alpha", resume: batch.batchId });
    expect(await readBoardIndex(dir, b.boardId)).toEqual(after);
    expect(generateImage).toHaveBeenCalledTimes(1);
  });

  it("reports captured instruction conflicts and later retirement without silently changing the batch", async () => {
    const a = await create("A"); const b = await create("B");
    const captured = await captureBoardUpdate({ cwd, directionId: "alpha", versionId: "v1" });
    await runBoardRevise({ cwd, directionId: "alpha", boardId: a.boardId, tweak: "Use a quieter layout" });
    await retireBoard(dir, b.boardId);
    vi.mocked(generateImage).mockClear();
    const batch = await runBoardUpdate({ cwd, directionId: "alpha", versionId: "v1", captured: captured.entries });
    expect(batch.entries.every((e) => e.status === "failed")).toBe(true);
    expect(batch.entries[0].error).toContain("instructions changed");
    expect(batch.entries[1].error).toContain("retired");
    expect(generateImage).not.toHaveBeenCalled();
    expect(await retireBoard(dir, b.boardId)).toEqual(await readBoardIndex(dir, b.boardId));
    expect((await listBoards(dir)).map((e) => e.id)).toEqual([a.boardId]);
  });

  it("rejects paths, foreign sources and unsupported records without mutation", async () => {
    const a = await create();
    for (const id of ["../alpha", "..\\alpha", "C:\\outside"]) {
      await expect(readBoardIndex(dir, id)).rejects.toThrow("Invalid Board");
    }
    const b = await create("B");
    await expect(runBoardRevise({ cwd, directionId: "alpha", boardId: b.boardId, revisionId: a.revisionId })).rejects.toThrow("not found");
    const file = path.join(dir, "boards", a.boardId, "board.json");
    const legacy = JSON.stringify({ id: a.boardId, name: "Old record" });
    await fs.writeFile(file, legacy);
    await expect(readBoardIndex(dir, a.boardId)).rejects.toThrow("migration");
    expect(await fs.readFile(file, "utf8")).toBe(legacy);
  });

  it("requires truthful conditioning metadata and preserves explicitly migrated artwork on reads", async () => {
    const result = await create();
    const revision = await readBoardRevision(dir, result.boardId, result.revisionId);
    expect(revision.conditioning).toBe("foundation");
    const file = path.join(dir, "boards", result.boardId, "revisions", result.revisionId, "board-revision.json");
    await atomicWriteJson(file, { ...revision, conditioning: "legacy-unverified" });
    const migrated = await fs.readFile(file, "utf8");
    expect((await readBoardRevision(dir, result.boardId, result.revisionId)).conditioning).toBe("legacy-unverified");
    expect((await resolveBoardImage(dir, result.boardId, result.revisionId)).imagePath).toBe(path.join(dir, revision.files.image!));
    expect(await fs.readFile(file, "utf8")).toBe(migrated);
    const { conditioning: _conditioning, ...unsupported } = revision;
    await atomicWriteJson(file, unsupported);
    const before = await fs.readFile(file, "utf8");
    await expect(readBoardRevision(dir, result.boardId, result.revisionId)).rejects.toThrow("migration");
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });

  it("rejects symlink escapes and modified artifact paths", async () => {
    const a = await create();
    const revision = await readBoardRevision(dir, a.boardId, a.revisionId);
    const file = path.join(dir, "boards", a.boardId, "revisions", a.revisionId, "board-revision.json");
    await atomicWriteJson(file, { ...revision, files: { ...revision.files, image: "../../private.png" } });
    await expect(resolveBoardImage(dir, a.boardId, a.revisionId)).rejects.toThrow("path");
    const other = path.join(cwd, "other"); await fs.mkdir(other);
    const link = path.join(dir, "boards", "outside");
    await fs.symlink(other, link, "junction");
    await expect(readBoardIndex(dir, "outside")).rejects.toThrow("escapes");
  });
});
