import { describe, expect, it } from "vitest";
import { boardRevisionFor, boardStageItems, sourceFields, foundationLabel } from "./board-view.js";
import { buildChatTurnContext } from "./chat-context.js";
import type { DashboardBoard, DashboardBoardRevision, DashboardVersion } from "./types.js";
const revision = (id: string, versionId: string, status: DashboardBoardRevision["status"]): DashboardBoardRevision => ({ id,
  foundation: { directionId: "alpha", versionId }, status, conditioning: "foundation", sourceRevisionId: null, instructions: "Editorial", instructionVersion: 1, createdAt: id,
  ...(status === "completed" ? { imagePath: `${id}.png` } : {}) });
const board: DashboardBoard = { id: "instagram", directionId: "alpha", name: "Instagram", version: 3, instructions: "Editorial", instructionVersion: 1,
  head: "r3", revisions: [revision("r1", "v1", "completed"), revision("r2", "v1", "failed"), revision("r3", "v2", "completed")] };
const version: DashboardVersion = { versionId: "v1", name: "Alpha", createdAt: "now", summary: "", positioning: "", character: {}, usage: { rules: [], antiRules: [] },
  styleTilePrompt: "", copyExamples: { headline: "", subheadline: "", cta: "" }, images: { styleTile: "tile.png" } };

describe("identified foundation and Board sources", () => {
  it("retains stable foundation numbers after earlier versions are deleted", () => {
    expect(foundationLabel([{ ...version, ordinal: 8 }], version.versionId)).toBe(`v8 (${version.versionId})`);
    expect(foundationLabel([], "deleted-foundation")).toBe("deleted-foundation");
  });
  it("chooses the latest completed revision of the selected foundation without borrowing the overall head", () => {
    expect(boardRevisionFor(board, "v1")?.id).toBe("r1");
    expect(boardRevisionFor(board, "v3")).toBeUndefined();
    expect(boardRevisionFor({ ...board, revisions: [revision("r1", "v1", "pending")] }, "v1")?.status).toBe("pending");
    const items = boardStageItems("alpha", version, [board]);
    expect(items[1].source).toEqual({ kind: "board", directionId: "alpha", versionId: "v1", boardId: "instagram", revisionId: "r1" });
    expect(items[1].path).toBe("r1.png");
    expect(boardStageItems("alpha", { ...version, versionId: "v3" }, [board])[1].path).toBeUndefined();
  });
  it("retired histories are opt-in and missing foundation images never borrow a Board", () => {
    expect(boardStageItems("alpha", version, [{ ...board, retiredAt: "now" }])).toHaveLength(1);
    expect(boardStageItems("alpha", version, [{ ...board, retiredAt: "now" }], true)).toHaveLength(2);
    expect(boardStageItems("alpha", { ...version, images: undefined }, [board])[0].path).toBeUndefined();
  });
  it("historical capture and chat scope pin both source revision and foundation without file paths", () => {
    const source = { kind: "board" as const, directionId: "alpha", versionId: "v1", boardId: "instagram", revisionId: "r1" };
    expect(sourceFields(source)).toEqual({ directionId: "alpha", versionId: "v1", boardId: "instagram", revisionId: "r1" });
    expect(buildChatTurnContext("alpha", "v1", { boardId: "instagram", revisionId: "r1" })).toEqual(sourceFields(source));
    expect(sourceFields({ kind: "foundation", directionId: "alpha", versionId: "v1" })).toEqual({ directionId: "alpha", versionId: "v1", image: "styleTile" });
  });
});
