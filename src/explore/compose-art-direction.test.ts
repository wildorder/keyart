import { describe, it, expect } from "vitest";
import {
  composeArtDirection,
  renderArtDirectionPrecedence,
} from "./compose-art-direction.js";
import {
  composeNegativesBlock,
  composeLockedColorsGuidance,
} from "./token-intent.js";
import {
  assembleContext,
  renderContextBlock,
  type AssembledContext,
  type ContextMemoryEntry,
  type VisualDirectives,
} from "../brand/assemble-context.js";
import type { GlobalBrand, GlobalRule } from "../brand/schema.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeGlobal(rules: GlobalRule[]): GlobalBrand {
  return {
    approvedPointer: null,
    rules,
    version: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

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

/** Build an AssembledContext with explicit visualDirectives (for unit tests
 *  that need to set the tiers directly without going through classifyDirective). */
function makeCtx(vis: Partial<VisualDirectives> = {}, extra: Partial<AssembledContext> = {}): AssembledContext {
  return {
    brief: "A modern fintech brand",
    hardRules: [],
    guidelines: [],
    memory: [],
    references: [],
    negatives: [],
    visualDirectives: {
      must: vis.must ?? [],
      prefer: vis.prefer ?? [],
      avoid: vis.avoid ?? [],
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// B7: BYTE-IDENTICAL no-directive path (SC-11 — THE headline test)
// ---------------------------------------------------------------------------

describe("B7: no-directive path is byte-identical to today's null path (SC-11)", () => {
  it("composeArtDirection with empty visualDirectives returns empty string", () => {
    const ctx = makeCtx();
    expect(composeArtDirection(ctx, {})).toBe("");
  });

  it("no-directive call with empty lockedColors and no oneShot returns empty string", () => {
    const ctx = makeCtx();
    const tail = composeArtDirection(ctx, { lockedColors: [], oneShot: undefined });
    expect(tail).toBe("");
  });

  it("caller pattern: base + tail produces byte-identical result to no-append path", () => {
    const ctx = makeCtx();
    const base = "A style tile for Brand X";
    const tail = composeArtDirection(ctx, { lockedColors: [], oneShot: undefined });
    // Today's behavior: composeNegativesBlock([]) === null, composeLockedColorsGuidance([]) === null
    // so nothing is appended. The compiler must reproduce this byte-for-byte.
    expect(composeNegativesBlock([])).toBeNull();
    expect(composeLockedColorsGuidance([])).toBeNull();
    expect(base + (tail ? "\n\n" + tail : "")).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// B8: AVOID byte-parity with composeNegativesBlock (SC-11)
// ---------------------------------------------------------------------------

describe("B8: AVOID block is byte-identical to composeNegativesBlock for the discard-only case", () => {
  it("avoid-only context matches composeNegativesBlock output exactly", () => {
    const negatives = ["fist-in-the-air icons", "harsh drop shadows"];
    const ctx = makeCtx({ avoid: negatives });
    const compilerOut = composeArtDirection(ctx);
    const legacyOut = composeNegativesBlock(negatives);
    expect(legacyOut).not.toBeNull();
    expect(compilerOut).toBe(legacyOut);
  });

  it("single negative entry also matches", () => {
    const negatives = ["heavy drop shadows"];
    const ctx = makeCtx({ avoid: negatives });
    expect(composeArtDirection(ctx)).toBe(composeNegativesBlock(negatives));
  });
});

// ---------------------------------------------------------------------------
// B9: Soft color guidance byte-parity with composeLockedColorsGuidance (SC-04/SC-11)
// ---------------------------------------------------------------------------

describe("B9: color guidance is byte-identical to composeLockedColorsGuidance", () => {
  it("no directives + lockedColors yields the same string as composeLockedColorsGuidance", () => {
    const locked = ["#123456", "#abcdef"];
    const ctx = makeCtx();
    const compilerOut = composeArtDirection(ctx, { lockedColors: locked });
    const legacyOut = composeLockedColorsGuidance(locked);
    expect(legacyOut).not.toBeNull();
    expect(compilerOut).toBe(legacyOut);
  });

  it("dedupes case-insensitively (matching composeLockedColorsGuidance behavior)", () => {
    const ctx = makeCtx();
    const out = composeArtDirection(ctx, { lockedColors: ["#AABBCC", "#aabbcc"] });
    expect(out).toBe(composeLockedColorsGuidance(["#AABBCC", "#aabbcc"]));
  });
});

// ---------------------------------------------------------------------------
// B10: Precedence order + labels (SC-06)
// ---------------------------------------------------------------------------

describe("B10: precedence order is MUST ▸ one-shot ▸ PREFER ▸ AVOID ▸ color (SC-06)", () => {
  it("all five segments appear in strict monotonically-increasing order", () => {
    const ctx = makeCtx({
      must: ["Always use brand colors"],
      prefer: ["Prefer generous whitespace"],
      avoid: ["No harsh drop shadows"],
    });
    const out = composeArtDirection(ctx, {
      oneShot: "Lean into brutalist grid layouts",
      lockedColors: ["#123456"],
    });

    const mustIdx = out.indexOf("MUST (non-negotiable");
    const oneShotIdx = out.indexOf("Additional art direction (this pass only):");
    const preferIdx = out.indexOf("PREFER (do):");
    const avoidIdx = out.indexOf("AVOID (do not use):");
    const colorIdx = out.indexOf("COLOR GUIDANCE (soft):");

    expect(mustIdx).toBeGreaterThanOrEqual(0);
    expect(oneShotIdx).toBeGreaterThanOrEqual(0);
    expect(preferIdx).toBeGreaterThanOrEqual(0);
    expect(avoidIdx).toBeGreaterThanOrEqual(0);
    expect(colorIdx).toBeGreaterThanOrEqual(0);

    expect(mustIdx).toBeLessThan(oneShotIdx);
    expect(oneShotIdx).toBeLessThan(preferIdx);
    expect(preferIdx).toBeLessThan(avoidIdx);
    expect(avoidIdx).toBeLessThan(colorIdx);
  });

  it("one-shot text appears verbatim in the output", () => {
    const ctx = makeCtx({ must: ["Brand colors always"] });
    const out = composeArtDirection(ctx, { oneShot: "  Use raw concrete textures  " });
    expect(out).toContain("Additional art direction (this pass only): Use raw concrete textures");
  });

  it("blank one-shot is omitted", () => {
    const ctx = makeCtx({ must: ["Brand colors"] });
    const out = composeArtDirection(ctx, { oneShot: "   " });
    expect(out).not.toContain("Additional art direction");
  });
});

// ---------------------------------------------------------------------------
// B11: Symmetry — each tier is independently omissible (SC-04)
// ---------------------------------------------------------------------------

describe("B11: each tier is independently omissible (SC-04)", () => {
  it("prefer-only context renders PREFER block and no AVOID or MUST", () => {
    const ctx = makeCtx({ prefer: ["Prefer editorial typefaces"] });
    const out = composeArtDirection(ctx);
    expect(out).toContain("PREFER (do):");
    expect(out).not.toContain("MUST (non-negotiable");
    expect(out).not.toContain("AVOID (do not use):");
  });

  it("must-only context renders MUST block and no PREFER or AVOID", () => {
    const ctx = makeCtx({ must: ["Always use brand colors"] });
    const out = composeArtDirection(ctx);
    expect(out).toContain("MUST (non-negotiable");
    expect(out).not.toContain("PREFER (do):");
    expect(out).not.toContain("AVOID (do not use):");
  });

  it("avoid-only context renders AVOID block and no MUST or PREFER", () => {
    const ctx = makeCtx({ avoid: ["No harsh drop shadows"] });
    const out = composeArtDirection(ctx);
    expect(out).toContain("AVOID (do not use):");
    expect(out).not.toContain("MUST (non-negotiable");
    expect(out).not.toContain("PREFER (do):");
  });

  it("color guidance appears alone when there are no directives but lockedColors present", () => {
    const ctx = makeCtx();
    const out = composeArtDirection(ctx, { lockedColors: ["#abc123"] });
    expect(out).toContain("COLOR GUIDANCE (soft):");
    expect(out).not.toContain("MUST");
    expect(out).not.toContain("PREFER");
    expect(out).not.toContain("AVOID");
  });
});

// ---------------------------------------------------------------------------
// B12: Purity / determinism (SC-11)
// ---------------------------------------------------------------------------

describe("B12: purity and determinism (SC-11)", () => {
  it("two calls with the same inputs return identical strings", () => {
    const ctx = makeCtx({ must: ["Always use brand colors"], prefer: ["Prefer whitespace"] });
    const a = composeArtDirection(ctx, { oneShot: "Lean into brutalism", lockedColors: ["#123456"] });
    const b = composeArtDirection(ctx, { oneShot: "Lean into brutalism", lockedColors: ["#123456"] });
    expect(a).toBe(b);
  });

  it("the input assembled context is not mutated", () => {
    const ctx = makeCtx({ must: ["Hard rule"], prefer: ["Prefer rule"], avoid: ["Avoid rule"] });
    const mustBefore = [...ctx.visualDirectives.must];
    const preferBefore = [...ctx.visualDirectives.prefer];
    const avoidBefore = [...ctx.visualDirectives.avoid];
    composeArtDirection(ctx, { lockedColors: ["#aabbcc"], oneShot: "test" });
    expect(ctx.visualDirectives.must).toEqual(mustBefore);
    expect(ctx.visualDirectives.prefer).toEqual(preferBefore);
    expect(ctx.visualDirectives.avoid).toEqual(avoidBefore);
  });
});

// ---------------------------------------------------------------------------
// B13: Snapshot ladder projection (SC-06)
// ---------------------------------------------------------------------------

describe("B13: renderArtDirectionPrecedence snapshot ladder (SC-06)", () => {
  const prohibition = "Never use a fist-in-the-air icon";
  const ctxFull = assembleContext({
    brief: "Modern fintech brand",
    global: makeGlobal([
      makeRule({ id: "r-hard", severity: "hard", text: prohibition }),
      makeRule({ id: "r-guide", severity: "guideline", text: "Prefer generous whitespace", polarity: "prefer" }),
    ]),
    memory: [
      makeEntry({ kind: "decision", body: "Use editorial typefaces", channel: "visual", polarity: "prefer" }),
      makeEntry({ kind: "feedback", body: "Too stock-photo", asset: "brand/directions/x/assets/feedback/a.png" }),
    ],
  });

  it("output begins with the dedicated heading", () => {
    const out = renderArtDirectionPrecedence(ctxFull);
    expect(out.startsWith("## Art-direction precedence")).toBe(true);
  });

  it("contains all six rung labels in strict order", () => {
    const out = renderArtDirectionPrecedence(ctxFull, { oneShot: "Lean brutalist" });
    const labels = [
      "1. MUST — global hard rules",
      "2. LIVE — this-pass one-shot",
      "3. PREFER/AVOID — global guidelines",
      "4. PREFER/AVOID — direction decisions",
      "5. AVOID — discard feedback",
      "6. BRIEF — direction content/brief",
    ];
    let prev = -1;
    for (const label of labels) {
      const idx = out.indexOf(label);
      expect(idx).toBeGreaterThan(prev);
      prev = idx;
    }
  });

  it("hard prohibition stays under MUST (not demoted to AVOID)", () => {
    const out = renderArtDirectionPrecedence(ctxFull);
    const mustIdx = out.indexOf("1. MUST — global hard rules");
    const prohibIdx = out.indexOf(prohibition);
    const avoidIdx = out.indexOf("5. AVOID — discard feedback");
    expect(prohibIdx).toBeGreaterThan(mustIdx);
    expect(prohibIdx).toBeLessThan(avoidIdx);
  });

  it("shows (none) for empty rungs", () => {
    const emptyCtx = assembleContext({
      brief: "",
      global: makeGlobal([]),
      memory: [],
    });
    const out = renderArtDirectionPrecedence(emptyCtx);
    // With nothing present, several rungs should show (none)
    const noneCount = (out.match(/\(none\)/g) ?? []).length;
    expect(noneCount).toBeGreaterThanOrEqual(4);
  });

  it("is byte-identical for equal inputs", () => {
    const a = renderArtDirectionPrecedence(ctxFull, { oneShot: "Brutalist grid" });
    const b = renderArtDirectionPrecedence(ctxFull, { oneShot: "Brutalist grid" });
    expect(a).toBe(b);
  });

  it("renderContextBlock is unchanged by renderArtDirectionPrecedence", () => {
    const textOut = renderContextBlock(ctxFull);
    renderArtDirectionPrecedence(ctxFull, { oneShot: "Test" });
    expect(renderContextBlock(ctxFull)).toBe(textOut);
  });

  it("discard body appears under AVOID — discard feedback rung", () => {
    const out = renderArtDirectionPrecedence(ctxFull);
    const discardIdx = out.indexOf("5. AVOID — discard feedback");
    const bodyIdx = out.indexOf("Too stock-photo");
    expect(bodyIdx).toBeGreaterThan(discardIdx);
  });
});
