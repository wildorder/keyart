import { describe, expect, it } from "vitest";
import { boardCreateRequest, boardReviseRequest, boardUpdateRequest, boardRetireRequest, boardPrepareRequest, assetGenerateRequest, assetReviseRequest } from "./direction-actions.js";
import { BOARD_TIER_A_BUILDERS } from "../integration/studio-roster.js";
import { BOARD_WRITE_ROUTES } from "./board-api.js";
import type { BoardBatchEntry } from "../board/schema.js";
const entry: BoardBatchEntry = { boardId: "instagram", name: "Instagram", sourceRevisionId: "r1", instructions: "Editorial", instructionVersion: 2, operationId: "update-1", status: "pending" };
const cases: Record<string, () => void> = {
  boardCreateRequest: () => {
    const args = { directionId: "alpha", versionId: "v1", name: "Instagram", describe: "Editorial" };
    expect(boardCreateRequest(args)).toEqual({ method: "POST", path: "/api/actions/board-create", body: args });
  },
  boardReviseRequest: () => {
    const args = { directionId: "alpha", versionId: "v2", boardId: "instagram", revisionId: "r1", expectedInstructionVersion: 2, tweak: "More whitespace" };
    expect(boardReviseRequest(args)).toEqual({ method: "POST", path: "/api/actions/board-revise", body: args });
    expect((boardReviseRequest({ ...args, revisionId: null }).body as typeof args).revisionId).toBeNull();
  },
  boardUpdateRequest: () => {
    const args = { directionId: "alpha", versionId: "v2", captured: [entry] };
    expect(boardUpdateRequest(args)).toEqual({ method: "POST", path: "/api/actions/board-update", body: args });
    expect(boardUpdateRequest({ directionId: "alpha", resume: "batch-1" }).body).toEqual({ directionId: "alpha", resume: "batch-1" });
  },
  boardRetireRequest: () => expect(boardRetireRequest("alpha", "a/b", 3)).toEqual({ method: "DELETE", path: "/api/directions/alpha/boards/a%2Fb", body: { expectedVersion: 3 } }),
  boardPrepareRequest: () => {
    expect(boardPrepareRequest({ directionId: "alpha", versionId: "v2", boardId: "instagram", mode: "revise", revisionId: null })).toEqual({ method: "GET", path: "/api/boards/prepare?directionId=alpha&versionId=v2&boardId=instagram&mode=revise&revisionId=none" });
  },
  assetGenerateRequest: () => {
    const args = { directionId: "alpha", versionId: "v1", name: "Hero", describe: "Editorial art" };
    expect(assetGenerateRequest(args)).toEqual({ method: "POST", path: "/api/actions/asset-generate", body: args });
  },
};
describe("pinned Board and asset requests", () => {
  it("covers exactly the added control roster", () => expect(Object.keys(cases).sort()).toEqual([...BOARD_TIER_A_BUILDERS].sort()));
  for (const [name, run] of Object.entries(cases)) it(name, run);
  it("pins asset revision instead of allowing a later head to retarget", () => {
    expect(assetReviseRequest("alpha", "hero", "Face left", { revisionId: "r1" }).body).toEqual({ directionId: "alpha", assetId: "hero", tweak: "Face left", revisionId: "r1" });
  });
  it("covers the guarded Board write route table exactly", () => {
    const requests = [boardCreateRequest({ directionId: "d", versionId: "v", name: "n", describe: "b" }),
      boardReviseRequest({ directionId: "d", versionId: "v", boardId: "b", revisionId: null, expectedInstructionVersion: 1 }),
      boardUpdateRequest({ directionId: "d", versionId: "v" }), boardRetireRequest("d", "b", 1)];
    expect(requests.map((r) => `${r.method} ${r.path.replace("/directions/d/boards/b", "/directions/:id/boards/:boardId")}`).sort()).toEqual([...BOARD_WRITE_ROUTES].sort());
  });
});
