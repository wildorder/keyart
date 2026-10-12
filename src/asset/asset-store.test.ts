import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CommandError } from "../errors.js";
import { ensureDir, writeTextFile } from "../fs.js";
import type { AssetVersion } from "./schema.js";
import {
  mintAssetId,
  mintAssetVersionId,
  listAssetIds,
  readAssetIndex,
  writeAssetIndex,
  readAssetVersion,
  readAssetHead,
  readExtractedAsset,
  appendVersionToIndex,
  retireExtractedAsset,
  setExtractedAssetSlotId,
  reserveAssetId,
  reserveAssetVersion,
  readAssetLatestAttempt,
} from "./asset-store.js";
import { isExtractedAssetRetired } from "./schema.js";

let directionDirA: string;
let directionDirB: string;

/** The `makeVersion` idiom — a valid AssetVersion with a full AssetSource. */
function makeAssetVersion(
  id: string,
  overrides: Partial<AssetVersion> = {},
): AssetVersion {
  return {
    formatVersion: 2,
    status: "completed",
    conditioning: "foundation",
    contextSnapshot: "{}",
    foundation: { directionId: "direction-a", versionId: "v1" },
    id,
    createdAt: "2026-07-26T00:00:00.000Z",
    description: "the yak mascot",
    provenance: { kind: "generated" },
    files: [],
    ...overrides,
  };
}

/** Recursively snapshot a directory's file contents (path -> raw bytes), for byte-identity checks. */
async function snapshotDir(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else {
        out[path.relative(dir, full)] = await fs.readFile(full, "utf-8");
      }
    }
  }
  await walk(dir);
  return out;
}

beforeEach(async () => {
  directionDirA = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "keyart-assetstore-a-")), "direction-a");
  directionDirB = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "keyart-assetstore-b-")), "direction-b");
  await fs.mkdir(directionDirA);
  await fs.mkdir(directionDirB);
});

afterEach(async () => {
  vi.useRealTimers();
  await fs.rm(path.dirname(directionDirA), { recursive: true, force: true });
  await fs.rm(path.dirname(directionDirB), { recursive: true, force: true });
});

describe("round-trip + head advance", () => {
  it("appends v1, reads it back, then appends v2 and advances the head", async () => {
    const v1 = makeAssetVersion("v1");
    const index1 = await appendVersionToIndex(
      directionDirA,
      "yak-mascot",
      { name: "Yak Mascot", directionId: "direction-a" },
      v1,
    );

    expect(await readAssetVersion(directionDirA, "yak-mascot", "v1")).toEqual(v1);
    expect((await readAssetHead(directionDirA, "yak-mascot")).id).toBe("v1");
    expect(index1).toEqual({
      formatVersion: 2,
      id: "yak-mascot",
      name: "Yak Mascot",
      directionId: "direction-a",
      versions: ["v1"],
      head: "v1",
    });

    const v2 = makeAssetVersion("v2", { producedBy: "make it bolder" });
    const index2 = await appendVersionToIndex(
      directionDirA,
      "yak-mascot",
      { name: "Yak Mascot", directionId: "direction-a" },
      v2,
    );

    expect(index2.versions).toEqual(["v1", "v2"]);
    expect(index2.head).toBe("v2");
    // name/directionId survive the second append even though meta is passed again.
    expect(index2.name).toBe("Yak Mascot");
    expect(index2.directionId).toBe("direction-a");

    const hydrated = await readExtractedAsset(directionDirA, "yak-mascot");
    expect(hydrated.id).toBe("yak-mascot");
    expect(hydrated.name).toBe("Yak Mascot");
    expect(hydrated.directionId).toBe("direction-a");
    expect(hydrated.versions).toEqual([v1, v2]);
  });
});

describe("append-only", () => {
  it("writing v2 leaves v1's folder byte-untouched on disk", async () => {
    const v1 = makeAssetVersion("v1");
    await appendVersionToIndex(
      directionDirA,
      "yak-mascot",
      { name: "Yak Mascot", directionId: "direction-a" },
      v1,
    );

    const v1Dir = path.join(directionDirA, "extracted-assets", "yak-mascot", "versions", "v1");
    const sentinelPath = path.join(v1Dir, "asset-prompt.md");
    await writeTextFile(sentinelPath, "the composed prompt, v1\n");

    const rawVersionBefore = await fs.readFile(
      path.join(v1Dir, "asset-version.json"),
      "utf-8",
    );
    const rawSentinelBefore = await fs.readFile(sentinelPath, "utf-8");
    const entriesBefore = (await fs.readdir(v1Dir)).sort();

    const v2 = makeAssetVersion("v2");
    await appendVersionToIndex(
      directionDirA,
      "yak-mascot",
      { name: "Yak Mascot", directionId: "direction-a" },
      v2,
    );

    const rawVersionAfter = await fs.readFile(
      path.join(v1Dir, "asset-version.json"),
      "utf-8",
    );
    const rawSentinelAfter = await fs.readFile(sentinelPath, "utf-8");
    const entriesAfter = (await fs.readdir(v1Dir)).sort();

    expect(rawVersionAfter).toBe(rawVersionBefore);
    expect(rawSentinelAfter).toBe(rawSentinelBefore);
    expect(entriesAfter).toEqual(entriesBefore);
  });

  it("rejects a duplicate version id before any byte is written (immutability guard)", async () => {
    const v1 = makeAssetVersion("v1");
    await appendVersionToIndex(
      directionDirA,
      "yak-mascot",
      { name: "Yak Mascot", directionId: "direction-a" },
      v1,
    );

    const v1Dir = path.join(directionDirA, "extracted-assets", "yak-mascot", "versions", "v1");
    const sentinelPath = path.join(v1Dir, "asset-prompt.md");
    await writeTextFile(sentinelPath, "the composed prompt, v1\n");

    const rawVersionBefore = await fs.readFile(
      path.join(v1Dir, "asset-version.json"),
      "utf-8",
    );
    const rawSentinelBefore = await fs.readFile(sentinelPath, "utf-8");
    const entriesBefore = (await fs.readdir(v1Dir)).sort();

    const duplicate = makeAssetVersion("v1", { description: "a sneaky rewrite" });
    await expect(
      appendVersionToIndex(
        directionDirA,
        "yak-mascot",
        { name: "Yak Mascot", directionId: "direction-a" },
        duplicate,
      ),
    ).rejects.toBeInstanceOf(CommandError);
    await expect(
      appendVersionToIndex(
        directionDirA,
        "yak-mascot",
        { name: "Yak Mascot", directionId: "direction-a" },
        duplicate,
      ),
    ).rejects.toThrow(/yak-mascot.*v1/s);

    const rawVersionAfter = await fs.readFile(
      path.join(v1Dir, "asset-version.json"),
      "utf-8",
    );
    const rawSentinelAfter = await fs.readFile(sentinelPath, "utf-8");
    const entriesAfter = (await fs.readdir(v1Dir)).sort();

    expect(rawVersionAfter).toBe(rawVersionBefore);
    expect(rawSentinelAfter).toBe(rawSentinelBefore);
    expect(entriesAfter).toEqual(entriesBefore);

    const index = await readAssetIndex(directionDirA, "yak-mascot");
    expect(index.versions).toEqual(["v1"]);
    expect(index.head).toBe("v1");
  });
});

describe("collision-safe asset-id minting", () => {
  it("two same-name mints yield distinct ids, never a clobber", async () => {
    const firstId = mintAssetId("Yak Mascot", []);
    expect(firstId).toBe("yak-mascot");

    await appendVersionToIndex(
      directionDirA,
      firstId,
      { name: "Yak Mascot", directionId: "direction-a" },
      makeAssetVersion("v1"),
    );

    const secondId = mintAssetId("Yak Mascot", await listAssetIds(directionDirA));
    expect(secondId).toBe("yak-mascot-2");

    await appendVersionToIndex(
      directionDirA,
      secondId,
      { name: "Yak Mascot", directionId: "direction-a" },
      makeAssetVersion("v1"),
    );

    // the first asset's index and version file are intact.
    const firstIndex = await readAssetIndex(directionDirA, firstId);
    expect(firstIndex.versions).toEqual(["v1"]);
    expect(await readAssetVersion(directionDirA, firstId, "v1")).toEqual(
      makeAssetVersion("v1"),
    );
  });

  it("falls back to 'asset' when the name slugifies to nothing", () => {
    expect(mintAssetId("!!!", [])).toBe("asset");
  });
});

describe("same-millisecond version-id collision safety", () => {
  it("disambiguates with a numeric suffix", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T12:00:00.000Z"));

    const first = mintAssetVersionId([]);
    expect(first).toBe("2026-07-26T12-00-00-000Z");

    const second = mintAssetVersionId([first]);
    expect(second).toBe("2026-07-26T12-00-00-000Z-2");
  });
});

describe("retire", () => {
  it("is non-destructive, idempotent, and flips the predicate", async () => {
    await appendVersionToIndex(
      directionDirA,
      "yak-mascot",
      { name: "Yak Mascot", directionId: "direction-a" },
      makeAssetVersion("v1"),
    );
    await appendVersionToIndex(
      directionDirA,
      "yak-mascot",
      { name: "Yak Mascot", directionId: "direction-a" },
      makeAssetVersion("v2"),
    );

    const before = await readAssetIndex(directionDirA, "yak-mascot");
    expect(isExtractedAssetRetired(before)).toBe(false);

    const retired = await retireExtractedAsset(
      directionDirA,
      "yak-mascot",
      "2026-07-26T13:00:00.000Z",
    );
    expect(retired.retiredAt).toBe("2026-07-26T13:00:00.000Z");
    expect(isExtractedAssetRetired(retired)).toBe(true);
    expect(retired.versions).toEqual(["v1", "v2"]);
    expect(retired.head).toBe("v2");

    // both version folders and their contents still exist on disk.
    const v1Dir = path.join(directionDirA, "extracted-assets", "yak-mascot", "versions", "v1");
    const v2Dir = path.join(directionDirA, "extracted-assets", "yak-mascot", "versions", "v2");
    expect(await fs.access(v1Dir).then(() => true)).toBe(true);
    expect(await fs.access(v2Dir).then(() => true)).toBe(true);

    // a second retire (different `when`) keeps the ORIGINAL retiredAt.
    const secondRetire = await retireExtractedAsset(
      directionDirA,
      "yak-mascot",
      "2026-07-26T14:00:00.000Z",
    );
    expect(secondRetire.retiredAt).toBe("2026-07-26T13:00:00.000Z");

    const thirdRetire = await retireExtractedAsset(directionDirA, "yak-mascot");
    expect(thirdRetire.retiredAt).toBe("2026-07-26T13:00:00.000Z");
  });

  it("rejects retiring an absent asset with CommandError", async () => {
    await expect(
      retireExtractedAsset(directionDirA, "ghost"),
    ).rejects.toBeInstanceOf(CommandError);
  });
});

describe("slotId linkage (surface-manifest WS-03)", () => {
  it("stores meta.slotId on CREATION", async () => {
    const index = await appendVersionToIndex(
      directionDirA,
      "restaurant",
      { name: "Restaurant", directionId: "direction-a", slotId: "icon.restaurant" },
      makeAssetVersion("v1"),
    );
    expect(index.slotId).toBe("icon.restaurant");
    expect(await readAssetIndex(directionDirA, "restaurant")).toMatchObject({
      slotId: "icon.restaurant",
    });
  });

  it("preserves the original slotId across a later append with a DIFFERENT meta.slotId (creation-only, like name)", async () => {
    await appendVersionToIndex(
      directionDirA,
      "restaurant",
      { name: "Restaurant", directionId: "direction-a", slotId: "icon.restaurant" },
      makeAssetVersion("v1"),
    );
    const index2 = await appendVersionToIndex(
      directionDirA,
      "restaurant",
      { name: "Restaurant", directionId: "direction-a", slotId: "icon.other" },
      makeAssetVersion("v2"),
    );
    expect(index2.slotId).toBe("icon.restaurant");
  });

  it("omits slotId entirely when meta.slotId is absent (never stores slotId: undefined)", async () => {
    const index = await appendVersionToIndex(
      directionDirA,
      "restaurant",
      { name: "Restaurant", directionId: "direction-a" },
      makeAssetVersion("v1"),
    );
    expect("slotId" in index).toBe(false);
    const raw = JSON.parse(
      await fs.readFile(
        path.join(directionDirA, "extracted-assets", "restaurant", "asset.json"),
        "utf-8",
      ),
    );
    expect("slotId" in raw).toBe(false);
  });

  it("setExtractedAssetSlotId sets/overwrites slotId on an existing index", async () => {
    await appendVersionToIndex(
      directionDirA,
      "restaurant",
      { name: "Restaurant", directionId: "direction-a" },
      makeAssetVersion("v1"),
    );
    const linked = await setExtractedAssetSlotId(
      directionDirA,
      "restaurant",
      "icon.restaurant",
    );
    expect(linked.slotId).toBe("icon.restaurant");
    expect(await readAssetIndex(directionDirA, "restaurant")).toMatchObject({
      slotId: "icon.restaurant",
    });

    const relinked = await setExtractedAssetSlotId(
      directionDirA,
      "restaurant",
      "icon.restaurant-2",
    );
    expect(relinked.slotId).toBe("icon.restaurant-2");
  });

  it("throws CommandError for an unknown asset", async () => {
    await expect(
      setExtractedAssetSlotId(directionDirA, "ghost", "icon.restaurant"),
    ).rejects.toBeInstanceOf(CommandError);
  });
});

describe("listAssetIds", () => {
  it("returns [] on an absent tree (never throws)", async () => {
    expect(await listAssetIds(directionDirA)).toEqual([]);
  });

  it("returns sorted ids once assets exist", async () => {
    await appendVersionToIndex(
      directionDirA,
      "wave-pattern",
      { name: "Wave Pattern", directionId: "direction-a" },
      makeAssetVersion("v1"),
    );
    await appendVersionToIndex(
      directionDirA,
      "yak-mascot",
      { name: "Yak Mascot", directionId: "direction-a" },
      makeAssetVersion("v1"),
    );
    expect(await listAssetIds(directionDirA)).toEqual(["wave-pattern", "yak-mascot"]);
  });
});

describe("CommandError on genuinely named-absent targets", () => {
  it("readAssetIndex rejects for an absent asset", async () => {
    await expect(
      readAssetIndex(directionDirA, "ghost"),
    ).rejects.toBeInstanceOf(CommandError);
    await expect(readAssetIndex(directionDirA, "ghost")).rejects.toThrow(/ghost/);
  });

  it("readAssetVersion rejects for an existing asset with an absent version", async () => {
    await appendVersionToIndex(
      directionDirA,
      "yak-mascot",
      { name: "Yak Mascot", directionId: "direction-a" },
      makeAssetVersion("v1"),
    );
    await expect(
      readAssetVersion(directionDirA, "yak-mascot", "v99"),
    ).rejects.toBeInstanceOf(CommandError);
    await expect(
      readAssetVersion(directionDirA, "yak-mascot", "v99"),
    ).rejects.toThrow(/yak-mascot.*v99/s);
  });

  it("readAssetHead rejects for an absent asset", async () => {
    await expect(
      readAssetHead(directionDirA, "ghost"),
    ).rejects.toBeInstanceOf(CommandError);
  });
});

describe("per-direction isolation", () => {
  it("never reads or writes under a sibling direction's dir", async () => {
    await appendVersionToIndex(
      directionDirA,
      "yak-mascot",
      { name: "Yak Mascot", directionId: "direction-a" },
      makeAssetVersion("v1"),
    );
    await appendVersionToIndex(
      directionDirB,
      "wave-pattern",
      { name: "Wave Pattern", directionId: "direction-b" },
      makeAssetVersion("v1", { foundation: { directionId: "direction-b", versionId: "v1" } }),
    );

    expect(await listAssetIds(directionDirB)).toEqual(["wave-pattern"]);
    await expect(
      readAssetIndex(directionDirB, "yak-mascot"),
    ).rejects.toBeInstanceOf(CommandError);

    const snapshotBefore = await snapshotDir(directionDirB);

    await appendVersionToIndex(
      directionDirA,
      "yak-mascot",
      { name: "Yak Mascot", directionId: "direction-a" },
      makeAssetVersion("v2"),
    );
    await retireExtractedAsset(directionDirA, "yak-mascot");

    const snapshotAfter = await snapshotDir(directionDirB);
    expect(snapshotAfter).toEqual(snapshotBefore);
  });
});

describe("Zod parse rejects malformed records at the read boundary", () => {
  it("readAssetIndex rejects a malformed asset.json (missing head)", async () => {
    const assetDir = path.join(directionDirA, "extracted-assets", "ghost-index");
    await ensureDir(assetDir);
    await writeTextFile(
      path.join(assetDir, "asset.json"),
      JSON.stringify({
        id: "ghost-index",
        name: "Ghost",
        directionId: "direction-a",
        versions: ["v1"],
      }),
    );
    await expect(
      readAssetIndex(directionDirA, "ghost-index"),
    ).rejects.toBeInstanceOf(CommandError);
  });

  it("readAssetVersion rejects a malformed asset-version.json", async () => {
    await appendVersionToIndex(
      directionDirA,
      "yak-mascot",
      { name: "Yak Mascot", directionId: "direction-a" },
      makeAssetVersion("v1"),
    );
    const versionPath = path.join(
      directionDirA,
      "extracted-assets",
      "yak-mascot",
      "versions",
      "v1",
      "asset-version.json",
    );
    await writeTextFile(
      versionPath,
      JSON.stringify({ id: "v1", createdAt: "2026-07-26T00:00:00.000Z" }),
    );
    await expect(
      readAssetVersion(directionDirA, "yak-mascot", "v1"),
    ).rejects.toBeInstanceOf(CommandError);
  });
});

// writeAssetIndex is exercised indirectly via appendVersionToIndex/retireExtractedAsset;
// this proves it also round-trips directly.
describe("writeAssetIndex", () => {
  it("round-trips through readAssetIndex", async () => {
    await writeAssetIndex(directionDirA, {
      formatVersion: 2,
      id: "yak-mascot",
      name: "Yak Mascot",
      directionId: "direction-a",
      versions: ["v1"],
      head: "v1",
    });
    expect(await readAssetIndex(directionDirA, "yak-mascot")).toEqual({
      formatVersion: 2,
      id: "yak-mascot",
      name: "Yak Mascot",
      directionId: "direction-a",
      versions: ["v1"],
      head: "v1",
    });
  });
});

describe("concurrent attempts and honest heads", () => {
  it("refuses a changed reserved origin or conditioning without advancing the head", async () => {
    const id = await reserveAssetId(directionDirA, "Mascot");
    const { id: _, ...template } = makeAssetVersion("unused", { status: "pending" });
    const meta = { name: "Mascot", directionId: "direction-a" };
    const attempt = await reserveAssetVersion(directionDirA, id, meta, template);
    await expect(appendVersionToIndex(directionDirA, id, meta, { ...attempt, conditioning: "legacy-unverified" })).rejects.toThrow(/conditioning/);
    await expect(appendVersionToIndex(directionDirA, id, meta, { ...attempt, provenance: { kind: "extracted", source: { kind: "foundation", directionId: "direction-a", versionId: "v1", image: "styleTile" } } })).rejects.toThrow(/provenance/);
    expect((await readAssetIndex(directionDirA, id)).head).toBe("");
    expect(await readAssetVersion(directionDirA, id, attempt.id)).toEqual(attempt);
  });

  it("reserves distinct identities and concurrent revisions without lost updates", async () => {
    const ids = await Promise.all(Array.from({ length: 4 }, () => reserveAssetId(directionDirA, "Mascot")));
    expect(new Set(ids).size).toBe(4);
    const { id: _, ...template } = makeAssetVersion("unused", { status: "pending" });
    const attempts = await Promise.all(Array.from({ length: 6 }, () => reserveAssetVersion(directionDirA, ids[0], { name: "Mascot", directionId: "direction-a" }, template)));
    expect(new Set(attempts.map((a) => a.id)).size).toBe(6);
    const pending = await readAssetIndex(directionDirA, ids[0]);
    expect(pending.versions).toHaveLength(6);
    expect(pending.head).toBe("");
    await expect(readAssetHead(directionDirA, ids[0])).rejects.toThrow(/no completed/);
    expect((await readAssetLatestAttempt(directionDirA, ids[0])).status).toBe("pending");
    await fs.writeFile(path.join(directionDirA, "extracted-assets", ids[0], "versions", attempts[0].id, "asset.png"), "completed-image");
    await appendVersionToIndex(directionDirA, ids[0], { name: "Mascot", directionId: "direction-a" }, { ...attempts[0], status: "completed", files: ["asset.png"] });
    await appendVersionToIndex(directionDirA, ids[0], { name: "Mascot", directionId: "direction-a" }, { ...attempts[1], status: "failed" });
    const settled = await readAssetIndex(directionDirA, ids[0]);
    expect(settled.head).toBe(attempts[0].id);
    expect(settled.versions).toHaveLength(6);
    expect((await readAssetVersion(directionDirA, ids[0], attempts[2].id)).status).toBe("pending");
  });

  it("refuses unsupported existing records before changing their bytes", async () => {
    const dir = path.join(directionDirA, "extracted-assets", "old");
    await fs.mkdir(dir, { recursive: true });
    const old = JSON.stringify({ id: "old", name: "Old", directionId: "direction-a", versions: ["v1"], head: "v1" });
    await fs.writeFile(path.join(dir, "asset.json"), old);
    await expect(appendVersionToIndex(directionDirA, "old", { name: "Old", directionId: "direction-a" }, makeAssetVersion("v2"))).rejects.toThrow(/convert/);
    expect(await fs.readFile(path.join(dir, "asset.json"), "utf8")).toBe(old);
    expect(await fs.readdir(dir)).toEqual(["asset.json"]);
  });
});
