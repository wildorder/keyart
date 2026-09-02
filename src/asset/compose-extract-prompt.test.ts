import { describe, it, expect } from "vitest";
import { composeExtractPrompt } from "./compose-extract-prompt.js";
import { assembleContext } from "../brand/assemble-context.js";
import { composeArtDirection } from "../explore/compose-art-direction.js";
import type { GlobalBrand } from "../brand/schema.js";
import type { ContextMemoryEntry } from "../brand/assemble-context.js";

function buildGlobal(rules: GlobalBrand["rules"]): GlobalBrand {
  return {
    approvedPointer: null,
    rules,
    version: 0,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
}

describe("composeExtractPrompt", () => {
  it("isolation directives are present with the description verbatim", () => {
    const prompt = composeExtractPrompt({
      description: "the yak mascot",
      artDirection: "",
    });

    expect(prompt).toContain("the yak mascot");
    expect(prompt).toContain("Render ONLY this element");
    expect(prompt).toContain("isolated and centered");
    expect(prompt).toContain("fully transparent background");
    expect(prompt).toContain("faithful to the reference's styling and rendering");
    expect(prompt).toContain("Do not include any scene background, additional elements, text, or labels.");
  });

  it("appends the artDirection block byte-verbatim as the tail, carrying MUST + AVOID", () => {
    const global = buildGlobal([
      {
        id: "r1",
        severity: "hard",
        text: "Never use drop shadows",
        author: "tim",
        source: "cli",
        date: "2024-01-01T00:00:00.000Z",
        channel: "visual",
      },
    ]);
    const memory: ContextMemoryEntry[] = [
      {
        kind: "feedback",
        body: "too much clutter in the background",
        author: "tim",
        source: "element-feedback",
        date: "2024-01-01T00:00:00.000Z",
        asset: "thumb.png",
      },
    ];
    const assembled = assembleContext({
      brief: "A yak-themed brand.",
      global,
      memory,
    });
    const artDirection = composeArtDirection(assembled);

    const prompt = composeExtractPrompt({
      description: "the yak mascot",
      artDirection,
    });

    expect(prompt.endsWith(artDirection)).toBe(true);
    expect(prompt).toContain("MUST");
    expect(prompt).toContain("Never use drop shadows");
    expect(prompt).toContain("AVOID");
    expect(prompt).toContain("too much clutter in the background");
  });

  it("empty artDirection produces no tail — exactly the isolation block", () => {
    const prompt = composeExtractPrompt({
      description: "the yak mascot",
      artDirection: "",
    });

    const isolationOnly = composeExtractPrompt({
      description: "the yak mascot",
      artDirection: "",
      tweak: undefined,
    });

    expect(prompt).toBe(isolationOnly);
    expect(prompt.trim().endsWith("text, or labels.")).toBe(true);
  });

  it("tweak block renders only when supplied, between isolation and artDirection", () => {
    const withTweak = composeExtractPrompt({
      description: "the yak mascot",
      artDirection: "MUST\n- some rule",
      tweak: "make it face left",
    });
    expect(withTweak).toContain(
      "Adjustment (this pass only — apply to the asset above): make it face left",
    );
    const isolationIdx = withTweak.indexOf("Render ONLY this element");
    const tweakIdx = withTweak.indexOf("Adjustment (this pass only");
    const artIdx = withTweak.indexOf("MUST\n- some rule");
    expect(isolationIdx).toBeLessThan(tweakIdx);
    expect(tweakIdx).toBeLessThan(artIdx);

    const withoutTweak = composeExtractPrompt({
      description: "the yak mascot",
      artDirection: "MUST\n- some rule",
    });
    expect(withoutTweak).not.toContain("Adjustment (this pass only");

    const withBlankTweak = composeExtractPrompt({
      description: "the yak mascot",
      artDirection: "MUST\n- some rule",
      tweak: "   ",
    });
    expect(withBlankTweak).not.toContain("Adjustment (this pass only");
  });

  it("is deterministic — identical input twice yields byte-identical output", () => {
    const input = {
      description: "the yak mascot",
      artDirection: "MUST\n- some rule",
      tweak: "make it face left",
    };
    expect(composeExtractPrompt(input)).toBe(composeExtractPrompt(input));
  });
});
