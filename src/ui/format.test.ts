import { describe, expect, it } from "vitest";
import { lastUpdated, representativeImage } from "./format.js";
import type { DashboardDirection, DashboardVersion } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal fixture helpers — only the fields these helpers actually read.
// ---------------------------------------------------------------------------

function makeDirection(
  overrides: Partial<Pick<DashboardDirection, "versions" | "memory" | "assets" | "head" | "isDraft">>,
): DashboardDirection {
  return {
    id: "d1",
    name: "TestDirection",
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
    head: null,
    isDraft: true,
    versions: [],
    extractedAssets: [],
    memory: [],
    ...overrides,
  };
}

function makeVersion(
  versionId: string,
  headImages: { styleTile?: string; homepageMockup?: string } = {},
  createdAt = "2024-01-01T00:00:00Z",
): DashboardVersion {
  return {
    versionId,
    createdAt,
    name: "",
    summary: "",
    positioning: "",
    character: {},
    homepageMockupPrompt: "",
    styleTilePrompt: "",
    copyExamples: { headline: "", subheadline: "", cta: "" },
    usage: { rules: [], antiRules: [] },
    images: Object.keys(headImages).length > 0 ? headImages : undefined,
  };
}

// ---------------------------------------------------------------------------
// representativeImage
// ---------------------------------------------------------------------------

describe("representativeImage", () => {
  it("returns the head version's styleTile", () => {
    const direction = makeDirection({
      head: "v2",
      isDraft: false,
      versions: [
        makeVersion("v1", { styleTile: "old/tile.png" }),
        makeVersion("v2", { styleTile: "new/tile.png" }),
      ],
    });
    expect(representativeImage(direction)).toBe("new/tile.png");
  });

  it("falls back to the head homepageMockup when the head has no styleTile", () => {
    const direction = makeDirection({
      head: "v2",
      isDraft: false,
      versions: [
        makeVersion("v1", { homepageMockup: "v1/mock.png" }),
        makeVersion("v2", { homepageMockup: "v2/mock.png" }),
      ],
    });
    expect(representativeImage(direction)).toBe("v2/mock.png");
  });

  it("prefers the head styleTile over the head homepageMockup", () => {
    const direction = makeDirection({
      head: "v1",
      isDraft: false,
      versions: [
        makeVersion("v1", { styleTile: "head/tile.png", homepageMockup: "head/mock.png" }),
      ],
    });
    expect(representativeImage(direction)).toBe("head/tile.png");
  });

  it("falls back to a moodboard image asset when no version images exist", () => {
    const direction = makeDirection({
      assets: [{ kind: "image", path: "assets/cover.png" }],
    });
    expect(representativeImage(direction)).toBe("assets/cover.png");
  });

  it("does NOT return a feedback-kind asset", () => {
    const direction = makeDirection({
      assets: [{ kind: "feedback", path: "assets/discard.png" }],
    });
    expect(representativeImage(direction)).toBeNull();
  });

  it("returns null when there are no version images and no image asset", () => {
    const direction = makeDirection({
      head: "v1",
      isDraft: false,
      versions: [makeVersion("v1", {})],
    });
    expect(representativeImage(direction)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// lastUpdated
// ---------------------------------------------------------------------------

describe("lastUpdated", () => {
  it("returns the greatest createdAt across the direction's versions", () => {
    const direction = makeDirection({
      head: "v3",
      isDraft: false,
      versions: [
        makeVersion("v1", {}, "2024-01-10T00:00:00Z"),
        makeVersion("v2", {}, "2024-02-01T00:00:00Z"),
        makeVersion("v3", {}, "2024-03-05T00:00:00Z"),
      ],
    });
    expect(lastUpdated(direction)).toBe("2024-03-05T00:00:00Z");
  });

  it("returns a memory date when it is newer than all version createdAts", () => {
    const direction = makeDirection({
      head: "v1",
      isDraft: false,
      versions: [makeVersion("v1", {}, "2024-01-01T00:00:00Z")],
      memory: [
        {
          id: "m1",
          kind: "feedback",
          body: "note",
          author: "user",
          source: "test",
          date: "2025-06-15T12:00:00Z",
        },
      ],
    });
    expect(lastUpdated(direction)).toBe("2025-06-15T12:00:00Z");
  });

  it("skips malformed timestamps and still returns the valid max", () => {
    const direction = makeDirection({
      head: "v2",
      isDraft: false,
      versions: [
        makeVersion("v1", {}, "not-a-date"),
        makeVersion("v2", {}, "2024-05-20T08:00:00Z"),
      ],
    });
    expect(lastUpdated(direction)).toBe("2024-05-20T08:00:00Z");
  });

  it("returns null for a direction with no versions and no memory", () => {
    const direction = makeDirection({});
    expect(lastUpdated(direction)).toBeNull();
  });
});
