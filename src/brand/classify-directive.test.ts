import { describe, it, expect } from "vitest";
import {
  classifyDirective,
  fromRule,
  fromMemoryEntry,
  isRetired,
  AVOID_LEADING_WORDS,
  type ClassifiableDirective,
} from "./classify-directive.js";
import type { GlobalRule } from "./schema.js";
import type { MemoryEntry } from "../direction/schema.js";

function makeRule(overrides: Partial<GlobalRule> = {}): GlobalRule {
  return {
    id: "rule-abc",
    severity: "guideline",
    text: "Prefer generous whitespace",
    author: "tim",
    source: "cli",
    date: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "decision-abc",
    kind: "decision",
    body: "Use editorial typefaces",
    author: "tim",
    source: "cli",
    date: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("classifyDirective — structural wins", () => {
  it("structural channel overrides rule default (copy wins over visual)", () => {
    const result = classifyDirective(fromRule(makeRule({ channel: "copy" })));
    expect(result.channel).toBe("copy");
  });

  it("structural polarity wins over heuristic — prefer beats leading 'never'", () => {
    const directive: ClassifiableDirective = {
      origin: "rule",
      severity: "hard",
      text: "never use gradients",
      polarity: "prefer",
    };
    expect(classifyDirective(directive).polarity).toBe("prefer");
  });

  it("structural channel + heuristic polarity resolve independently", () => {
    const directive: ClassifiableDirective = {
      origin: "rule",
      severity: "guideline",
      text: "avoid gradients",
      channel: "visual",
      // no polarity → heuristic
    };
    const result = classifyDirective(directive);
    expect(result.channel).toBe("visual");
    expect(result.polarity).toBe("avoid");
  });
});

describe("classifyDirective — heuristic polarity (avoid words)", () => {
  const avoidCases = [
    ["never", "never use a fist-in-the-air icon"],
    ["no", "no gradients allowed"],
    ["avoid", "avoid pure black"],
    ["don't", "don't center body copy"],
    ["dont", "dont center body copy"],
    ["not", "not a good choice for body text"],
  ] as const;

  for (const [word, text] of avoidCases) {
    it(`leading "${word}" resolves polarity: avoid`, () => {
      const directive: ClassifiableDirective = { origin: "rule", severity: "guideline", text };
      expect(classifyDirective(directive).polarity).toBe("avoid");
    });
  }

  it("case-insensitive: NEVER resolves to avoid", () => {
    const directive: ClassifiableDirective = {
      origin: "rule",
      severity: "guideline",
      text: "NEVER use pure black",
    };
    expect(classifyDirective(directive).polarity).toBe("avoid");
  });
});

describe("classifyDirective — heuristic polarity (prefer default)", () => {
  it("a directive with no avoid-leading word defaults to prefer", () => {
    const directive: ClassifiableDirective = {
      origin: "rule",
      severity: "guideline",
      text: "prefer generous whitespace",
    };
    expect(classifyDirective(directive).polarity).toBe("prefer");
  });

  it("mid-sentence 'no' does NOT flip to avoid — leading token only", () => {
    const directive: ClassifiableDirective = {
      origin: "rule",
      severity: "guideline",
      text: "leave no dead space",
    };
    // leading token is "leave", not "no"
    expect(classifyDirective(directive).polarity).toBe("prefer");
  });

  it("'use warm tones' resolves to prefer", () => {
    const directive: ClassifiableDirective = {
      origin: "rule",
      severity: "guideline",
      text: "use warm tones",
    };
    expect(classifyDirective(directive).polarity).toBe("prefer");
  });
});

describe("classifyDirective — default channel", () => {
  it("unlabeled hard rule defaults to visual", () => {
    const directive: ClassifiableDirective = {
      origin: "rule",
      severity: "hard",
      text: "Never use pure black",
    };
    expect(classifyDirective(directive).channel).toBe("visual");
  });

  it("unlabeled guideline rule defaults to visual", () => {
    const directive: ClassifiableDirective = {
      origin: "rule",
      severity: "guideline",
      text: "Prefer generous whitespace",
    };
    expect(classifyDirective(directive).channel).toBe("visual");
  });

  it("unlabeled decision memory entry defaults to visual", () => {
    const directive = fromMemoryEntry(makeEntry({ kind: "decision" }));
    expect(classifyDirective(directive).channel).toBe("visual");
  });

  it("unlabeled learning memory entry defaults to copy", () => {
    const directive = fromMemoryEntry(makeEntry({ kind: "learning", body: "Serifs win" }));
    expect(classifyDirective(directive).channel).toBe("copy");
  });

  it("unlabeled feedback memory entry defaults to copy", () => {
    const directive = fromMemoryEntry(makeEntry({ kind: "feedback", body: "Loved the serifs" }));
    expect(classifyDirective(directive).channel).toBe("copy");
  });
});

describe("isRetired", () => {
  it("returns false for an entry with no retiredAt", () => {
    expect(isRetired({ retiredAt: undefined })).toBe(false);
  });

  it("returns false for retiredAt: empty string", () => {
    expect(isRetired({ retiredAt: "" })).toBe(false);
  });

  it("returns true for a valid retiredAt ISO timestamp", () => {
    expect(isRetired({ retiredAt: "2026-07-13T00:00:00.000Z" })).toBe(true);
  });
});

describe("AVOID_LEADING_WORDS", () => {
  it("contains the documented set of avoid-leading words", () => {
    const words = [...AVOID_LEADING_WORDS];
    expect(words).toContain("never");
    expect(words).toContain("no");
    expect(words).toContain("avoid");
    expect(words).toContain("don't");
    expect(words).toContain("dont");
    expect(words).toContain("not");
  });
});
