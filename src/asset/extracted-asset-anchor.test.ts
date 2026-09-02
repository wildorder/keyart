import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { appendVersionToIndex, extractedAssetsRoot } from "./asset-store.js";
import { parseExtractedAssetIndex } from "./schema.js";
import type { AssetVersion } from "./schema.js";

/**
 * WS-10 (SC-02 / SC-03): the re-anchoring regression fence. Extracted assets
 * live under the DIRECTION's own tree, `ExtractedAssetIndex` carries
 * `directionId` (required, no legacy anchor field to fall back to), and the
 * pointer-addressed commands (`audit`, `surface bind`, `surface fill`) carry
 * NO draft guard — encoding R-2/R-3 at the source level so a future edit that
 * tries to draft-guard a pointer-addressed command fails here. Network-free,
 * key-free, no CLI.
 */

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-asset-anchor-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const VERSION: AssetVersion = {
  id: "v1",
  createdAt: "2026-08-20T00:00:00.000Z",
  description: "the brand mascot",
  source: {
    directionId: "direction-a",
    versionId: "2026-08-20T00-00-00-000Z",
    image: "styleTile",
  },
  files: [],
};

describe("extracted-asset anchor — location (SC-02)", () => {
  it("appendVersionToIndex writes index + version under <directionDir>/extracted-assets/<id>/ exactly", async () => {
    // A directionDir shaped like the real tree: <brand>/directions/<id>.
    const directionDir = path.join(tmpDir, "brand", "directions", "direction-a");

    await appendVersionToIndex(
      directionDir,
      "mascot",
      { name: "Mascot", directionId: "direction-a" },
      VERSION,
    );

    // extractedAssetsRoot IS <directionDir>/extracted-assets — nothing else.
    expect(extractedAssetsRoot(directionDir)).toBe(
      path.join(directionDir, "extracted-assets"),
    );

    const indexPath = path.join(directionDir, "extracted-assets", "mascot", "asset.json");
    const versionPath = path.join(
      directionDir,
      "extracted-assets",
      "mascot",
      "versions",
      "v1",
      "asset-version.json",
    );
    await expect(fs.access(indexPath)).resolves.toBeUndefined();
    await expect(fs.access(versionPath)).resolves.toBeUndefined();

    // The ONLY tree written under tmpDir is the direction-anchored one: every
    // written file sits at exactly brand/directions/direction-a/extracted-assets/…
    // (no other anchor segment of any kind).
    const written: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else written.push(path.relative(tmpDir, full).split(path.sep).join("/"));
      }
    }
    await walk(tmpDir);
    expect(written.sort()).toEqual([
      "brand/directions/direction-a/extracted-assets/mascot/asset.json",
      "brand/directions/direction-a/extracted-assets/mascot/versions/v1/asset-version.json",
    ]);
  });
});

describe("ExtractedAssetIndex — direction anchor only (SC-02)", () => {
  it("strips a stray unknown legacy key, keeping directionId", () => {
    const parsed = parseExtractedAssetIndex({
      id: "mascot",
      name: "Mascot",
      directionId: "direction-a",
      versions: ["v1"],
      head: "v1",
      legacyAnchor: "moody", // unknown key — stripped by the schema
    });
    expect(parsed.directionId).toBe("direction-a");
    expect("legacyAnchor" in parsed).toBe(false);
    expect(Object.keys(parsed).sort()).toEqual([
      "directionId",
      "head",
      "id",
      "name",
      "versions",
    ]);
  });

  it("throws when directionId is omitted — required, with no legacy anchor to fall back to", () => {
    expect(() =>
      parseExtractedAssetIndex({
        id: "mascot",
        name: "Mascot",
        versions: ["v1"],
        head: "v1",
      }),
    ).toThrow();
  });
});

describe("no draft guard on pointer-addressed commands (R-2/R-3 fence, SC-03)", () => {
  // The complement of WS-15's positive-membership fence
  // (src/direction/draft-guard.test.ts): audit and surface bind/fill take no
  // direction argument, so a draft is not a representable input — they must
  // never gain (or even reference) the guard.
  const POINTER_ADDRESSED = [
    "../commands/audit.ts",
    "../surface/bind.ts",
    "../surface/fill.ts",
  ];

  it.each(POINTER_ADDRESSED)("%s never references assertDirectionHasVersions", async (relPath) => {
    const sourcePath = fileURLToPath(new URL(relPath, import.meta.url));
    const source = await fs.readFile(sourcePath, "utf-8");
    expect(source).not.toContain("assertDirectionHasVersions");
    expect(source).not.toContain("draft-guard");
  });
});
