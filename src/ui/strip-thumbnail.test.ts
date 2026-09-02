import { describe, it, expect } from "vitest";
import { stripThumbnailPath } from "./strip-thumbnail.js";
import type { DashboardDirection } from "./types.js";

function makeDirection(versions: DashboardDirection["versions"]): DashboardDirection {
  return {
    id: "test",
    name: "Test",
    status: "active",
    brief: {
      aliases: [],
      neverCallIt: [],
      audiences: [],
      differentiateFrom: [],
      tone: [],
      values: [],
      inspirations: [],
      constraints: [],
      surfaces: [],
    },
    renderedBrief: "",
    version: 1,
    head: versions[versions.length - 1]?.versionId ?? "v1",
    isDraft: false,
    versions,
    extractedAssets: [],
    memory: [],
  };
}

function makeVersion(images?: { styleTile?: string; homepageMockup?: string }) {
  return {
    versionId: "v1",
    createdAt: "2024-01-01T00:00:00Z",
    name: "Test",
    summary: "",
    positioning: "",
    styleTilePrompt: "",
    homepageMockupPrompt: "",
    character: { mood: "", composition: "", layout: "", imagery: "", texture: "", rhythm: "" },
    usage: { rules: [], antiRules: [] },
    copyExamples: { headline: "", subheadline: "", cta: "" },
    ...(images !== undefined ? { images } : {}),
  };
}

describe("stripThumbnailPath", () => {
  it("returns styleTile when head has one", () => {
    const d = makeDirection([makeVersion({ styleTile: "/brand/style.png", homepageMockup: "/brand/mock.png" })]);
    expect(stripThumbnailPath(d)).toBe("/brand/style.png");
  });

  it("returns homepageMockup when no styleTile but mockup exists", () => {
    const d = makeDirection([makeVersion({ homepageMockup: "/brand/mock.png" })]);
    expect(stripThumbnailPath(d)).toBe("/brand/mock.png");
  });

  it("returns null when images present but neither path set", () => {
    const d = makeDirection([makeVersion({})]);
    expect(stripThumbnailPath(d)).toBeNull();
  });

  it("returns null when images undefined (fresh/dry-run direction)", () => {
    const d = makeDirection([makeVersion(undefined)]);
    expect(stripThumbnailPath(d)).toBeNull();
  });

  it("reads the single version as head for a one-version direction", () => {
    const d = makeDirection([makeVersion({ styleTile: "/solo.png" })]);
    expect(stripThumbnailPath(d)).toBe("/solo.png");
  });

  it("reads the LAST version as head for a multi-version direction", () => {
    const v1 = { ...makeVersion({ styleTile: "/first.png" }), versionId: "v1" };
    const v2 = { ...makeVersion({ styleTile: "/last.png" }), versionId: "v2" };
    const d = makeDirection([v1, v2]);
    expect(stripThumbnailPath(d)).toBe("/last.png");
  });
});
