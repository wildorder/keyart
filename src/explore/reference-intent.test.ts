import { describe, it, expect } from "vitest";
import {
  splitByIntent,
  analysisToLocks,
  type RunReference,
} from "./reference-intent.js";
import type { ReferenceTokenAnalysis } from "../openai.js";

describe("splitByIntent", () => {
  it("splits mixed references, preserving order within each bucket", () => {
    const refs: RunReference[] = [
      { path: "/a.png", intent: "inspire" },
      { path: "/b.png", intent: "extract" },
      { path: "/c.png", intent: "inspire" },
      { path: "/d.png", intent: "extract" },
    ];
    const { inspire, extract } = splitByIntent(refs);
    expect(inspire.map((r) => r.path)).toEqual(["/a.png", "/c.png"]);
    expect(extract.map((r) => r.path)).toEqual(["/b.png", "/d.png"]);
  });

  it("treats any non-extract intent as inspire", () => {
    const refs = [
      { path: "/x.png", intent: "inspire" as const },
      // Defensive: a stray value that is not "extract" routes to inspire.
      { path: "/y.png", intent: "weird" as unknown as RunReference["intent"] },
    ];
    const { inspire, extract } = splitByIntent(refs);
    expect(inspire.map((r) => r.path)).toEqual(["/x.png", "/y.png"]);
    expect(extract).toEqual([]);
  });

  it("returns empty buckets for no references", () => {
    expect(splitByIntent([])).toEqual({ inspire: [], extract: [] });
  });
});

describe("analysisToLocks", () => {
  it("maps valid hexes to unroled locks, deduped case-insensitively", () => {
    const analysis: ReferenceTokenAnalysis = {
      dominantColors: ["#112233", "#AABBCC", "#112233", "#aabbcc", "#f00"],
    };
    const locks = analysisToLocks(analysis);
    expect(locks).toEqual([
      { hex: "#112233" },
      { hex: "#aabbcc" },
      { hex: "#f00" },
    ]);
  });

  it("drops invalid values and returns [] for an empty read", () => {
    expect(
      analysisToLocks({ dominantColors: ["red", "#12", "112233", "#gggggg", ""] }),
    ).toEqual([]);
    expect(analysisToLocks({ dominantColors: [] })).toEqual([]);
  });

  it("caps the number of locks so an extract read cannot flood the palette", () => {
    const analysis: ReferenceTokenAnalysis = {
      dominantColors: ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"],
    };
    expect(analysisToLocks(analysis).length).toBeLessThanOrEqual(4);
  });
});
