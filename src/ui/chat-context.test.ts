import { describe, it, expect } from "vitest";
import { buildChatTurnContext } from "./chat-context.js";

describe("buildChatTurnContext (SC-10 studio-side contract)", () => {
  it("requires directionId and omits an absent versionId entirely", () => {
    const result = buildChatTurnContext("warm");
    expect(result).toEqual({ directionId: "warm" });
    expect("versionId" in result).toBe(false);
  });

  it("a null versionId omits the key (never versionId: undefined, never null)", () => {
    const result = buildChatTurnContext("warm", null);
    expect(result).toEqual({ directionId: "warm" });
    expect("versionId" in result).toBe(false);
  });

  it("an empty-string versionId omits the key", () => {
    const result = buildChatTurnContext("warm", "");
    expect(result).toEqual({ directionId: "warm" });
    expect("versionId" in result).toBe(false);
  });

  it("a concrete versionId is carried verbatim", () => {
    const result = buildChatTurnContext("warm", "version-3");
    expect(result).toEqual({ directionId: "warm", versionId: "version-3" });
  });

  it("directionId is never dropped or coerced", () => {
    expect(buildChatTurnContext("warm", "version-3").directionId).toBe("warm");
    expect(buildChatTurnContext("warm", null).directionId).toBe("warm");
  });
});
