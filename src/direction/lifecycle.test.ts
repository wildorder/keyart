import { describe, it, expect } from "vitest";
import { planEdit, planPromote, planDelete } from "./lifecycle.js";
import { CommandError } from "../errors.js";
import type { MemoryEntry } from "./schema.js";

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "decision-1",
    kind: "decision",
    body: "old body",
    author: "tim",
    source: "cli",
    date: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("planEdit", () => {
  it("carries kind/channel/polarity, overriding only what the patch sets", () => {
    const entry = makeEntry({ channel: "visual", polarity: "avoid" });

    const plan = planEdit(entry, { body: "new body" });

    expect(plan.supersedeEntryId).toBe(entry.id);
    expect(plan.newEntry.kind).toBe("decision");
    expect(plan.newEntry.channel).toBe("visual");
    expect(plan.newEntry.polarity).toBe("avoid");
    expect(plan.newEntry.body).toBe("new body");
    expect(plan.audit.kind).toBe("learning");
    expect(plan.audit.body).toContain(entry.id);
  });

  it("overrides only the patched field (channel) while inheriting the rest", () => {
    const entry = makeEntry({ channel: "visual", polarity: "avoid" });

    const plan = planEdit(entry, { body: "new body", channel: "copy" });

    expect(plan.newEntry.channel).toBe("copy");
    expect(plan.newEntry.polarity).toBe("avoid");
    expect(plan.newEntry.body).toBe("new body");
  });

  it("rejects an already-retired entry", () => {
    const retired = makeEntry({ retiredAt: "2026-01-02T00:00:00.000Z" });
    expect(() => planEdit(retired, { body: "x" })).toThrow(CommandError);
  });
});

describe("planPromote — up-only, single destination (global)", () => {
  it("builds a globalRule carrying severity + channel/polarity, default severity guideline", () => {
    const entry = makeEntry({ channel: "visual", polarity: "prefer" });

    const plan = planPromote(entry, { target: "global", severity: "hard" });

    expect(plan.target).toBe("global");
    expect(plan.globalRule).toBeDefined();
    expect(plan.globalRule.text).toBe(entry.body);
    expect(plan.globalRule.severity).toBe("hard");
    expect(plan.globalRule.channel).toBe("visual");
    expect(plan.globalRule.polarity).toBe("prefer");
    expect(plan.retireSourceEntryId).toBe(entry.id);
    expect(plan.audit.kind).toBe("learning");

    const defaultSeverity = planPromote(entry, { target: "global" });
    expect(defaultSeverity.globalRule.severity).toBe("guideline");
  });

  it("rejects promoting an already-retired entry", () => {
    const retired = makeEntry({ retiredAt: "2026-01-02T00:00:00.000Z" });
    expect(() => planPromote(retired, { target: "global" })).toThrow(CommandError);
  });
});

describe("planDelete", () => {
  it("retires the entry via a learning audit", () => {
    const entry = makeEntry();
    const plan = planDelete(entry);
    expect(plan.retireEntryId).toBe(entry.id);
    expect(plan.audit.kind).toBe("learning");
    expect(plan.audit.body).toContain(entry.id);
  });

  it("rejects an already-retired entry", () => {
    const retired = makeEntry({ retiredAt: "2026-01-02T00:00:00.000Z" });
    expect(() => planDelete(retired)).toThrow(CommandError);
  });
});

describe("pure / no I/O", () => {
  it("is deterministic across repeated calls with identical input", () => {
    const entry = makeEntry({ channel: "visual", polarity: "avoid" });

    const editA = planEdit(entry, { body: "new body" });
    const editB = planEdit(entry, { body: "new body" });
    expect(editA).toEqual(editB);

    const promoteA = planPromote(entry, { target: "global" });
    const promoteB = planPromote(entry, { target: "global" });
    expect(promoteA).toEqual(promoteB);

    const deleteA = planDelete(entry);
    const deleteB = planDelete(entry);
    expect(deleteA).toEqual(deleteB);
  });
});
