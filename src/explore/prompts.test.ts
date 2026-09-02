import { describe, it, expect } from "vitest";
import {
  buildExploreSystemPrompt,
  buildExploreUserPrompt,
} from "./prompts.js";

const BRIEF = "A creative brief for a productivity app.";
const CONTEXT_BLOCK =
  "## Non-Negotiable Global Rules (HARD)\n- Never use pure black\n\n## Direction Memory\n- [feedback] loves serif headlines";

describe("buildExploreUserPrompt", () => {
  it("returns the legacy prompt verbatim when no context block is given", () => {
    const legacy = `Here is the creative brief:\n\n${BRIEF}\n\nGenerate 3 distinct visual directions as specified.`;
    expect(buildExploreUserPrompt(BRIEF)).toBe(legacy);
    // Empty / whitespace-only context behaves the same as absent.
    expect(buildExploreUserPrompt(BRIEF, { contextBlock: "" })).toBe(legacy);
    expect(buildExploreUserPrompt(BRIEF, { contextBlock: "   \n  " })).toBe(
      legacy,
    );
  });

  it("appends the moodboard instruction when reference images are attached", () => {
    const prompt = buildExploreUserPrompt(BRIEF, { hasReferenceImages: true });
    expect(prompt).toContain("Here is the creative brief:");
    expect(prompt.toLowerCase()).toContain("moodboard");
    // Hard rules still win over the references.
    expect(prompt.toLowerCase()).toContain("hard rules still override");
  });

  it("injects one-shot instructions above the brief but flags hard-rule supremacy", () => {
    const prompt = buildExploreUserPrompt(BRIEF, {
      instructions: "lean more editorial",
    });
    expect(prompt).toContain("ONE-SHOT INSTRUCTIONS");
    expect(prompt).toContain("lean more editorial");
    // Still subordinate to the non-negotiable global hard rules.
    expect(prompt.toLowerCase()).toContain("below the non-negotiable global hard rules");
    // Blank instructions are a no-op (legacy prompt preserved).
    expect(buildExploreUserPrompt(BRIEF, { instructions: "   " })).toBe(
      `Here is the creative brief:\n\n${BRIEF}\n\nGenerate 3 distinct visual directions as specified.`,
    );
  });

  it("prepends the authoritative-context preamble and block before the brief", () => {
    const prompt = buildExploreUserPrompt(BRIEF, { contextBlock: CONTEXT_BLOCK });

    expect(prompt).toContain("The following project context is AUTHORITATIVE.");
    expect(prompt).toContain(CONTEXT_BLOCK);
    expect(prompt).toContain(BRIEF);

    // Ordering: preamble → context block → brief.
    const preambleIdx = prompt.indexOf("AUTHORITATIVE");
    const contextIdx = prompt.indexOf(CONTEXT_BLOCK);
    const briefIdx = prompt.indexOf("Here is the creative brief:");
    expect(preambleIdx).toBeLessThan(contextIdx);
    expect(contextIdx).toBeLessThan(briefIdx);
  });
});

describe("buildExploreSystemPrompt", () => {
  it("keeps the JSON schema instructions and asserts hard-rule supremacy", () => {
    const sys = buildExploreSystemPrompt();
    expect(sys).toContain('"directions"');
    expect(sys.toLowerCase()).toContain("hard rules");
  });

  it("emits a structured character object (six fields) and a usage object with rules/antiRules (SC-08)", () => {
    const sys = buildExploreSystemPrompt();

    // The evocative `character` object with all six fields.
    expect(sys).toContain('"character"');
    for (const field of [
      "mood",
      "composition",
      "layout",
      "imagery",
      "texture",
      "rhythm",
    ]) {
      expect(sys).toContain(`"${field}"`);
    }

    // The imperative `usage` object with rules/antiRules.
    expect(sys).toContain('"usage"');
    expect(sys).toContain('"rules"');
    expect(sys).toContain('"antiRules"');
  });

  it("NEVER emits the retired freeform fields (SC-02/SC-08)", () => {
    const sys = buildExploreSystemPrompt();
    expect(sys).not.toContain('"visualStyle"');
    expect(sys).not.toContain('"designRules"');
    // `antiRules` survives ONLY nested under `usage` — never as a top-level
    // schema key. Every occurrence is qualified (schema block or hygiene rule).
    expect(sys).not.toMatch(/\bvisualStyle\b/);
    expect(sys).not.toMatch(/\bdesignRules\b/);
  });

  it("keeps the style-tile labeling rule and confines hexes/fonts to the image prompts (SC-08)", () => {
    const sys = buildExploreSystemPrompt();
    // The tile still PRINTS the labeled palette panel + font names (read-back).
    expect(sys).toContain("color-palette panel");
    expect(sys).toContain("EXACT hex code");
    expect(sys).toContain("FONT FAMILY NAMES");
    // Only the image prompts may carry hexes/fonts.
    expect(sys).toContain(
      'Only the image prompts ("styleTilePrompt"/"homepageMockupPrompt") may contain hex codes and font names',
    );
    // The character/usage hygiene rule forbids hex/font in the prose fields.
    expect(sys).toContain(
      'It MUST NOT contain hex color codes or font-family names',
    );
  });
});
