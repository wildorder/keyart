import { describe, it, expect } from "vitest";
import {
  parseAssetVersion,
  parseExtractedAssetIndex,
  isExtractedAssetRetired,
  type AssetVersion,
} from "./schema.js";

/** The `makeVersion` idiom — a valid AssetVersion with a full AssetSource. */
function makeAssetVersion(
  id: string,
  overrides: Partial<AssetVersion> = {},
): AssetVersion {
  return {
    id,
    createdAt: "2026-07-26T00:00:00.000Z",
    description: "the yak mascot",
    source: {
      directionId: "direction-a",
      versionId: "v1",
      image: "styleTile",
    },
    files: [],
    ...overrides,
  };
}

describe("parseAssetVersion", () => {
  it("accepts a full version and round-trips", () => {
    const full = makeAssetVersion("v2", {
      producedBy: "make it bolder",
      description: "the yak mascot, cropped tighter",
      source: {
        directionId: "direction-a",
        versionId: "v2",
        image: "homepageMockup",
        cropBox: { x: 10, y: 20, w: 100, h: 80 },
        cropPath: "uploads/crop-1.png",
      },
      files: ["asset-version.json", "asset.png"],
      dryRun: true,
    });
    expect(parseAssetVersion(full)).toEqual(full);
  });

  it("accepts a minimal v1 (no producedBy/cropBox/cropPath/dryRun, files: [])", () => {
    const minimal = makeAssetVersion("v1");
    expect(parseAssetVersion(minimal)).toEqual(minimal);
  });

  it("rejects a version missing source.versionId", () => {
    const bad = makeAssetVersion("v1");
    // @ts-expect-error deliberately malformed for the rejection test
    delete bad.source.versionId;
    expect(() => parseAssetVersion(bad)).toThrow();
  });

  it("rejects a source.image outside the enum", () => {
    const bad = makeAssetVersion("v1", {
      // @ts-expect-error deliberately malformed for the rejection test
      source: { directionId: "direction-a", versionId: "v1", image: "logo" },
    });
    expect(() => parseAssetVersion(bad)).toThrow();
  });

  it("rejects a non-array files", () => {
    const bad = makeAssetVersion("v1");
    // @ts-expect-error deliberately malformed for the rejection test
    bad.files = "not-an-array";
    expect(() => parseAssetVersion(bad)).toThrow();
  });
});

describe("parseExtractedAssetIndex", () => {
  it("accepts a live index (no retiredAt)", () => {
    const live = {
      id: "yak-mascot",
      name: "Yak Mascot",
      directionId: "direction-a",
      versions: ["v1", "v2"],
      head: "v2",
    };
    expect(parseExtractedAssetIndex(live)).toEqual(live);
  });

  it("accepts a retired index (with retiredAt)", () => {
    const retired = {
      id: "yak-mascot",
      name: "Yak Mascot",
      directionId: "direction-a",
      versions: ["v1"],
      head: "v1",
      retiredAt: "2026-07-26T13:00:00.000Z",
    };
    expect(parseExtractedAssetIndex(retired)).toEqual(retired);
  });

  it("rejects an index missing head", () => {
    const bad = {
      id: "yak-mascot",
      name: "Yak Mascot",
      directionId: "direction-a",
      versions: ["v1"],
    };
    expect(() => parseExtractedAssetIndex(bad)).toThrow();
  });

  it("rejects an index missing directionId", () => {
    const bad = {
      id: "yak-mascot",
      name: "Yak Mascot",
      versions: ["v1"],
      head: "v1",
    };
    expect(() => parseExtractedAssetIndex(bad)).toThrow();
  });

  it("rejects an index whose versions is not an array of strings", () => {
    const bad = {
      id: "yak-mascot",
      name: "Yak Mascot",
      directionId: "direction-a",
      versions: [1, 2],
      head: "v1",
    };
    expect(() => parseExtractedAssetIndex(bad)).toThrow();
  });
});

describe("parseExtractedAssetIndex — slotId (surface-manifest WS-03)", () => {
  it("round-trips a record WITH slotId verbatim", () => {
    const withSlot = {
      id: "restaurant",
      name: "Restaurant",
      directionId: "direction-a",
      versions: ["v1"],
      head: "v1",
      slotId: "icon.restaurant",
    };
    expect(parseExtractedAssetIndex(withSlot)).toEqual(withSlot);
  });

  it("parses a record WITHOUT slotId back-compat (no slotId key on the result)", () => {
    const withoutSlot = {
      id: "restaurant",
      name: "Restaurant",
      directionId: "direction-a",
      versions: ["v1"],
      head: "v1",
    };
    const parsed = parseExtractedAssetIndex(withoutSlot);
    expect(parsed).toEqual(withoutSlot);
    expect("slotId" in parsed).toBe(false);
  });
});

describe("isExtractedAssetRetired truth table", () => {
  it("{} -> false", () => {
    expect(isExtractedAssetRetired({})).toBe(false);
  });

  it('{ retiredAt: "" } -> false', () => {
    expect(isExtractedAssetRetired({ retiredAt: "" })).toBe(false);
  });

  it("{ retiredAt: <iso> } -> true", () => {
    expect(
      isExtractedAssetRetired({ retiredAt: "2026-07-26T00:00:00.000Z" }),
    ).toBe(true);
  });
});
