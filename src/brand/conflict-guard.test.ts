import { describe, it, expect, vi } from "vitest";
import type { MemoryEntry } from "../direction/schema.js";
import type { GlobalRule } from "./schema.js";
import type { Contradiction, ContradictionInput } from "./conflict-guard.js";
import {
  detectContradictionsDeterministic,
  detectContradictions,
  hardRuleGuardWarnings,
} from "./conflict-guard.js";

// ── Fixtures ───────────────────────────────────────────────────────────────────

function rule(id: string, text: string, severity: "hard" | "guideline" = "hard"): GlobalRule {
  return { id, severity, text, author: "tim", source: "cli", date: "2026-01-01T00:00:00Z" };
}

function memEntry(id: string, body: string, kind: MemoryEntry["kind"] = "feedback"): MemoryEntry {
  return { id, kind, body, author: "tim", source: "cli", date: "2026-01-01T00:00:00Z" };
}

const RULE_NO_PURE_BLACK = rule("r1", "Never use pure black (#000)");
const GUIDELINE_WARM = rule("g1", "Prefer warm, earthy tones", "guideline");
const MEM_ENTRY = memEntry("m1", "loves warm editorial photography");

function baseInput(overrides: Partial<ContradictionInput> = {}): ContradictionInput {
  return {
    liveInstruction: "",
    liveInstructionId: "live:test:run",
    hardRules: [RULE_NO_PURE_BLACK],
    guidelines: [GUIDELINE_WARM],
    memory: [MEM_ENTRY],
    ...overrides,
  };
}

// A synthetic memory-vs-memory contradiction for the semantic adapter mock
const MEMORY_VS_MEMORY_CASE: Contradiction = {
  id: "memory-vs-memory::m1::m2",
  kind: "memory-vs-memory",
  subject: { source: "memory", id: "m1", text: "loves warm editorial photography" },
  conflictsWith: { source: "memory", id: "m2", text: "avoid warm colors" },
  severity: "info",
  explanation: "Memory entries conflict on warm vs. cool.",
  suggestions: ["retire"],
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("detectContradictionsDeterministic — floor (SC-07)", () => {
  it("detects a negation clash: live tweak vs a hard prohibition (SC-07 test 1)", () => {
    const result = detectContradictionsDeterministic(
      baseInput({ liveInstruction: "make the background pure black" }),
    );
    expect(result).toHaveLength(1);
    const c = result[0];
    expect(c.kind).toBe("live-vs-hardrule");
    expect(c.severity).toBe("warning");
    expect(c.conflictsWith.id).toBe(RULE_NO_PURE_BLACK.id);
    expect(c.conflictsWith.source).toBe("hard-rule");
    expect(c.subject.source).toBe("live");
    expect(c.subject.id).toBe("live:test:run");
    expect(c.subject.text).toBe("make the background pure black");
    expect(c.explanation.length).toBeGreaterThan(0);
    expect(c.suggestions).toContain("keep");
  });

  it("is quiet on an unrelated tweak — no false positive (SC-07 test 2)", () => {
    const result = detectContradictionsDeterministic(
      baseInput({ liveInstruction: "warmer, more editorial" }),
    );
    // "warmer" / "more" / "editorial" share no content tokens with "pure" / "black"
    expect(result).toEqual([]);
  });

  it("returns [] when liveInstruction is empty (no live steer)", () => {
    const result = detectContradictionsDeterministic(baseInput({ liveInstruction: "" }));
    expect(result).toEqual([]);
  });

  it("the deterministic id is stable across multiple calls with the same inputs", () => {
    const input = baseInput({ liveInstruction: "make the background pure black" });
    const r1 = detectContradictionsDeterministic(input);
    const r2 = detectContradictionsDeterministic(input);
    expect(r1[0].id).toBe(r2[0].id);
  });
});

describe("detectContradictions PORT — with a mocked semantic adapter (SC-07)", () => {
  it("composes floor ∪ mocked semantic case, deduped (test 3)", async () => {
    const semanticMock = vi.fn(async () => [MEMORY_VS_MEMORY_CASE]);
    const input = baseInput({ liveInstruction: "make the background pure black" });

    const report = await detectContradictions(input, { semantic: semanticMock });

    expect(report.detector).toBe("deterministic+semantic");
    // Floor found a live-vs-hardrule case; semantic mock added a memory-vs-memory case.
    expect(report.items.length).toBeGreaterThanOrEqual(2);
    const kinds = report.items.map((c) => c.kind);
    expect(kinds).toContain("live-vs-hardrule");
    expect(kinds).toContain("memory-vs-memory");
    // The semantic mock was awaited exactly once.
    expect(semanticMock).toHaveBeenCalledTimes(1);
  });

  it("dedupes: a contradiction present in both floor and semantic is listed once", async () => {
    const input = baseInput({ liveInstruction: "make the background pure black" });
    const floorCase = detectContradictionsDeterministic(input)[0];
    // Semantic returns the same case the floor already found.
    const semanticMock = vi.fn(async () => [floorCase]);

    const report = await detectContradictions(input, { semantic: semanticMock });

    const matchingIds = report.items.filter((c) => c.id === floorCase.id);
    expect(matchingIds).toHaveLength(1);
  });

  it("no adapter ⇒ floor only, detector=deterministic (test 4)", async () => {
    const input = baseInput({ liveInstruction: "make the background pure black" });
    const report = await detectContradictions(input);

    expect(report.detector).toBe("deterministic");
    const floor = detectContradictionsDeterministic(input);
    expect(report.items).toEqual(floor);
  });

  it("no adapter — never touches a model and never claims memory-vs-memory (SC-11)", async () => {
    const input = baseInput({ liveInstruction: "make the background pure black" });
    const report = await detectContradictions(input);

    const kinds = report.items.map((c) => c.kind);
    expect(kinds).not.toContain("memory-vs-memory");
    expect(kinds).not.toContain("live-vs-memory");
  });

  it("a throwing semantic adapter degrades to the floor, never throws (test 5)", async () => {
    const input = baseInput({ liveInstruction: "make the background pure black" });
    const semanticMock = vi.fn(async (): Promise<Contradiction[]> => {
      throw new Error("boom");
    });

    const report = await detectContradictions(input, { semantic: semanticMock });

    // The port caught the throw and fell back to the floor.
    expect(report.detector).toBe("deterministic");
    const floor = detectContradictionsDeterministic(input);
    expect(report.items).toEqual(floor);
  });
});

describe("hardRuleGuardWarnings (SC-08 test 6)", () => {
  it("filters to live-vs-hardrule subset only, ignoring other kinds", () => {
    const liveVsHard: Contradiction = {
      id: "live-vs-hardrule::live:test:run::r1",
      kind: "live-vs-hardrule",
      subject: { source: "live", id: "live:test:run", text: "pure black" },
      conflictsWith: { source: "hard-rule", id: "r1", text: "Never use pure black" },
      severity: "warning",
      explanation: "Clash.",
      suggestions: ["keep"],
    };
    const liveVsGuideline: Contradiction = {
      id: "live-vs-guideline::live:test:run::g1",
      kind: "live-vs-guideline",
      subject: { source: "live", id: "live:test:run", text: "cool minimalist" },
      conflictsWith: { source: "guideline", id: "g1", text: "Prefer warm" },
      severity: "info",
      explanation: "Soft clash.",
      suggestions: ["keep"],
    };
    const memVsMem = MEMORY_VS_MEMORY_CASE;

    const warnings = hardRuleGuardWarnings([liveVsHard, liveVsGuideline, memVsMem]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0].code).toBe("hard-rule-conflict");
    expect(warnings[0].severity).toBe("warning");
    expect(warnings[0].contradictionId).toBe(liveVsHard.id);
    expect(warnings[0].message.length).toBeGreaterThan(0);
    // Message must not claim the live text was removed from the compiled prompt.
    expect(warnings[0].message.toLowerCase()).not.toContain("removed");
    expect(warnings[0].message.toLowerCase()).not.toContain("deleted");
  });

  it("returns [] when there are no live-vs-hardrule contradictions", () => {
    const warnings = hardRuleGuardWarnings([MEMORY_VS_MEMORY_CASE]);
    expect(warnings).toEqual([]);
  });

  it("returns [] on an empty input", () => {
    expect(hardRuleGuardWarnings([])).toEqual([]);
  });
});

describe("per-direction scope invariant (test 7)", () => {
  it("the detector reads only the memory array it was given — no external I/O", async () => {
    // Structural: the port only uses its input fields; there are no fs/network
    // calls in either detectContradictionsDeterministic or detectContradictions
    // (the only async part is the injected semantic adapter, which is purely
    // functional here). An fs/network call would throw in a test environment
    // without a real project root.
    const memA = memEntry("a1", "loves warm tones");
    const memB = memEntry("b1", "cool corporate feel");
    const inputA = baseInput({
      liveInstruction: "make the background pure black",
      memory: [memA],
    });
    const inputB = baseInput({
      liveInstruction: "make the background pure black",
      memory: [memB],
    });

    // Both inputs produce the same floor result because the floor only inspects
    // hardRules/guidelines (not memory). Memory-vs-memory is the semantic adapter's job.
    const rA = detectContradictionsDeterministic(inputA);
    const rB = detectContradictionsDeterministic(inputB);
    expect(rA).toEqual(rB);

    // With a semantic adapter that returns its memory ids, we can assert scoping.
    const spiedMemA: string[] = [];
    const spiedMemB: string[] = [];
    await detectContradictions(
      { ...inputA },
      {
        semantic: async (i) => {
          spiedMemA.push(...i.memory.map((m) => m.id));
          return [];
        },
      },
    );
    await detectContradictions(
      { ...inputB },
      {
        semantic: async (i) => {
          spiedMemB.push(...i.memory.map((m) => m.id));
          return [];
        },
      },
    );
    expect(spiedMemA).toEqual(["a1"]);
    expect(spiedMemB).toEqual(["b1"]);
    expect(spiedMemA).not.toContain("b1");
    expect(spiedMemB).not.toContain("a1");
  });
});
