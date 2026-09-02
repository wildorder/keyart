import { describe, it, expect } from "vitest";
import {
  assetShelfItems,
  assetAffordances,
  assetImageStatus,
  assetImageStatusLabel,
  sourceImageNameFor,
} from "./asset-shelf-helpers.js";
import type {
  DashboardDirection,
  DashboardExtractedAsset,
  DirectionImages,
} from "./types.js";

const asset = (o: Partial<DashboardExtractedAsset>): DashboardExtractedAsset => ({
  id: "a1",
  name: "Yak mascot",
  description: "A friendly yak",
  headVersionId: "v1",
  versionCount: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...o,
});

const direction = (o: Partial<DashboardDirection>): DashboardDirection => ({
  id: "d1",
  name: "Direction One",
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
  head: "v1",
  isDraft: false,
  versions: [],
  extractedAssets: [],
  memory: [],
  ...o,
});

describe("assetShelfItems", () => {
  it("orders newest first by createdAt", () => {
    const a1 = asset({ id: "1", createdAt: "2026-01-01T00:00:00.000Z" });
    const a2 = asset({ id: "2", createdAt: "2026-01-02T00:00:00.000Z" });
    const a3 = asset({ id: "3", createdAt: "2026-01-03T00:00:00.000Z" });
    const d = direction({ extractedAssets: [a1, a2, a3] });
    expect(assetShelfItems(d).map((a) => a.id)).toEqual(["3", "2", "1"]);
  });

  it("equal createdAt keeps payload order (stable)", () => {
    const a1 = asset({ id: "1", createdAt: "2026-01-01T00:00:00.000Z" });
    const a2 = asset({ id: "2", createdAt: "2026-01-01T00:00:00.000Z" });
    const d = direction({ extractedAssets: [a1, a2] });
    expect(assetShelfItems(d).map((a) => a.id)).toEqual(["1", "2"]);
  });

  it("an empty extractedAssets yields []", () => {
    expect(assetShelfItems(direction({ extractedAssets: [] }))).toEqual([]);
  });

  it("a direction without the field (legacy payload) yields [], never throws", () => {
    const legacy = { id: "d1", head: "v1", versions: [] } as unknown as DashboardDirection;
    expect(assetShelfItems(legacy)).toEqual([]);
  });

  it("pass-through — exactly the payload's items, none added or dropped", () => {
    const a1 = asset({ id: "1" });
    const a2 = asset({ id: "2" });
    const d = direction({ extractedAssets: [a1, a2] });
    expect(assetShelfItems(d).map((a) => a.id).sort()).toEqual(["1", "2"]);
  });

  it("does not mutate the input direction or its extractedAssets array", () => {
    const a1 = asset({ id: "1", createdAt: "2026-01-01T00:00:00.000Z" });
    const a2 = asset({ id: "2", createdAt: "2026-01-02T00:00:00.000Z" });
    const list = [a1, a2];
    const d = direction({ extractedAssets: list });
    const before = JSON.stringify(d);
    assetShelfItems(d);
    expect(JSON.stringify(d)).toEqual(before);
    expect(d.extractedAssets).toBe(list);
    expect(list.map((a) => a.id)).toEqual(["1", "2"]);
  });

  it("purity: identical input yields identical output", () => {
    const d = direction({ extractedAssets: [asset({ id: "1" }), asset({ id: "2" })] });
    expect(assetShelfItems(d)).toEqual(assetShelfItems(d));
  });
});

describe("assetAffordances", () => {
  it("an imaged asset can download and tweak, and is not pending", () => {
    const a = asset({ imagePath: "brand/directions/x/extracted-assets/a1/versions/v1/asset.png" });
    expect(assetAffordances(a)).toEqual({ canDownload: true, canTweak: true, pending: false });
  });

  it("a pending / dry-run asset (no imagePath) cannot download but can still tweak", () => {
    const a = asset({});
    expect(assetAffordances(a)).toEqual({ canDownload: false, canTweak: true, pending: true });
  });
});

describe("assetImageStatus", () => {
  it("imaged + no skips ⇒ ok, no detail", () => {
    const a = asset({ imagePath: "x/asset.png" });
    expect(assetImageStatus(a)).toEqual({ kind: "ok" });
  });

  it("imaged + skips ⇒ ok-degraded with the reasons joined", () => {
    const a = asset({
      imagePath: "x/asset.png",
      imageSkips: ["transparent background is not supported by gpt-image-2 — retried and generated with an opaque background"],
    });
    const s = assetImageStatus(a);
    expect(s.kind).toBe("ok-degraded");
    expect(s.detail).toMatch(/transparent background/i);
  });

  it("no image + dryRun ⇒ dry-run (a keyless run, NOT a failure)", () => {
    const a = asset({ dryRun: true });
    expect(assetImageStatus(a).kind).toBe("dry-run");
  });

  it("no image + skips + no dryRun ⇒ failed with the persisted reason (the keyed-but-failed case)", () => {
    const a = asset({
      imageSkips: ["400 Transparent background is not supported for this model."],
    });
    expect(assetImageStatus(a)).toEqual({
      kind: "failed",
      detail: "400 Transparent background is not supported for this model.",
    });
  });

  it("multiple skips join with '; '", () => {
    const a = asset({ imageSkips: ["first", "second"] });
    expect(assetImageStatus(a).detail).toBe("first; second");
  });

  it("no image, no dryRun, no skips ⇒ pending (a pre-fix legacy record)", () => {
    expect(assetImageStatus(asset({}))).toEqual({ kind: "pending" });
  });

  it("labels: failed carries the reason; dry-run names the missing key; ok is empty", () => {
    expect(assetImageStatusLabel({ kind: "failed", detail: "rate limited" })).toBe(
      "image generation failed: rate limited",
    );
    expect(assetImageStatusLabel({ kind: "dry-run" })).toMatch(/OPENAI_API_KEY/);
    expect(assetImageStatusLabel({ kind: "ok" })).toBe("");
    expect(assetImageStatusLabel({ kind: "pending" })).toBe("pending — no image");
    expect(
      assetImageStatusLabel({ kind: "ok-degraded", detail: "opaque fallback" }),
    ).toBe("generated with a limitation: opaque fallback");
  });
});

describe("sourceImageNameFor", () => {
  const images: DirectionImages = {
    styleTile: "a.png",
    homepageMockup: "b.png",
    styleBoard: "c.png",
    styleBoardSvg: "d.svg",
  };

  it("maps styleTile", () => {
    expect(sourceImageNameFor(images, "a.png")).toBe("styleTile");
  });

  it("maps homepageMockup", () => {
    expect(sourceImageNameFor(images, "b.png")).toBe("homepageMockup");
  });

  it("maps styleBoard to moodboard (the evocative board)", () => {
    expect(sourceImageNameFor(images, "c.png")).toBe("moodboard");
  });

  it("styleBoardSvg (the deterministic board) is never an extract source", () => {
    expect(sourceImageNameFor(images, "d.svg")).toBeNull();
  });

  it("an unknown path yields null", () => {
    expect(sourceImageNameFor(images, "unknown.png")).toBeNull();
  });

  it("absent images yields null", () => {
    expect(sourceImageNameFor(undefined, "a.png")).toBeNull();
  });
});
