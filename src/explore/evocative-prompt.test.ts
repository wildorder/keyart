import { describe, it, expect } from "vitest";
import { composeEvocativeBoardPrompt } from "./evocative-prompt.js";
import { composeContentLock } from "./token-intent.js";
import { composeArtDirection } from "./compose-art-direction.js";
import { assembleContext } from "../brand/assemble-context.js";
import type { AssembledContext } from "../brand/assemble-context.js";
import type { GlobalBrand } from "../brand/schema.js";
import { buildPlaceholderDirections, type SeedDirection } from "./placeholders.js";

/** A valid, fully-formed direction with tokens. */
function tokenedDirection(): SeedDirection {
  const d = buildPlaceholderDirections("A moody editorial brief.")[0];
  expect(d.tokens).toBeDefined();
  return d;
}

/** Build a GlobalBrand with a visual hard rule + a positive visual guideline. */
function buildGlobal(): GlobalBrand {
  return {
    approvedPointer: null,
    rules: [
      {
        id: "r1",
        severity: "hard",
        text: "Never use a fist-in-the-air icon",
        author: "tim",
        source: "cli",
        date: "2026-01-01T00:00:00.000Z",
        channel: "visual",
      },
      {
        id: "r2",
        severity: "guideline",
        text: "Prefer open airy compositions",
        author: "tim",
        source: "cli",
        date: "2026-01-01T00:00:00.000Z",
        channel: "visual",
        polarity: "prefer",
      },
    ],
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Assembled context with a hard rule + positive guideline + visual-avoid decision. */
function buildAssembled(): AssembledContext {
  return assembleContext({
    brief: "A moody editorial brand.",
    global: buildGlobal(),
    memory: [
      {
        kind: "decision",
        body: "avoid aggressive diagonal layouts",
        author: "tim",
        source: "cli",
        date: "2026-01-01T00:00:00.000Z",
        channel: "visual",
        polarity: "avoid",
      },
      {
        kind: "learning",
        body: "use conversational tone",
        author: "tim",
        source: "cli",
        date: "2026-01-01T00:00:00.000Z",
        channel: "copy",
      },
    ],
    references: [],
  });
}

/** Empty assembled context — produces the no-directive path. */
function emptyAssembled(): AssembledContext {
  return assembleContext({
    brief: "",
    global: {
      approvedPointer: null,
      rules: [],
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    memory: [],
    references: [],
  });
}

describe("composeEvocativeBoardPrompt — WS-03 directive compiler integration", () => {
  it("board carries the SAME art-direction tail as the writer's prompts for identical assembled/opts (SC-02)", () => {
    const direction = tokenedDirection();
    const assembled = buildAssembled();
    const tweak = "warmer palette";
    const locks = ["#ff5722"];

    const boardPrompt = composeEvocativeBoardPrompt(direction, assembled, tweak, locks);

    // The compiler tail for identical inputs must be byte-identical (deterministic).
    const expectedTail = composeArtDirection(assembled, {
      oneShot: tweak,
      lockedColors: locks,
    });
    expect(expectedTail.length).toBeGreaterThan(0); // guard: fixture has directives
    expect(boardPrompt).toContain(expectedTail);

    // Hard prohibition from global hard rule must be in MUST.
    expect(boardPrompt).toContain("MUST (non-negotiable — always obey):");
    expect(boardPrompt).toContain("Never use a fist-in-the-air icon");

    // Positive guideline in PREFER.
    expect(boardPrompt).toContain("PREFER (do):");
    expect(boardPrompt).toContain("Prefer open airy compositions");

    // Visual-avoid concept decision in AVOID.
    expect(boardPrompt).toContain("avoid aggressive diagonal layouts");

    // Copy-only learning must NOT appear in the image prompt.
    expect(boardPrompt).not.toContain("use conversational tone");
  });

  it("one-shot tweak is inside the compiler tail (between MUST and PREFER) and content lock is present (SC-04)", () => {
    const direction = tokenedDirection();
    const assembled = buildAssembled();
    const tweak = "more neon";

    const boardPrompt = composeEvocativeBoardPrompt(direction, assembled, tweak);

    // Content lock is present after the creative line.
    expect(boardPrompt).toContain("CONTENT LOCK");

    // One-shot appears in the compiler tail (between MUST and PREFER).
    expect(boardPrompt).toContain(
      `Additional art direction (this pass only): ${tweak}`,
    );

    // Order: creative → content → MUST → one-shot → PREFER
    const mustIdx = boardPrompt.indexOf("MUST");
    const oneShotIdx = boardPrompt.indexOf("Additional art direction");
    const preferIdx = boardPrompt.indexOf("PREFER (do):");
    expect(mustIdx).toBeGreaterThan(-1);
    expect(oneShotIdx).toBeGreaterThan(mustIdx);
    expect(preferIdx).toBeGreaterThan(oneShotIdx);

    // Direction name and summary are in the creative line.
    expect(boardPrompt).toContain(direction.name);
    expect(boardPrompt).toContain(direction.summary);
  });

  it("empty visualDirectives + no locks + no tweak ⇒ board equals creative + content lock (SC-11)", () => {
    const direction = tokenedDirection();
    const assembled = emptyAssembled();

    const boardPrompt = composeEvocativeBoardPrompt(direction, assembled);

    // The compiler emits "" for empty inputs so no art tail is appended.
    const creative = `A cohesive moodboard / style board for "${direction.name}": ${direction.summary}. Evocative imagery, textures, and UI vignettes capturing the mood.`;
    const expected = `${creative}\n\n${composeContentLock(direction)}`;
    expect(boardPrompt).toBe(expected);
  });

  it("soft locked-color guidance appears in the board via the compiler (not a hard lock)", () => {
    const direction = tokenedDirection();
    const assembled = emptyAssembled();
    const locks = ["#abcdef"];

    const boardPrompt = composeEvocativeBoardPrompt(direction, assembled, undefined, locks);

    // Soft guidance present.
    expect(boardPrompt).toContain("COLOR GUIDANCE (soft)");
    expect(boardPrompt).toContain("#abcdef");
    // No hard lock (retired).
    expect(boardPrompt.toUpperCase()).not.toContain("COLOR & TYPE LOCK");
  });

  it("is deterministic — byte-identical output for identical inputs", () => {
    const direction = tokenedDirection();
    const assembled = buildAssembled();
    const a = composeEvocativeBoardPrompt(direction, assembled, "warm it up");
    const b = composeEvocativeBoardPrompt(direction, assembled, "warm it up");
    expect(a).toBe(b);
  });
});
