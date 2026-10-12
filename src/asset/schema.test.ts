import { describe, it, expect } from "vitest";
import { parseAssetVersion, parseExtractedAssetIndex, isExtractedAssetRetired, type AssetVersion } from "./schema.js";
const version: AssetVersion = {
  formatVersion: 2, id: "a1", createdAt: "2026-10-10T00:00:00Z", description: "mascot",
  foundation: { directionId: "route", versionId: "v1" }, provenance: { kind: "generated" },
  conditioning: "foundation", status: "pending", contextSnapshot: "{}", files: [],
};
describe("asset format", () => {
  it("round-trips generated and extracted origins with per-version foundation", () => {
    expect(parseAssetVersion(version)).toEqual(version);
    const extracted = { ...version, provenance: { kind: "extracted", source: { kind: "board", directionId: "route", boardId: "instagram", revisionId: "r1" }, cropPath: "stored/crop.png", cropBox: { x: 0, y: 0, w: 5, h: 5 } } };
    expect(parseAssetVersion(extracted)).toEqual(extracted);
  });
  it("rejects untagged old records and incomplete origins", () => {
    const { formatVersion: _, ...untagged } = version;
    expect(() => parseAssetVersion(untagged)).toThrow();
    expect(() => parseAssetVersion({ ...version, conditioning: undefined })).toThrow();
    expect(parseAssetVersion({ ...version, conditioning: "legacy-unverified" }).conditioning).toBe("legacy-unverified");
    expect(() => parseAssetVersion({ ...version, provenance: { kind: "extracted" } })).toThrow();
    expect(() => parseAssetVersion({ ...version, foundation: { directionId: "route" } })).toThrow();
    expect(() => parseAssetVersion({ ...version, status: "success" })).toThrow();
  });
  it("accepts a pending index with no completed head and optional slot linkage", () => {
    const index = { formatVersion: 2, id: "mascot", name: "Mascot", directionId: "route", versions: ["a1"], head: "", slotId: "icon.mascot" };
    expect(parseExtractedAssetIndex(index)).toEqual(index);
    const { formatVersion: _, ...old } = index;
    expect(() => parseExtractedAssetIndex(old)).toThrow();
  });
  it("retirement remains non-destructive and optional", () => {
    expect(isExtractedAssetRetired({})).toBe(false);
    expect(isExtractedAssetRetired({ retiredAt: "" })).toBe(false);
    expect(isExtractedAssetRetired({ retiredAt: "2026-10-10" })).toBe(true);
  });
});
