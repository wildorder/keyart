import { describe, it, expect } from "vitest";
import { planReconciliation, isRetired } from "./reconcile.js";
import type { Contradiction } from "../brand/conflict-guard.js";
import { CommandError } from "../errors.js";

function makeContradiction(
  subjectSource: "memory" | "hard-rule" | "guideline" | "live",
  conflictsWithSource: "memory" | "hard-rule" | "guideline" | "live",
  overrides: Partial<Contradiction> = {},
): Contradiction {
  return {
    id: "c-test-001",
    kind: "live-vs-memory",
    subject: { source: subjectSource, id: "entry-subject-1", text: "Use bold typography" },
    conflictsWith: { source: conflictsWithSource, id: "entry-loser-1", text: "Avoid bold typography" },
    severity: "warning",
    explanation: "Contradiction between subject and existing memory",
    suggestions: ["keep", "retire", "supersede", "promote"],
    ...overrides,
  };
}

describe("isRetired", () => {
  it("returns false for a live entry", () => {
    expect(isRetired({ body: "text" } as never)).toBe(false);
  });
  it("returns true when retiredAt is set", () => {
    expect(isRetired({ retiredAt: "2025-01-01T00:00:00.000Z" })).toBe(true);
  });
  it("returns true when supersededBy is set", () => {
    expect(isRetired({ supersededBy: "entry-winner-1" })).toBe(true);
  });
  it("returns true when both markers are set", () => {
    expect(isRetired({ retiredAt: "2025-01-01T00:00:00.000Z", supersededBy: "entry-winner-1" })).toBe(true);
  });
});

describe("planReconciliation — keep", () => {
  it("returns no retireEntryId, no promote, audit.kind=learning", () => {
    const contradiction = makeContradiction("memory", "memory");
    const plan = planReconciliation({ contradiction, action: "keep" });
    expect(plan.action).toBe("keep");
    expect(plan.retireEntryId).toBeUndefined();
    expect(plan.promote).toBeUndefined();
    expect(plan.audit.kind).toBe("learning");
    expect(plan.audit.body).toContain("keep");
    expect(plan.audit.body).toContain("Use bold typography");
    expect(plan.audit.body).toContain("Avoid bold typography");
  });
});

describe("planReconciliation — retire", () => {
  it("retires the loser (conflictsWith by default is the loser for winner=subject)", () => {
    const contradiction = makeContradiction("memory", "memory");
    const plan = planReconciliation({ contradiction, action: "retire", winner: "subject" });
    expect(plan.action).toBe("retire");
    expect(plan.retireEntryId).toBe("entry-loser-1");
    expect(plan.promote).toBeUndefined();
    expect(plan.audit.kind).toBe("learning");
    expect(plan.audit.body).toContain("entry-loser-1");
    expect(plan.audit.body).toContain("Avoid bold typography");
  });

  it("retires the subject when winner=conflictsWith", () => {
    const contradiction = makeContradiction("memory", "memory");
    const plan = planReconciliation({ contradiction, action: "retire", winner: "conflictsWith" });
    expect(plan.retireEntryId).toBe("entry-subject-1");
  });

  it("throws CommandError when loser is a hard-rule", () => {
    const contradiction = makeContradiction("memory", "hard-rule");
    expect(() => planReconciliation({ contradiction, action: "retire", winner: "subject" })).toThrow(CommandError);
  });

  it("throws CommandError when loser is a guideline", () => {
    const contradiction = makeContradiction("memory", "guideline");
    expect(() => planReconciliation({ contradiction, action: "retire", winner: "subject" })).toThrow(CommandError);
  });

  it("throws CommandError when loser is a live ref", () => {
    const contradiction = makeContradiction("memory", "live");
    expect(() => planReconciliation({ contradiction, action: "retire", winner: "subject" })).toThrow(CommandError);
  });
});

describe("planReconciliation — supersede", () => {
  it("sets both retireEntryId and supersededByEntryId from memory refs", () => {
    const contradiction = makeContradiction("memory", "memory");
    const plan = planReconciliation({ contradiction, action: "supersede", winner: "subject" });
    expect(plan.action).toBe("supersede");
    expect(plan.retireEntryId).toBe("entry-loser-1");
    expect(plan.supersededByEntryId).toBe("entry-subject-1");
    expect(plan.audit.kind).toBe("learning");
    expect(plan.audit.body).toContain("entry-loser-1");
    expect(plan.audit.body).toContain("entry-subject-1");
  });

  it("throws CommandError when loser is a hard-rule", () => {
    const contradiction = makeContradiction("memory", "hard-rule");
    expect(() => planReconciliation({ contradiction, action: "supersede", winner: "subject" })).toThrow(CommandError);
  });

  it("throws CommandError when winner is not a memory ref (e.g. guideline)", () => {
    const contradiction = makeContradiction("guideline", "memory");
    expect(() => planReconciliation({ contradiction, action: "supersede", winner: "subject" })).toThrow(CommandError);
  });
});

describe("planReconciliation — promote", () => {
  it("sets promote.text from winner, default severity guideline", () => {
    const contradiction = makeContradiction("memory", "memory");
    const plan = planReconciliation({ contradiction, action: "promote", winner: "subject" });
    expect(plan.action).toBe("promote");
    expect(plan.promote).toBeDefined();
    expect(plan.promote!.text).toBe("Use bold typography");
    expect(plan.promote!.severity).toBe("guideline");
    expect(plan.retireEntryId).toBeUndefined();
    expect(plan.audit.kind).toBe("learning");
  });

  it("respects explicit severity", () => {
    const contradiction = makeContradiction("memory", "memory");
    const plan = planReconciliation({ contradiction, action: "promote", winner: "subject", severity: "hard" });
    expect(plan.promote!.severity).toBe("hard");
  });

  it("throws CommandError when winner is not a memory ref", () => {
    const contradiction = makeContradiction("guideline", "memory");
    expect(() => planReconciliation({ contradiction, action: "promote", winner: "subject" })).toThrow(CommandError);
  });

  it("audit body describes a promotion REQUEST (not a completed promotion)", () => {
    const contradiction = makeContradiction("memory", "memory");
    const plan = planReconciliation({ contradiction, action: "promote" });
    expect(plan.audit.body).toMatch(/promot/i);
    expect(plan.audit.body).toContain("entry-subject-1");
  });
});

describe("planReconciliation — hard-rule guard", () => {
  it("retire a contradiction where loser=hard-rule throws CommandError", () => {
    const contradiction = makeContradiction("live", "hard-rule");
    expect(() =>
      planReconciliation({ contradiction, action: "retire", winner: "subject" }),
    ).toThrow(CommandError);
  });

  it("guideline loser also throws for retire", () => {
    const contradiction = makeContradiction("live", "guideline");
    expect(() =>
      planReconciliation({ contradiction, action: "retire", winner: "subject" }),
    ).toThrow(CommandError);
  });
});

describe("planReconciliation — pure / no I/O", () => {
  it("produces deterministic output for identical input", () => {
    const contradiction = makeContradiction("memory", "memory");
    const input = { contradiction, action: "keep" as const };
    const plan1 = planReconciliation(input);
    const plan2 = planReconciliation(input);
    expect(plan1).toEqual(plan2);
  });

  it("audit body does not embed a runtime timestamp", () => {
    const contradiction = makeContradiction("memory", "memory");
    const plan = planReconciliation({ contradiction, action: "retire", winner: "subject" });
    // The audit body is static text; no ISO timestamp should appear
    expect(plan.audit.body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });
});
