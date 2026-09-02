import { describe, it, expect } from "vitest";
import { selectDecisions, DECISIONS_LIMIT } from "./memory-select.js";
import type { DashboardMemoryEntry } from "../types.js";

const entry = (o: Partial<DashboardMemoryEntry>): DashboardMemoryEntry => ({
  id: "x", kind: "decision", body: "b", author: "a", source: "s",
  date: "2026-01-01T00:00:00Z", ...o,
});

describe("selectDecisions", () => {
  it("empty memory → []", () => {
    expect(selectDecisions([])).toEqual([]);
  });

  it("mixed kinds → only decisions", () => {
    const mem = [
      entry({ id: "1", kind: "feedback" }),
      entry({ id: "2", kind: "decision", body: "Color locked: #ff2d8d" }),
      entry({ id: "3", kind: "learning" }),
    ];
    const out = selectDecisions(mem);
    expect(out.map((e: DashboardMemoryEntry) => e.id)).toEqual(["2"]);
  });

  it("excludes retired decisions", () => {
    const mem = [
      entry({ id: "1", kind: "decision", body: "live" }),
      entry({ id: "2", kind: "decision", body: "gone", retiredAt: "2026-02-01T00:00:00Z" }),
    ];
    expect(selectDecisions(mem).map((e: DashboardMemoryEntry) => e.id)).toEqual(["1"]);
  });

  it("most-recent-first (reverses append order)", () => {
    const mem = [
      entry({ id: "old", kind: "decision" }),
      entry({ id: "new", kind: "decision" }),
    ];
    expect(selectDecisions(mem).map((e: DashboardMemoryEntry) => e.id)).toEqual(["new", "old"]);
  });

  it("respects the limit / default cap", () => {
    const mem = Array.from({ length: DECISIONS_LIMIT + 3 }, (_, i) =>
      entry({ id: String(i), kind: "decision" }),
    );
    expect(selectDecisions(mem)).toHaveLength(DECISIONS_LIMIT);
    expect(selectDecisions(mem, 2)).toHaveLength(2);
  });

  it("does not mutate the input array", () => {
    const mem = [entry({ id: "1", kind: "decision" }), entry({ id: "2", kind: "decision" })];
    const before = mem.map((e: DashboardMemoryEntry) => e.id);
    selectDecisions(mem);
    expect(mem.map((e: DashboardMemoryEntry) => e.id)).toEqual(before);
  });
});
