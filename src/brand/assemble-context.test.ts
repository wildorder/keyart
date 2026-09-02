import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import {
  assembleContext,
  renderContextBlock,
  selectNegatives,
  selectVisualDirectives,
  MAX_CONTEXT_REFERENCES,
  type ContextMemoryEntry,
  type ReferenceItem,
  type AssembleContextInput,
} from "./assemble-context.js";
import { deriveLocksFromContext } from "../explore/token-intent.js";
import type { GlobalBrand, GlobalRule } from "./schema.js";
import { createDirectionCore } from "../direction/core.js";
import { isRetired } from "../direction/reconcile.js";
import type { KeyartConfig } from "../types.js";

const hardA: GlobalRule = {
  id: "rule-hard",
  severity: "hard",
  text: "Never use pure black backgrounds",
  author: "tim",
  source: "cli",
  date: "2026-06-30T00:00:00.000Z",
};

const guidelineB: GlobalRule = {
  id: "rule-guide",
  severity: "guideline",
  text: "Prefer generous whitespace",
  author: "tim",
  source: "cli",
  date: "2026-06-30T00:00:00.000Z",
};

const feedback: ContextMemoryEntry = {
  kind: "feedback",
  body: "Use a darker hero",
  author: "tim",
  source: "cli",
  date: "2026-06-30T00:00:00.000Z",
};

function makeGlobal(rules: GlobalRule[]): GlobalBrand {
  return {
    approvedPointer: null,
    rules,
    version: 1,
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
  };
}

function makeConfig(directionsDir: string): KeyartConfig {
  return {
    project: { name: "test", type: "web", framework: "react" },
    brand: {
      root: "brand",
      references: "brand/references",
      approved: "brand/approved",
      rejected: "brand/rejected",
      directions: directionsDir,
    },
    models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
    outputs: {
      cursorRules: ".cursor/rules",
      cssVars: "brand/vars.css",
      implementationBrief: "brand/impl.md",
    },
    store: { driver: "file" },
  };
}

describe("assembleContext precedence split", () => {
  it("splits rules by severity and passes brief + memory through", () => {
    const ctx = assembleContext({
      brief: "BRIEF_TEXT",
      global: makeGlobal([hardA, guidelineB]),
      memory: [feedback],
    });

    expect(ctx.hardRules).toEqual([hardA]);
    expect(ctx.guidelines).toEqual([guidelineB]);
    expect(ctx.memory).toEqual([feedback]);
    expect(ctx.brief).toBe("BRIEF_TEXT");
  });

  it("Test 10 (AssembleContextInput has no directionId field): constructing without one compiles; memory passed is the only memory source", () => {
    // The `directionId` field literally does not exist on the type — this
    // object satisfies AssembleContextInput without one (compile-time proof).
    const input: AssembleContextInput = {
      brief: "BRIEF",
      global: makeGlobal([hardA, guidelineB]),
      memory: [feedback],
      references: [{ path: "a.png" }, { path: "b.png" }, { path: "c.png" }],
    };
    const ctx = assembleContext(input);
    expect(ctx.memory).toBe(input.memory);
  });
});

describe("renderContextBlock ordering + supremacy wording", () => {
  it("orders sections by precedence and states hard-rule supremacy", () => {
    const ctx = assembleContext({
      brief: "BRIEF_TEXT",
      global: makeGlobal([hardA, guidelineB]),
      memory: [feedback],
    });
    const block = renderContextBlock(ctx);

    const hardIdx = block.indexOf("Non-Negotiable Global Rules");
    const guideIdx = block.indexOf("Global Guidelines");
    const memIdx = block.indexOf("Direction Memory");
    const briefIdx = block.indexOf("## Brief");

    expect(hardIdx).toBeGreaterThanOrEqual(0);
    expect(hardIdx).toBeLessThan(guideIdx);
    expect(guideIdx).toBeLessThan(memIdx);
    expect(memIdx).toBeLessThan(briefIdx);

    expect(block).toMatch(/HARD/);
    expect(block).toMatch(/override everything below/i);
    expect(block).toContain(hardA.text);
    expect(block).toContain("[feedback] Use a darker hero");
    expect(block).toContain("BRIEF_TEXT");
  });

  it("omits the direction-memory section when there are no entries", () => {
    const ctx = assembleContext({
      brief: "B",
      global: makeGlobal([hardA, guidelineB]),
      memory: [],
    });
    const block = renderContextBlock(ctx);
    expect(block).not.toContain("Direction Memory");
  });

  it("omits the hard-rules section when there are no hard rules", () => {
    const ctx = assembleContext({
      brief: "B",
      global: makeGlobal([guidelineB]),
      memory: [feedback],
    });
    const block = renderContextBlock(ctx);
    expect(block).not.toContain("Non-Negotiable Global Rules");
    expect(block).toContain("Global Guidelines");
  });
});

describe("reference images render + ordering + cap", () => {
  it("renders references after memory and before the brief", () => {
    const ctx = assembleContext({
      brief: "BRIEF_TEXT",
      global: makeGlobal([]),
      memory: [feedback],
      references: [{ path: "brand/directions/x/assets/a.png", note: "warm" }],
    });
    const block = renderContextBlock(ctx);

    const refHeaderIdx = block.indexOf("## Reference Images");
    const memIdx = block.indexOf("Direction Memory");
    const briefIdx = block.indexOf("## Brief");

    expect(refHeaderIdx).toBeGreaterThanOrEqual(0);
    expect(block).toContain(
      "- brand/directions/x/assets/a.png — warm [intent: inspire]",
    );
    expect(refHeaderIdx).toBeGreaterThan(memIdx);
    expect(refHeaderIdx).toBeLessThan(briefIdx);
  });

  it("omits the note (and its separator) when a reference has none", () => {
    const ctx = assembleContext({
      brief: "B",
      global: makeGlobal([]),
      memory: [],
      references: [{ path: "brand/directions/x/assets/a.png" }],
    });
    const block = renderContextBlock(ctx);
    expect(block).toContain("\n- brand/directions/x/assets/a.png [intent: inspire]\n");
    expect(block).not.toContain("assets/a.png —");
  });

  it("annotates an extract-intent reference with its intent tag", () => {
    const ctx = assembleContext({
      brief: "B",
      global: makeGlobal([]),
      memory: [],
      references: [
        { path: "brand/directions/x/assets/a.png", note: "palette", intent: "extract" },
      ],
    });
    const block = renderContextBlock(ctx);
    expect(block).toContain(
      "- brand/directions/x/assets/a.png — palette [intent: extract]",
    );
  });

  it("renders nothing and stays byte-identical when references are empty/omitted", () => {
    const input = {
      brief: "BRIEF_TEXT",
      global: makeGlobal([hardA, guidelineB]),
      memory: [feedback],
    };
    const withoutRefs = renderContextBlock(assembleContext(input));
    const withEmptyRefs = renderContextBlock(assembleContext({ ...input, references: [] }));

    expect(withoutRefs).not.toContain("## Reference Images");
    expect(withEmptyRefs).toBe(withoutRefs);
  });

  it("caps references at MAX_CONTEXT_REFERENCES preserving order", () => {
    const refs: ReferenceItem[] = Array.from({ length: 9 }, (_, i) => ({
      path: `brand/directions/x/assets/${i}.png`,
    }));
    const ctx = assembleContext({
      brief: "B",
      global: makeGlobal([]),
      memory: [],
      references: refs,
    });

    expect(MAX_CONTEXT_REFERENCES).toBe(6);
    expect(ctx.references).toHaveLength(MAX_CONTEXT_REFERENCES);
    expect(ctx.references.map((r) => r.path)).toEqual(
      refs.slice(0, MAX_CONTEXT_REFERENCES).map((r) => r.path),
    );
  });

  it("keeps hard-rule precedence: hard → guidelines → memory → references → brief", () => {
    const ctx = assembleContext({
      brief: "BRIEF_TEXT",
      global: makeGlobal([hardA, guidelineB]),
      memory: [feedback],
      references: [{ path: "brand/directions/x/assets/a.png", note: "warm" }],
    });
    const block = renderContextBlock(ctx);

    const hardIdx = block.indexOf("Non-Negotiable Global Rules");
    const guideIdx = block.indexOf("Global Guidelines");
    const memIdx = block.indexOf("Direction Memory");
    const refIdx = block.indexOf("## Reference Images");
    const briefIdx = block.indexOf("## Brief");

    expect(hardIdx).toBeGreaterThanOrEqual(0);
    expect(hardIdx).toBeLessThan(guideIdx);
    expect(guideIdx).toBeLessThan(memIdx);
    expect(memIdx).toBeLessThan(refIdx);
    expect(refIdx).toBeLessThan(briefIdx);
  });
});

describe("pure / deterministic, no I/O", () => {
  it("produces identical output for identical input", () => {
    const input = {
      brief: "BRIEF_TEXT",
      global: makeGlobal([hardA, guidelineB]),
      memory: [feedback],
    };
    const a = renderContextBlock(assembleContext(input));
    const b = renderContextBlock(assembleContext(input));
    expect(a).toBe(b);
  });
});

describe("selectNegatives pulls only discard feedback", () => {
  const discard: ContextMemoryEntry = {
    kind: "feedback",
    body: "DISCARD_BODY",
    author: "serve",
    source: "element-feedback",
    date: "2026-06-30T00:00:00.000Z",
    asset: "brand/directions/x/assets/feedback/x.png",
  };
  const learningWithAsset: ContextMemoryEntry = {
    kind: "learning",
    body: "LEARNING_BODY",
    author: "agent",
    source: "audit",
    date: "2026-06-30T00:00:00.000Z",
    asset: "brand/directions/x/assets/feedback/y.png",
  };
  const colorLock: ContextMemoryEntry = {
    kind: "decision",
    body: "Color locked: #abc",
    author: "serve",
    source: "element-feedback",
    date: "2026-06-30T00:00:00.000Z",
  };

  it("returns exactly the discard body — feedback+asset only", () => {
    const negatives = selectNegatives([feedback, discard, learningWithAsset, colorLock]);
    expect(negatives).toEqual(["DISCARD_BODY"]);
  });

  it("treats a feedback entry with an empty-string asset as NOT a discard", () => {
    expect(selectNegatives([{ ...feedback, asset: "" }])).toEqual([]);
  });

  it("preserves order across multiple discards", () => {
    const second: ContextMemoryEntry = {
      ...discard,
      body: "DISCARD_TWO",
      asset: "brand/directions/x/assets/feedback/z.png",
    };
    expect(selectNegatives([discard, feedback, second])).toEqual(["DISCARD_BODY", "DISCARD_TWO"]);
  });
});

describe("assembleContext exposes negatives", () => {
  const discard: ContextMemoryEntry = {
    kind: "feedback",
    body: "DISCARD_BODY",
    author: "serve",
    source: "element-feedback",
    date: "2026-06-30T00:00:00.000Z",
    asset: "brand/directions/x/assets/feedback/x.png",
  };

  it("sets negatives to the discard bodies", () => {
    const ctx = assembleContext({
      brief: "BRIEF_TEXT",
      global: makeGlobal([]),
      memory: [feedback, discard],
    });
    expect(ctx.negatives).toEqual(["DISCARD_BODY"]);
  });

  it("returns negatives: [] when there are no discards", () => {
    const ctx = assembleContext({
      brief: "BRIEF_TEXT",
      global: makeGlobal([hardA]),
      memory: [feedback],
    });
    expect(ctx.negatives).toEqual([]);
  });

  it("does not change renderContextBlock output (byte-identical vs a plain-feedback context)", () => {
    const withDiscard = renderContextBlock(
      assembleContext({
        brief: "BRIEF_TEXT",
        global: makeGlobal([hardA, guidelineB]),
        memory: [{ ...discard, body: "Use a darker hero" }],
      }),
    );
    const asPlainFeedback = renderContextBlock(
      assembleContext({
        brief: "BRIEF_TEXT",
        global: makeGlobal([hardA, guidelineB]),
        memory: [feedback],
      }),
    );
    expect(withDiscard).toBe(asPlainFeedback);
  });
});

describe("recorded hex flows into deriveLocksFromContext", () => {
  it("extracts a color-lock decision hex as a PaletteLock", () => {
    const lock: ContextMemoryEntry = {
      kind: "decision",
      body: "Color locked: #3366cc",
      author: "serve",
      source: "element-feedback",
      date: "2026-06-30T00:00:00.000Z",
    };
    const ctx = assembleContext({ brief: "BRIEF_TEXT", global: makeGlobal([]), memory: [lock] });
    const locks = deriveLocksFromContext(renderContextBlock(ctx));
    expect(locks.some((l) => l.hex === "#3366cc")).toBe(true);
  });

  it("honors the MAX_CONTEXT_LOCKS cap (<= 4) with five distinct locked hexes", () => {
    const hexes = ["#111111", "#222222", "#333333", "#444444", "#555555"];
    const memory: ContextMemoryEntry[] = hexes.map((hex, i) => ({
      kind: "decision",
      body: `Color locked: ${hex}`,
      author: "serve",
      source: "element-feedback",
      date: `2026-06-30T00:00:0${i}.000Z`,
    }));
    const ctx = assembleContext({ brief: "BRIEF_TEXT", global: makeGlobal([]), memory });
    const locks = deriveLocksFromContext(renderContextBlock(ctx));
    expect(locks.length).toBeLessThanOrEqual(4);
  });
});

function makeRule(overrides: Partial<GlobalRule> = {}): GlobalRule {
  return {
    id: "r1",
    severity: "guideline",
    text: "Prefer generous whitespace",
    author: "tim",
    source: "cli",
    date: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<ContextMemoryEntry> = {}): ContextMemoryEntry {
  return {
    kind: "decision",
    body: "Use editorial typefaces",
    author: "tim",
    source: "cli",
    date: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectVisualDirectives — tiering + symmetry", () => {
  it("visual HARD rule goes to must regardless of polarity", () => {
    const result = selectVisualDirectives({
      hardRules: [makeRule({ severity: "hard", text: "Always use brand colors" })],
      guidelines: [],
      memory: [],
    });
    expect(result.must).toContain("Always use brand colors");
    expect(result.prefer).toHaveLength(0);
    expect(result.avoid).toHaveLength(0);
  });

  it("visual guideline with polarity prefer → prefer tier", () => {
    const result = selectVisualDirectives({
      hardRules: [],
      guidelines: [makeRule({ polarity: "prefer", text: "Prefer generous whitespace" })],
      memory: [],
    });
    expect(result.prefer).toContain("Prefer generous whitespace");
    expect(result.must).toHaveLength(0);
    expect(result.avoid).toHaveLength(0);
  });

  it("visual guideline with polarity avoid → avoid tier", () => {
    const result = selectVisualDirectives({
      hardRules: [],
      guidelines: [makeRule({ polarity: "avoid", text: "No harsh drop shadows" })],
      memory: [],
    });
    expect(result.avoid).toContain("No harsh drop shadows");
    expect(result.must).toHaveLength(0);
    expect(result.prefer).toHaveLength(0);
  });

  it("direction decision { channel: visual, polarity: prefer } → prefer tier", () => {
    const result = selectVisualDirectives({
      hardRules: [],
      guidelines: [],
      memory: [makeEntry({ kind: "decision", body: "Use bold imagery", channel: "visual", polarity: "prefer" })],
    });
    expect(result.prefer).toContain("Use bold imagery");
    expect(result.avoid).toHaveLength(0);
  });

  it("discard feedback (has asset) → avoid tier", () => {
    const result = selectVisualDirectives({
      hardRules: [],
      guidelines: [],
      memory: [makeEntry({ kind: "feedback", body: "Too minimal", asset: "brand/directions/x/assets/feedback/a.png" })],
    });
    expect(result.avoid).toContain("Too minimal");
    expect(result.prefer).toHaveLength(0);
    expect(result.must).toHaveLength(0);
  });

  it("each tier is independently populated — all present simultaneously", () => {
    const result = selectVisualDirectives({
      hardRules: [makeRule({ severity: "hard", text: "Always use brand palette" })],
      guidelines: [
        makeRule({ polarity: "prefer", text: "Prefer generous whitespace" }),
        makeRule({ polarity: "avoid", text: "No harsh drop shadows" }),
      ],
      memory: [
        makeEntry({ kind: "decision", body: "Use bold imagery", channel: "visual", polarity: "prefer" }),
        makeEntry({ kind: "feedback", body: "Too minimal", asset: "brand/directions/x/assets/feedback/a.png" }),
      ],
    });
    expect(result.must).toEqual(["Always use brand palette"]);
    expect(result.prefer).toEqual(["Prefer generous whitespace", "Use bold imagery"]);
    expect(result.avoid).toEqual(["No harsh drop shadows", "Too minimal"]);
  });
});

describe("selectVisualDirectives — copy-only excluded", () => {
  it("decision { channel: copy } does not appear in any tier", () => {
    const result = selectVisualDirectives({
      hardRules: [],
      guidelines: [],
      memory: [makeEntry({ kind: "decision", body: "Use active voice", channel: "copy" })],
    });
    expect(result.must).toHaveLength(0);
    expect(result.prefer).toHaveLength(0);
    expect(result.avoid).toHaveLength(0);
  });

  it("plain learning (heuristic ⇒ copy) does not appear in any tier", () => {
    const result = selectVisualDirectives({
      hardRules: [],
      guidelines: [],
      memory: [makeEntry({ kind: "learning", body: "Serifs tested well with users" })],
    });
    expect(result.must).toHaveLength(0);
    expect(result.prefer).toHaveLength(0);
    expect(result.avoid).toHaveLength(0);
  });

  it("channel: both entry DOES appear (both reaches the image lane)", () => {
    const result = selectVisualDirectives({
      hardRules: [],
      guidelines: [],
      memory: [makeEntry({ kind: "decision", body: "Warm, editorial tone", channel: "both", polarity: "prefer" })],
    });
    expect(result.prefer).toContain("Warm, editorial tone");
  });
});

describe("selectVisualDirectives — retired/superseded skipped", () => {
  it("entry with retiredAt is not in any tier", () => {
    const result = selectVisualDirectives({
      hardRules: [],
      guidelines: [],
      memory: [
        makeEntry({ kind: "decision", body: "Old direction", channel: "visual", polarity: "prefer", retiredAt: "2026-07-01T00:00:00.000Z" }),
      ],
    });
    expect(result.prefer).not.toContain("Old direction");
    expect(result.must).toHaveLength(0);
    expect(result.avoid).toHaveLength(0);
  });

  it("entry with supersededBy is not in any tier", () => {
    const result = selectVisualDirectives({
      hardRules: [],
      guidelines: [],
      memory: [
        makeEntry({ kind: "decision", body: "Superseded direction", channel: "visual", polarity: "prefer", supersededBy: "entry-new-id" }),
      ],
    });
    expect(result.prefer).not.toContain("Superseded direction");
  });

  it("a non-retired sibling still appears alongside a retired entry", () => {
    const result = selectVisualDirectives({
      hardRules: [],
      guidelines: [],
      memory: [
        makeEntry({ kind: "decision", body: "Old direction", channel: "visual", polarity: "prefer", retiredAt: "2026-07-01T00:00:00.000Z" }),
        makeEntry({ kind: "decision", body: "Active direction", channel: "visual", polarity: "prefer" }),
      ],
    });
    expect(result.prefer).toEqual(["Active direction"]);
  });
});

describe("selectVisualDirectives — back-compat / heuristic", () => {
  it("hard rule with avoid-wording still goes to MUST (hard rules are always MUST)", () => {
    const result = selectVisualDirectives({
      hardRules: [makeRule({ severity: "hard", text: "Never use a fist-in-the-air icon" })],
      guidelines: [],
      memory: [],
    });
    expect(result.must).toContain("Never use a fist-in-the-air icon");
    expect(result.avoid).not.toContain("Never use a fist-in-the-air icon");
  });

  it("legacy guideline 'no gradients' (no metadata) → heuristic polarity avoid → avoid tier", () => {
    const result = selectVisualDirectives({
      hardRules: [],
      guidelines: [makeRule({ text: "no gradients", severity: "guideline" })],
      memory: [],
    });
    expect(result.avoid).toContain("no gradients");
  });

  it("legacy decision 'prefer generous whitespace' (no metadata) → heuristic prefer → prefer tier", () => {
    const result = selectVisualDirectives({
      hardRules: [],
      guidelines: [],
      memory: [makeEntry({ kind: "decision", body: "prefer generous whitespace" })],
    });
    expect(result.prefer).toContain("prefer generous whitespace");
  });

  it("legacy guideline (no metadata) defaults to visual channel via heuristic", () => {
    const result = selectVisualDirectives({
      hardRules: [],
      guidelines: [makeRule({ text: "Use warm color palettes", severity: "guideline" })],
      memory: [],
    });
    expect(result.prefer).toContain("Use warm color palettes");
  });
});

describe("selectVisualDirectives — renderContextBlock byte-unchanged", () => {
  it("adding visualDirectives does not change renderContextBlock output", () => {
    const ctx = assembleContext({
      brief: "A modern fintech brand",
      global: makeGlobal([
        makeRule({ severity: "hard", text: "Always use brand palette", id: "r1" }),
        makeRule({ severity: "guideline", text: "Prefer generous whitespace", id: "r2", polarity: "prefer" }),
      ]),
      memory: [
        makeEntry({ kind: "decision", body: "Use bold imagery", channel: "visual", polarity: "prefer" }),
        makeEntry({ kind: "feedback", body: "Too minimal", asset: "brand/directions/x/assets/feedback/a.png" }),
      ],
    });

    const expected =
      "## Non-Negotiable Global Rules (HARD — always obey, override everything below)\n" +
      "- Always use brand palette\n\n" +
      "## Global Guidelines (strong defaults)\n" +
      "- Prefer generous whitespace\n\n" +
      "## Direction Memory (exploratory — must yield to the hard rules above)\n" +
      "- [decision] Use bold imagery\n" +
      "- [feedback] Too minimal\n\n" +
      "## Brief\n" +
      "A modern fintech brand";

    expect(renderContextBlock(ctx)).toBe(expected);
    expect(ctx.visualDirectives.must).toContain("Always use brand palette");
    expect(renderContextBlock(ctx)).toBe(expected);
  });
});

describe("selectVisualDirectives — purity / determinism", () => {
  it("same inputs produce equal arrays (two calls)", () => {
    const input = {
      hardRules: [makeRule({ severity: "hard", text: "Always use brand palette" })],
      guidelines: [makeRule({ polarity: "prefer", text: "Prefer generous whitespace" })],
      memory: [makeEntry({ kind: "decision", body: "Bold imagery", channel: "visual", polarity: "prefer" })],
    };
    const a = selectVisualDirectives(input);
    const b = selectVisualDirectives(input);
    expect(a).toEqual(b);
  });

  it("does not mutate its inputs", () => {
    const hardRules = [makeRule({ severity: "hard", text: "Hard rule" })];
    const guidelines = [makeRule({ polarity: "prefer", text: "Guideline" })];
    const memory = [makeEntry({ kind: "decision", body: "Entry" })];
    const hardBefore = [...hardRules];
    const guideBefore = [...guidelines];
    const memBefore = [...memory];
    selectVisualDirectives({ hardRules, guidelines, memory });
    expect(hardRules).toEqual(hardBefore);
    expect(guidelines).toEqual(guideBefore);
    expect(memory).toEqual(memBefore);
  });
});

describe("selectNegatives skips retired discards", () => {
  const liveDiscard: ContextMemoryEntry = {
    kind: "feedback",
    body: "LIVE_DISCARD",
    author: "serve",
    source: "element-feedback",
    date: "2026-07-01T00:00:00.000Z",
    asset: "brand/directions/x/assets/feedback/a.png",
  };
  const retiredByRetiredAt: ContextMemoryEntry = {
    kind: "feedback",
    body: "RETIRED_AT_DISCARD",
    author: "serve",
    source: "element-feedback",
    date: "2026-07-01T00:00:00.000Z",
    asset: "brand/directions/x/assets/feedback/b.png",
    retiredAt: "2026-07-14T00:00:00.000Z",
  };
  const retiredBySupersededBy: ContextMemoryEntry = {
    kind: "feedback",
    body: "SUPERSEDED_BY_DISCARD",
    author: "serve",
    source: "element-feedback",
    date: "2026-07-01T00:00:00.000Z",
    asset: "brand/directions/x/assets/feedback/c.png",
    supersededBy: "entry-winner-99",
  };

  it("returns only the live discard body; retired discards are excluded", () => {
    const negatives = selectNegatives([liveDiscard, retiredByRetiredAt, retiredBySupersededBy]);
    expect(negatives).toEqual(["LIVE_DISCARD"]);
  });

  it("a non-retired discard is still included", () => {
    expect(selectNegatives([liveDiscard])).toEqual(["LIVE_DISCARD"]);
  });
});

describe("retired global rule assembly", () => {
  const liveHard: GlobalRule = {
    id: "rule-hard-live",
    severity: "hard",
    text: "LIVE_HARD_RULE",
    author: "tim",
    source: "cli",
    date: "2026-07-01T00:00:00.000Z",
  };
  const retiredHard: GlobalRule = {
    id: "rule-hard-retired",
    severity: "hard",
    text: "RETIRED_HARD_RULE",
    author: "tim",
    source: "cli",
    date: "2026-07-01T00:00:00.000Z",
    retiredAt: "2026-07-15T00:00:00.000Z",
  };
  const liveGuideline: GlobalRule = {
    id: "rule-guide-live",
    severity: "guideline",
    text: "LIVE_GUIDELINE",
    author: "tim",
    source: "cli",
    date: "2026-07-01T00:00:00.000Z",
    polarity: "prefer",
  };
  const retiredGuideline: GlobalRule = {
    id: "rule-guide-retired",
    severity: "guideline",
    text: "RETIRED_GUIDELINE",
    author: "tim",
    source: "cli",
    date: "2026-07-01T00:00:00.000Z",
    polarity: "avoid",
    retiredAt: "2026-07-15T00:00:00.000Z",
  };

  it("Test 12: a retired hard rule + retired guideline reach no lane; live rules present", () => {
    const ctx = assembleContext({
      brief: "BRIEF",
      global: makeGlobal([liveHard, liveGuideline, retiredHard, retiredGuideline]),
      memory: [],
    });

    expect(ctx.hardRules).toEqual([liveHard]);
    expect(ctx.guidelines).toEqual([liveGuideline]);

    const block = renderContextBlock(ctx);
    expect(block).toContain("LIVE_HARD_RULE");
    expect(block).toContain("LIVE_GUIDELINE");
    expect(block).not.toContain("RETIRED_HARD_RULE");
    expect(block).not.toContain("RETIRED_GUIDELINE");

    expect(ctx.visualDirectives.must).toContain("LIVE_HARD_RULE");
    expect(ctx.visualDirectives.must).not.toContain("RETIRED_HARD_RULE");
    expect(ctx.visualDirectives.prefer).not.toContain("RETIRED_GUIDELINE");
    expect(ctx.visualDirectives.avoid).not.toContain("RETIRED_GUIDELINE");
  });

  it("Test 10: assembleContext resolves two scopes — hardRules/guidelines/memory/references/visualDirectives.must", () => {
    const liveA = makeEntry({ kind: "decision", body: "Dir-A live decision", channel: "visual", polarity: "prefer" });
    const retiredA = makeEntry({
      kind: "feedback",
      body: "Dir-A retired discard",
      asset: "brand/directions/a/assets/feedback/r.png",
      retiredAt: "2026-07-15T00:00:00.000Z",
    });
    const liveB = makeEntry({ kind: "learning", body: "Dir-A another live entry" });
    const refs: ReferenceItem[] = Array.from({ length: 8 }, (_, i) => ({ path: `a-${i}.png` }));

    const ctx = assembleContext({
      brief: "BRIEF",
      global: makeGlobal([hardA, guidelineB]),
      memory: [liveA, retiredA, liveB],
      references: refs,
    });

    expect(ctx.hardRules).toEqual([hardA]);
    expect(ctx.guidelines).toEqual([guidelineB]);
    expect(ctx.memory).toEqual([liveA, retiredA, liveB]); // straight passthrough — no filter
    expect(ctx.references).toHaveLength(MAX_CONTEXT_REFERENCES);
    expect(ctx.visualDirectives.must).toContain(hardA.text);
  });

  it("Test 11: a sibling's memory is unreachable — never appears in renderContextBlock or visualDirectives.avoid", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-sibling-"));
    try {
      const config = makeConfig(path.join(tmpDir, "brand", "directions"));
      const core = createDirectionCore(tmpDir, config);
      await core.create({ id: "a", name: "A" });
      await core.create({ id: "b", name: "B" });

      await core.appendDecision("a", { body: "A_ONLY_TEXT", author: "tim", source: "cli", channel: "visual", polarity: "prefer" });
      // Worded to classify as avoid so a leak would be visible.
      await core.appendDecision("b", { body: "never use B_SIBLING_TEXT", author: "tim", source: "cli", channel: "visual", polarity: "avoid" });

      const memoryA = (await core.memoryEntries("a")) as ContextMemoryEntry[];
      const ctx = assembleContext({ brief: "BRIEF", global: makeGlobal([]), memory: memoryA });

      expect(renderContextBlock(ctx)).not.toContain("B_SIBLING_TEXT");
      expect(ctx.visualDirectives.avoid).not.toContain("never use B_SIBLING_TEXT");
      expect(ctx.visualDirectives.prefer).toContain("A_ONLY_TEXT");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("Test 9b (caller-boundary filter): a retired color-lock is excluded via the memoryEntries default", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-retire-rule-"));
    try {
      const config = makeConfig(path.join(tmpDir, "brand", "directions"));
      const core = createDirectionCore(tmpDir, config);
      await core.create({ id: "moody", name: "Moody" });

      const mem = await core.recordColorLock("moody", { hex: "#aa1122", author: "serve", source: "element-feedback" });
      const retireTarget = mem.entries[0];
      await core.recordColorLock("moody", { hex: "#22bb44", author: "serve", source: "element-feedback" });

      await core.retireMemoryEntry("moody", {
        entryId: retireTarget.id,
        author: "tim",
        source: "cli",
        reason: "wrong hue",
      });

      const memory = (await core.memoryEntries("moody")) as ContextMemoryEntry[];
      const ctx = assembleContext({ brief: "BRIEF", global: makeGlobal([]), memory });
      const block = renderContextBlock(ctx);

      expect(block).not.toContain("#aa1122");
      expect(block).toContain("#22bb44");

      const locks = deriveLocksFromContext(block);
      expect(locks.some((l) => l.hex === "#aa1122")).toBe(false);
      expect(locks.some((l) => l.hex === "#22bb44")).toBe(true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("Test: BYTE-IDENTICAL no-retired-rule path matches the baseline", () => {
    const ctx = assembleContext({
      brief: "A modern fintech brand",
      global: makeGlobal([hardA, guidelineB]),
      memory: [feedback],
    });
    const expected =
      "## Non-Negotiable Global Rules (HARD — always obey, override everything below)\n" +
      "- Never use pure black backgrounds\n\n" +
      "## Global Guidelines (strong defaults)\n" +
      "- Prefer generous whitespace\n\n" +
      "## Direction Memory (exploratory — must yield to the hard rules above)\n" +
      "- [feedback] Use a darker hero\n\n" +
      "## Brief\n" +
      "A modern fintech brand";
    expect(renderContextBlock(ctx)).toBe(expected);
    expect(ctx.hardRules).toEqual([hardA]);
    expect(ctx.guidelines).toEqual([guidelineB]);
  });

  it("Test: a legacy reconcile-retired entry still reads retired and is absent from every lane", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-retire-legacy-"));
    try {
      const config = makeConfig(path.join(tmpDir, "brand", "directions"));
      const core = createDirectionCore(tmpDir, config);
      await core.create({ id: "moody", name: "Moody" });

      const mem = await core.appendDecision("moody", {
        body: "LEGACY_RECONCILED_ENTRY",
        author: "tim",
        source: "cli",
        channel: "visual",
        polarity: "prefer",
      });
      const target = mem.entries[0];

      await core.retireMemoryEntry("moody", {
        entryId: target.id,
        author: "tim",
        source: "reconcile",
        supersededBy: "decision-newer",
      });

      const memAfter = await core.readMemory("moody");
      const legacyRetired = memAfter.entries.find((e) => e.id === target.id)!;
      expect(isRetired(legacyRetired)).toBe(true);

      const defaultView = await core.memoryEntries("moody");
      expect(defaultView.some((e) => e.id === target.id)).toBe(false);

      const memory = defaultView as ContextMemoryEntry[];
      const ctx = assembleContext({ brief: "BRIEF", global: makeGlobal([]), memory });
      expect(renderContextBlock(ctx)).not.toContain("LEGACY_RECONCILED_ENTRY");
      expect(ctx.visualDirectives.prefer).not.toContain("LEGACY_RECONCILED_ENTRY");
      expect(ctx.negatives).not.toContain("LEGACY_RECONCILED_ENTRY");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
