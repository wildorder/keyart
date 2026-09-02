import { describe, it, expect } from "vitest";
import type { DashboardMemoryEntry } from "../types.js";
import { selectMemoryEntries } from "./memory-select.js";

function makeEntry(id: string, date: string): DashboardMemoryEntry {
  return {
    id,
    kind: "feedback",
    body: `entry ${id}`,
    author: "test",
    source: "test",
    date,
  };
}

const ENTRIES: DashboardMemoryEntry[] = [
  makeEntry("a", "2024-01-01T00:00:00Z"),
  makeEntry("b", "2024-06-01T00:00:00Z"),
  makeEntry("c", "2024-12-01T00:00:00Z"),
];

describe("selectMemoryEntries", () => {
  it("full variant returns all entries in original order", () => {
    const result = selectMemoryEntries(ENTRIES, "full");
    expect(result.map((e: DashboardMemoryEntry) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("rail variant returns entries in reverse (most-recent-first) order", () => {
    const result = selectMemoryEntries(ENTRIES, "rail");
    expect(result.map((e: DashboardMemoryEntry) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("rail variant with limit returns at most N most-recent entries", () => {
    const result = selectMemoryEntries(ENTRIES, "rail", 2);
    expect(result.map((e: DashboardMemoryEntry) => e.id)).toEqual(["c", "b"]);
  });

  it("full variant with limit returns first N entries in original order", () => {
    const result = selectMemoryEntries(ENTRIES, "full", 2);
    expect(result.map((e: DashboardMemoryEntry) => e.id)).toEqual(["a", "b"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...ENTRIES];
    selectMemoryEntries(ENTRIES, "rail");
    expect(ENTRIES).toEqual(copy);
  });

  it("returns all entries when limit exceeds array length", () => {
    const result = selectMemoryEntries(ENTRIES, "rail", 10);
    expect(result).toHaveLength(3);
  });

  it("returns empty array for empty input", () => {
    expect(selectMemoryEntries([], "rail", 5)).toEqual([]);
    expect(selectMemoryEntries([], "full")).toEqual([]);
  });
});
