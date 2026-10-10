import { describe, it, expect } from "vitest";
import {
  galleryImagesOf,
  heroImageOf,
  secondaryImagesOf,
  stageImagesOf,
} from "./direction-hero-images.js";
import type { DashboardVersion, DirectionImages } from "./types.js";

function makeVersion(images?: DirectionImages): DashboardVersion {
  return {
    versionId: "v1",
    name: "Test Direction",
    summary: "A test direction",
    positioning: "",
    character: {},
    homepageMockupPrompt: "",
    styleTilePrompt: "",
    copyExamples: { headline: "H", subheadline: "S", cta: "C" },
    usage: { rules: [], antiRules: [] },
    createdAt: "2024-01-01T00:00:00.000Z",
    images,
  };
}

describe("heroImageOf", () => {
  it("prefers homepageMockup when both it and styleTile exist", () => {
    const v = makeVersion({ styleTile: "/tile.png", homepageMockup: "/mockup.png" });
    expect(heroImageOf(v)).toBe("/mockup.png");
  });

  it("falls back to styleTile when homepageMockup is absent", () => {
    const v = makeVersion({ styleTile: "/tile.png" });
    expect(heroImageOf(v)).toBe("/tile.png");
  });

  it("returns null when the version has no images object", () => {
    const v = makeVersion(undefined);
    expect(heroImageOf(v)).toBeNull();
  });

  it("returns null when images object has no styleTile or homepageMockup", () => {
    const v = makeVersion({ styleBoard: "/board.png" });
    expect(heroImageOf(v)).toBeNull();
  });
});

describe("secondaryImagesOf", () => {
  it("with all three present returns [styleTile, styleBoard] in fixed order (hero = homepage mockup excluded)", () => {
    const v = makeVersion({
      styleTile: "/tile.png",
      homepageMockup: "/mockup.png",
      styleBoard: "/board.png",
    });
    const result = secondaryImagesOf(v);
    expect(result.map((r) => r.path)).toEqual(["/tile.png", "/board.png"]);
  });

  it("with only a styleTile returns [] (styleTile is the hero)", () => {
    const v = makeVersion({ styleTile: "/tile.png" });
    expect(secondaryImagesOf(v)).toEqual([]);
  });

  it("never includes styleBoardSvg (deterministic board is not a thumbnail target)", () => {
    const v = makeVersion({
      styleTile: "/tile.png",
      homepageMockup: "/mockup.png",
      styleBoardSvg: "/board.svg",
    });
    const result = secondaryImagesOf(v);
    expect(result.some((r) => r.path === "/board.svg")).toBe(false);
    expect(result.some((r) => r.path.endsWith(".svg"))).toBe(false);
  });
});

describe("stageImagesOf", () => {
  it("includes the hero — on the stage every image is a peer", () => {
    const v = makeVersion({ styleTile: "/tile.png", homepageMockup: "/mockup.png" });
    expect(stageImagesOf(v).map((s) => s.path)).toEqual(["/tile.png", "/mockup.png"]);
  });

  it("orders styleTile → homepageMockup → styleBoard", () => {
    const v = makeVersion({
      styleTile: "/tile.png",
      homepageMockup: "/mockup.png",
      styleBoard: "/board.png",
    });
    expect(stageImagesOf(v).map((s) => s.path)).toEqual([
      "/tile.png",
      "/mockup.png",
      "/board.png",
    ]);
  });

  it("stays index-aligned with galleryImagesOf so the thumb row and lightbox agree", () => {
    const v = makeVersion({
      styleTile: "/tile.png",
      homepageMockup: "/mockup.png",
      styleBoard: "/board.png",
    });
    expect(stageImagesOf(v).map((s) => s.path)).toEqual(
      galleryImagesOf(v, 0).map((g) => g.path),
    );
  });

  it("drops absent images rather than emitting holes", () => {
    const v = makeVersion({ homepageMockup: "/mockup.png" });
    expect(stageImagesOf(v).map((s) => s.path)).toEqual(["/mockup.png"]);
  });

  it("returns [] when the version has no images at all", () => {
    expect(stageImagesOf(makeVersion(undefined))).toEqual([]);
  });

  it("never includes styleBoardSvg (the deterministic projection is not a target)", () => {
    const v = makeVersion({ styleTile: "/tile.png", styleBoardSvg: "/board.svg" });
    expect(stageImagesOf(v).map((s) => s.path)).toEqual(["/tile.png"]);
  });

  it("gives every staged image a non-empty label", () => {
    const v = makeVersion({
      styleTile: "/tile.png",
      homepageMockup: "/mockup.png",
      styleBoard: "/board.png",
    });
    for (const img of stageImagesOf(v)) expect(img.label.length).toBeGreaterThan(0);
  });
});
