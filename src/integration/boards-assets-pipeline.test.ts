import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { KeyartConfig } from "../types.js";

vi.mock("../config.js", async (original) => ({
  ...await original<typeof import("../config.js")>(), loadConfig: vi.fn(),
}));
vi.mock("../openai.js", async (original) => ({
  ...await original<typeof import("../openai.js")>(),
  hasApiKey: vi.fn(() => false), generateImage: vi.fn(),
}));
import { loadConfig, directionsRoot } from "../config.js";
import { hasApiKey, generateImage } from "../openai.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { buildPlaceholderDirections } from "../explore/placeholders.js";
import { writeDirectionVersion } from "../explore/write-direction-version.js";
import { runBoardCreate, runBoardRevise, runBoardUpdate } from "../board/operations.js";
import { readBoardIndex, readBoardRevision, retireBoard } from "../board/board-store.js";
import { runAssetGenerate, runAssetExtract } from "../asset/extract.js";
import { readAssetIndex, readAssetVersion } from "../asset/asset-store.js";
import { runApprove } from "../commands/approve.js";
import { createBoardApi } from "../ui/board-api.js";
import { createLocalOnlyGuard, createAssetActionsApi } from "../ui/server-api.js";
import { createRequestListener } from "../ui/static-server.js";
import { createJobStore } from "../ui/jobs.js";
import { pinGenerationArguments } from "../agent/pin-generation.js";

let cwd: string;
let config: KeyartConfig;
let directionDir: string;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-boards-assets-"));
  config = {
    project: { name: "Board workflow", type: "prototype", framework: "none" },
    brand: { root: "brand", references: "brand/references", approved: "brand/approved", rejected: "brand/rejected" },
    models: { text: "mock", vision: "mock", image: "mock" },
    outputs: { cursorRules: ".cursor/rules/brand.mdc", cssVars: "brand/generated/brand.css", implementationBrief: "brand/generated/implementation.md" },
  };
  vi.mocked(loadConfig).mockResolvedValue(config);
  vi.mocked(hasApiKey).mockReturnValue(false);
  vi.mocked(generateImage).mockReset();
  await createDirectionCore(cwd, config).create({ id: "alpha", name: "Alpha" });
  directionDir = path.join(directionsRoot(cwd, config), "alpha");
});
afterEach(async () => { await fs.rm(cwd, { recursive: true, force: true }); });

async function foundation(id: string, brief: string, tile = true): Promise<string> {
  const written = await writeDirectionVersion({ cwd, config,
    directionsDir: directionsRoot(cwd, config), directionId: "alpha",
    version: { ...buildPlaceholderDirections(brief)[0], id,
      createdAt: new Date().toISOString(), briefSnapshot: brief, contextSnapshot: "Frozen context" },
    referenceImagePaths: [], skipImages: true,
  });
  const tilePath = path.join(written.versionDir, "style-tile.png");
  if (tile) await fs.writeFile(tilePath, "fixture tile");
  return tilePath;
}

function enableImages(): void {
  vi.mocked(hasApiKey).mockReturnValue(true);
  vi.mocked(generateImage).mockImplementation(async ({ outPath }) => {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, "fixture image");
    return { written: true, dryRun: false };
  });
}

async function snapshot(dir: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      for (const [key, value] of Object.entries(await snapshot(file))) result[`${entry.name}/${key}`] = value;
    } else result[entry.name] = (await fs.readFile(file)).toString("base64");
  }
  return result;
}

describe("boards and assets: deliberate foundation changes", () => {
  it("clears stale approved image projections when the next foundation has no tile", async () => {
    const originalTile = await foundation("v1", "Rendered foundation");
    await runApprove({ cwd, directionId: "alpha", versionId: "v1" });
    const projection = path.join(cwd, "brand", "approved", "style-tile.png");
    expect(await fs.readFile(projection, "utf8")).toBe("fixture tile");
    await foundation("v2", "Pending foundation", false);
    await runApprove({ cwd, directionId: "alpha", versionId: "v2" });
    await expect(fs.access(projection)).rejects.toThrow();
    expect(await fs.readFile(originalTile, "utf8")).toBe("fixture tile");
    expect((await createBrandCore(cwd, config).read()).approvedPointer?.versionId).toBe("v2");
  });

  it("rejects unsupported asset history before approval changes any source or output", async () => {
    await foundation("v1", "Original foundation");
    enableImages();
    const asset = await runAssetGenerate({ cwd, directionId: "alpha", versionId: "v1", name: "Bird", describe: "A bird mascot" });
    await runApprove({ cwd, directionId: "alpha", versionId: "v1" });
    await foundation("v2", "Next foundation");
    const file = path.join(directionDir, "extracted-assets", asset.assetId, "versions", asset.versionId, "asset-version.json");
    const unsupported = JSON.parse(await fs.readFile(file, "utf8"));
    delete unsupported.conditioning;
    await fs.writeFile(file, JSON.stringify(unsupported));
    const before = await snapshot(path.join(cwd, "brand"));
    await expect(runApprove({ cwd, directionId: "alpha", versionId: "v2" })).rejects.toThrow(/Unsupported|convert/);
    expect(await snapshot(path.join(cwd, "brand"))).toEqual(before);
    expect((await createBrandCore(cwd, config).read()).approvedPointer?.versionId).toBe("v1");
  });

  it("pins independent Board source/target and exact batch membership before confirmation", async () => {
    await foundation("v1", "First foundation");
    enableImages();
    const created = await runBoardCreate({ cwd, directionId: "alpha", versionId: "v1", name: "Poster", describe: "Event poster" });
    await foundation("v2", "Second foundation");
    const focus = { directionId: "alpha", versionId: "v1", boardId: created.boardId, revisionId: created.revisionId };
    const pinned = await pinGenerationArguments(cwd, "board_revise", {}, focus);
    expect(pinned.version).toBe("v2");
    expect(pinned.revision).toBe(created.revisionId);
    const old = await pinGenerationArguments(cwd, "board_revise", { version: "v1" }, focus);
    expect(old.version).toBe("v1");
    const update = await pinGenerationArguments(cwd, "board_update", { version: "v2" }, focus);
    await foundation("v3", "Later head");
    await runBoardCreate({ cwd, directionId: "alpha", versionId: "v3", name: "Later Board", describe: "New campaign" });
    const result = await runBoardUpdate({ cwd, directionId: "alpha", versionId: String(update.version), captured: JSON.parse(String(update.captured)) });
    expect(result.foundation.versionId).toBe("v2");
    expect(result.entries.map((entry) => entry.boardId)).toEqual([created.boardId]);
    expect(pinned.version).toBe("v2");
    expect(await pinGenerationArguments(cwd, "asset_extract", { describe: "A motif" }, focus)).toMatchObject({ board: created.boardId, revision: created.revisionId, version: "v1" });
    const generated = await runAssetGenerate({ cwd, directionId: "alpha", versionId: "v1", describe: "Bird" });
    expect(await pinGenerationArguments(cwd, "asset_revise", { assetId: generated.assetId }, { directionId: "alpha", versionId: "v3" })).toMatchObject({ revision: generated.versionId, targetFoundation: "v1" });
    await expect(pinGenerationArguments(cwd, "asset_generate", {}, { directionId: "alpha" })).rejects.toThrow("explicit foundation");
  });

  it("serves guarded, pinned Board actions and rejects stale instruction captures", async () => {
    await foundation("v1", "First foundation");
    const jobs = createJobStore();
    const server = http.createServer(createRequestListener([
      { prefix: "/api", handler: createLocalOnlyGuard() },
      { prefix: "/api", handler: createBoardApi({ cwd, jobs }) },
      { prefix: "/api", handler: createAssetActionsApi({ cwd, jobs }) },
    ]));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (route: string, body: unknown, origin?: string) => fetch(base + route, {
      method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
    });
    try {
      const input = { directionId: "alpha", versionId: "v1", name: "Poster", describe: "An event poster" };
      expect((await post("/api/actions/board-create", input, "https://hostile.example")).status).toBe(403);
      expect(jobs.list()).toHaveLength(0);
      expect((await post("/api/actions/board-create", { ...input, versionId: "../v1" })).status).toBe(400);
      const response = await post("/api/actions/board-create", input);
      expect(response.status).toBe(202);
      const { jobId } = await response.json() as { jobId: string };
      await vi.waitFor(() => expect(jobs.get(jobId)?.status).toBe("succeeded"));
      const result = jobs.get(jobId)!.result as { boardId: string; status: string };
      expect(result.status).toBe("pending");
      const prepared = await (await fetch(`${base}/api/boards/prepare?mode=revise&directionId=alpha&boardId=${result.boardId}`)).json();
      const revise = { directionId: "alpha", boardId: result.boardId, versionId: prepared.versionId,
        revisionId: prepared.revisionId, expectedInstructionVersion: prepared.expectedInstructionVersion, tweak: "Wide margins" };
      const accepted = await post("/api/actions/board-revise", revise);
      expect(accepted.status).toBe(202);
      const second = await accepted.json() as { jobId: string };
      await vi.waitFor(() => expect(jobs.get(second.jobId)?.status).toBe("succeeded"));
      expect((await post("/api/actions/board-revise", revise)).status).toBe(409);
      expect((await post("/api/actions/board-update", { directionId: "alpha", versionId: "v1" })).status).toBe(400);
      const asset = await post("/api/actions/asset-generate", { directionId: "alpha", versionId: "v1", describe: "A mascot" });
      expect(asset.status).toBe(202);
    } finally {
      await vi.waitFor(() => expect(jobs.list().every((job) => job.status !== "running")).toBe(true), { timeout: 5000 });
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("explores independently, retains both asset origins, resumes partial board updates and approves without cascading", async () => {
    const tile1 = await foundation("v1", "Frozen original identity");
    await createBrandCore(cwd, config).setPointer({ directionId: "alpha", versionId: "v1" });
    const original = await snapshot(path.join(directionDir, "versions", "v1"));
    enableImages();
    const instagram = await runBoardCreate({ cwd, directionId: "alpha", versionId: "v1", name: "Instagram", describe: "An editorial Instagram campaign" });
    const poster = await runBoardCreate({ cwd, directionId: "alpha", versionId: "v1", name: "Poster", describe: "A spacious event poster" });
    const retired = await runBoardCreate({ cwd, directionId: "alpha", versionId: "v1", name: "Retired", describe: "An unused poster" });
    await retireBoard(directionDir, retired.boardId);
    const posterBefore = await readBoardIndex(directionDir, poster.boardId);
    const revised = await runBoardRevise({ cwd, directionId: "alpha", boardId: instagram.boardId, revisionId: instagram.revisionId, versionId: "v1", tweak: "Use asymmetrical composition" });
    expect(revised.status).toBe("completed");
    expect(await readBoardIndex(directionDir, poster.boardId)).toEqual(posterBefore);
    const generated = await runAssetGenerate({ cwd, directionId: "alpha", versionId: "v1", name: "Mascot", describe: "A friendly bird mascot" });
    const cropPath = path.join(cwd, "detail-crop.png");
    await fs.writeFile(cropPath, "fixture crop");
    const extracted = await runAssetExtract({ cwd, directionId: "alpha", boardId: instagram.boardId, revisionId: revised.revisionId, name: "Detail", describe: "The decorative motif", cropPath });
    const generatedVersion = await readAssetVersion(directionDir, generated.assetId, generated.versionId);
    const extractedVersion = await readAssetVersion(directionDir, extracted.assetId, extracted.versionId);
    expect(generatedVersion.provenance.kind).toBe("generated");
    expect(extractedVersion.provenance.kind).toBe("extracted");
    if (extractedVersion.provenance.kind !== "extracted") throw new Error("Expected extraction provenance");
    expect(extractedVersion.provenance.cropPath).toMatch(/source-crop\.png$/);
    const extractionCall = vi.mocked(generateImage).mock.calls.find(([input]) => input.outPath.includes(extracted.assetId));
    expect(extractionCall?.[0].referenceImagePaths).toContain(path.resolve(cwd, extractedVersion.provenance.cropPath!));
    expect(extractionCall?.[0].referenceImagePaths).not.toContain(cropPath);
    expect(extractedVersion.foundation).toEqual({ directionId: "alpha", versionId: "v1" });
    expect(vi.mocked(generateImage).mock.calls.every(([input]) => input.referenceImagePaths?.[0] === tile1)).toBe(true);
    const assetsBefore = await snapshot(path.join(directionDir, "extracted-assets"));
    const tile2 = await foundation("v2", "New foundation identity");
    await createDirectionCore(cwd, config).setBriefFields("alpha", { oneLiner: "Unsaved live brief must never leak" });
    vi.mocked(generateImage).mockClear();
    vi.mocked(generateImage).mockImplementationOnce(async ({ outPath }) => {
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, "updated board");
      return { written: true, dryRun: false };
    }).mockResolvedValueOnce({ written: false, dryRun: false, skippedReason: "Injected image failure" });
    const batch = await runBoardUpdate({ cwd, directionId: "alpha", versionId: "v2" });
    expect(batch.entries).toHaveLength(2);
    expect(batch.status).toBe("partial");
    expect(batch.entries.filter((entry) => entry.status === "completed")).toHaveLength(1);
    const successful = batch.entries.find((entry) => entry.status === "completed")!;
    const successfulBefore = await readBoardIndex(directionDir, successful.boardId);
    vi.mocked(generateImage).mockClear();
    const resumed = await runBoardUpdate({ cwd, directionId: "alpha", resume: batch.batchId });
    expect(resumed.status).toBe("completed");
    expect(vi.mocked(generateImage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(generateImage).mock.calls[0][0].referenceImagePaths?.[0]).toBe(tile2);
    expect(vi.mocked(generateImage).mock.calls[0][0].prompt).not.toContain("Unsaved live brief must never leak");
    expect(await readBoardIndex(directionDir, successful.boardId)).toEqual(successfulBefore);
    expect((await readBoardRevision(directionDir, instagram.boardId, revised.revisionId)).foundation.versionId).toBe("v1");
    expect((await createBrandCore(cwd, config).read()).approvedPointer?.versionId).toBe("v1");
    await runApprove({ cwd, directionId: "alpha", versionId: "v2" });
    expect(await snapshot(path.join(directionDir, "versions", "v1"))).toEqual(original);
    expect(await snapshot(path.join(directionDir, "extracted-assets"))).toEqual(assetsBefore);
    expect((await readAssetIndex(directionDir, generated.assetId)).head).toBe(generated.versionId);
  });

  it("writes honest pending prompts when the selected foundation has no image, even with a key", async () => {
    await foundation("v1", "Pending foundation", false);
    await foundation("v2", "Later rendered foundation");
    enableImages();
    const board = await runBoardCreate({ cwd, directionId: "alpha", versionId: "v1", name: "Pending", describe: "An editorial campaign" });
    const asset = await runAssetGenerate({ cwd, directionId: "alpha", versionId: "v1", name: "Pending", describe: "A decorative bird" });
    expect(board.status).toBe("pending");
    expect(asset.status).toBe("pending");
    expect(generateImage).not.toHaveBeenCalled();
    expect(board.filesWritten.some((file) => file.endsWith(".md"))).toBe(true);
    expect(asset.filesWritten.some((file) => file.endsWith(".md"))).toBe(true);
  });
});
