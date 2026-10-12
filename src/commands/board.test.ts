import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { KeyartConfig } from "../types.js";
vi.mock("../config.js", async (original) => ({ ...await original<typeof import("../config.js")>(), loadConfig: vi.fn() }));
vi.mock("../openai.js", async (original) => ({ ...await original<typeof import("../openai.js")>(), hasApiKey: vi.fn(() => false) }));
import { loadConfig, directionsRoot } from "../config.js";
import { createDirectionCore } from "../direction/core.js";
import { writeDirectionVersion } from "../explore/write-direction-version.js";
import { buildPlaceholderDirections } from "../explore/placeholders.js";
import { captureBoardUpdate } from "../board/operations.js";
import { readBoardIndex, readBoardRevision } from "../board/board-store.js";
import { runBoard } from "./board.js";
import { dispatchCommand, getGroup } from "../mcp/registry.js";
import { runAsset } from "./asset.js";
import { readAssetVersion } from "../asset/asset-store.js";

let cwd: string;
let config: KeyartConfig;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-board-command-"));
  config = { project: { name: "Test", type: "prototype", framework: "none" },
    brand: { root: "brand", references: "brand/refs", approved: "brand/approved", rejected: "brand/rejected" },
    models: { text: "mock", vision: "mock", image: "mock" },
    outputs: { cursorRules: ".cursor/rules/brand.mdc", cssVars: "brand/generated/brand.css", implementationBrief: "brand/generated/implementation.md" } };
  vi.mocked(loadConfig).mockResolvedValue(config);
  vi.spyOn(console, "log").mockImplementation(() => {});
  await createDirectionCore(cwd, config).create({ id: "route", name: "Route" });
  for (const id of ["v1", "v2"]) await writeDirectionVersion({ cwd, config, directionId: "route", directionsDir: directionsRoot(cwd, config),
    version: { ...buildPlaceholderDirections("Frozen brand")[0], id, createdAt: new Date().toISOString(), briefSnapshot: "Frozen brand", contextSnapshot: "{}" },
    referenceImagePaths: [], skipImages: true });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(cwd, { recursive: true, force: true }); });

describe("Board and asset command facades", () => {
  it("creates, pins independent revision inputs, resumes a captured batch, inspects and retires", async () => {
    const create = await dispatchCommand({ command: "board", input: ["create", "--direction", "route", "--version", "v1", "--name", "Instagram", "--describe", "A launch post"] }, { defaultCwd: cwd });
    expect(create.isError).toBe(false);
    expect(getGroup("brand")!.commands).toContain("board");
    const dir = path.join(directionsRoot(cwd, config), "route");
    const index = await readBoardIndex(dir, "instagram");
    expect((await runBoard(cwd, ["show", "instagram"], { direction: "route" })).summary).toContain("v1");
    const revised = await runBoard(cwd, ["revise", "instagram"], { direction: "route", version: "v2", revision: "none", instructionVersion: String(index.instructionVersion), tweak: "Use a spacious composition" });
    const revisionId = (revised.result as { revisionId: string }).revisionId;
    const revision = await readBoardRevision(dir, "instagram", revisionId);
    expect(revision.foundation.versionId).toBe("v2");
    expect(revision.sourceRevisionId).toBeNull();
    const capture = await captureBoardUpdate({ cwd, directionId: "route", versionId: "v1" });
    const updated = await runBoard(cwd, ["update"], { direction: "route", version: "v1", captured: JSON.stringify(capture.entries) });
    expect(updated.summary).toContain("partial");
    const batchId = (updated.result as { batchId: string }).batchId;
    await expect(runBoard(cwd, ["update"], { direction: "route", resume: batchId })).resolves.toMatchObject({ summary: expect.stringContaining("partial") });
    await runBoard(cwd, ["retire", "instagram"], { direction: "route" });
    expect((await runBoard(cwd, ["list"], { direction: "route" })).result).toEqual([]);
    expect((await runBoard(cwd, ["show", "instagram"], { direction: "route", revision: revisionId })).summary).toContain("spacious");
  });

  it("generates and revises an asset retaining its explicit source foundation", async () => {
    const generated = await runAsset(cwd, ["generate"], { direction: "route", version: "v1", name: "Mascot", describe: "A welcoming mascot" });
    if (generated.verb !== "generate") throw new Error("wrong result");
    expect(generated.status).toBe("pending");
    const revised = await runAsset(cwd, ["revise", generated.assetId], { direction: "route", revision: generated.versionId, tweak: "Face left" });
    if (revised.verb !== "revise") throw new Error("wrong result");
    const version = await readAssetVersion(path.join(directionsRoot(cwd, config), "route"), revised.assetId, revised.versionId);
    expect(version.foundation.versionId).toBe("v1");
    expect(version.provenance.kind).toBe("generated");
    expect(version.sourceRevisionId).toBe(generated.versionId);
  });

  it("teaches missing foundations and rejects invalid captures before writing", async () => {
    await expect(runBoard(cwd, ["create"], { direction: "route", name: "Bad", describe: "Post" })).rejects.toThrow(/--version/);
    await expect(runBoard(cwd, ["update"], { direction: "route", version: "v1", captured: "{}" })).rejects.toThrow(/captured/);
    await expect(runAsset(cwd, ["generate"], { direction: "route", describe: "Artwork" })).rejects.toThrow(/--version/);
    expect(await fs.readdir(path.join(directionsRoot(cwd, config), "route"))).not.toContain("boards");
  });
});
