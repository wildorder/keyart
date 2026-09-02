import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { DirectionVersion, DirectionTokens, KeyartConfig } from "../types.js";
import type { AssetSource, AssetVersion } from "./schema.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import {
  appendVersionToIndex as appendAssetVersion,
  readAssetIndex,
  writeAssetIndex,
} from "./asset-store.js";
import { CommandError } from "../errors.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

const VERSION_ID_1 = "2026-06-30T00-00-00-000Z";
const VERSION_ID_2 = "2026-07-01T00-00-00-000Z";

const FIXTURE_TOKENS: DirectionTokens = {
  palette: [
    { role: "primary", name: "Hot Pink", hex: "#e84393" },
    { role: "secondary", name: "Sky Blue", hex: "#2d98da" },
    { role: "background", name: "Cream", hex: "#faf6f0" },
    { role: "surface", name: "White", hex: "#ffffff" },
    { role: "text", name: "Ink", hex: "#1c1a17" },
    { role: "muted", name: "Slate", hex: "#6c757d" },
  ],
  brand: [
    { hex: "#e84393", name: "pink", label: "Hot Pink" },
    { hex: "#2d98da", name: "sky-blue" },
  ],
  typography: { heading: "Space Grotesk", body: "Inter", scale: 1.25 },
  shape: { radius: "8px", spacingUnit: "8px" },
};

function makeVersion(
  id: string,
  name: string,
  primaryHex: string,
  tokens: DirectionTokens | null = FIXTURE_TOKENS,
): DirectionVersion {
  return {
    id,
    createdAt: "2026-07-26T00:00:00.000Z",
    briefSnapshot: "brief snapshot",
    contextSnapshot: "context snapshot",
    name,
    summary: "A summary.",
    positioning: "A positioning statement.",
    character: {},
    homepageMockupPrompt: "",
    styleTilePrompt: "",
    copyExamples: { headline: "h", subheadline: "s", cta: "c" },
    usage: { rules: [], antiRules: [] },
    ...(tokens
      ? {
          tokens: {
            ...tokens,
            palette: tokens.palette.map((t) =>
              t.role === "primary" ? { ...t, hex: primaryHex } : t,
            ),
          },
        }
      : {}),
  };
}

const V1 = makeVersion(VERSION_ID_1, "Direction A v1", "#e84393");
const V2 = makeVersion(VERSION_ID_2, "Direction A v2", "#112233");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-asset-pack-"));
  delete process.env.OPENAI_API_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function mockConfig(): KeyartConfig {
  return {
    project: { name: "Test Project", type: "prototype", framework: "next" },
    brand: {
      root: path.join(tmpDir, "brand"),
      references: path.join(tmpDir, "brand", "input", "references"),
      approved: path.join(tmpDir, "brand", "approved"),
      rejected: path.join(tmpDir, "brand", "rejected"),
    },
    models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
    outputs: {
      cursorRules: path.join(tmpDir, ".cursor", "rules", "keyart-brand.mdc"),
      cssVars: path.join(tmpDir, "brand", "generated", "brand.css"),
      implementationBrief: path.join(
        tmpDir,
        "brand",
        "generated",
        "implementation-brief.md",
      ),
    },
    store: { driver: "file" },
  };
}

async function seedDirection(config: KeyartConfig, id: string): Promise<void> {
  await createDirectionCore(tmpDir, config).create({ id, name: id });
}

function directionDirOf(directionId: string): string {
  return path.join(tmpDir, "brand", "directions", directionId);
}

async function writeDirectionVersions(
  config: KeyartConfig,
  directionId: string,
  versions: DirectionVersion[],
): Promise<void> {
  const core = createDirectionCore(tmpDir, config);
  try {
    await core.get(directionId);
  } catch {
    await core.create({ id: directionId, name: directionId });
  }
  const versionsDir = path.join(directionDirOf(directionId), "versions");
  for (const v of versions) {
    const versionDir = path.join(versionsDir, v.id);
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(
      path.join(versionDir, "direction-version.json"),
      JSON.stringify(v),
      "utf-8",
    );
    await core.appendVersion(directionId, v.id);
  }
}

async function writeAssetFixture(
  assetId: string,
  opts: {
    name: string;
    directionId: string;
    versionId: string;
    description?: string;
    source: AssetSource;
    withPng?: boolean;
    dryRun?: boolean;
  },
): Promise<void> {
  const directionDir = directionDirOf(opts.directionId);
  const version: AssetVersion = {
    id: opts.versionId,
    createdAt: "2026-07-26T00:00:00.000Z",
    description: opts.description ?? `${opts.name} description`,
    source: opts.source,
    files: opts.withPng ? ["asset.png"] : [],
    ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
  };
  await appendAssetVersion(
    directionDir,
    assetId,
    { name: opts.name, directionId: opts.directionId },
    version,
  );
  if (opts.withPng) {
    const pngPath = path.join(
      directionDir,
      "extracted-assets",
      assetId,
      "versions",
      opts.versionId,
      "asset.png",
    );
    await fs.writeFile(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  }
}

async function retireAssetFixture(directionId: string, assetId: string): Promise<void> {
  const directionDir = directionDirOf(directionId);
  const index = await readAssetIndex(directionDir, assetId);
  await writeAssetIndex(directionDir, {
    ...index,
    retiredAt: "2026-07-26T12:00:00.000Z",
  });
}

function packDirOf(directionId: string): string {
  return path.join(tmpDir, "brand", "generated", "asset-pack", directionId);
}

async function readManifest(directionId: string): Promise<Record<string, any>> {
  return JSON.parse(
    await fs.readFile(path.join(packDirOf(directionId), "pack-manifest.json"), "utf-8"),
  );
}

async function readTokens(directionId: string): Promise<Record<string, any>> {
  return JSON.parse(
    await fs.readFile(path.join(packDirOf(directionId), "tokens.json"), "utf-8"),
  );
}

async function packDirEntries(directionId: string): Promise<string[]> {
  try {
    return await fs.readdir(packDirOf(directionId));
  } catch {
    return [];
  }
}

async function loadRunAssetPack() {
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(mockConfig());
  const { runAssetPack } = await import("./pack.js");
  return runAssetPack;
}

const SRC_A: AssetSource = {
  directionId: "direction-a",
  versionId: VERSION_ID_1,
  image: "styleTile",
};

describe("runAssetPack — direction resolution", () => {
  it("defaults to the approved pointer's direction/direction and pins the approved version", async () => {
    const config = mockConfig();
    await seedDirection(config, "default");
    await writeDirectionVersions(config, "direction-a", [V1]);
    await writeAssetFixture("yak-mascot", {
      name: "Yak mascot",
      directionId: "direction-a",
      versionId: "av1",
      source: SRC_A,
      withPng: true,
    });
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a",
      versionId: VERSION_ID_1,
    });

    const runAssetPack = await loadRunAssetPack();
    const result = await runAssetPack({ cwd: tmpDir });

    expect(result.directionId).toBe("direction-a");

    const manifest = await readManifest("direction-a");
    expect(manifest.generatedFrom).toBe(VERSION_ID_1);
    expect(manifest.approved).toBe(true);
  });

  it("resolves the PINNED version's tokens for the approved direction even after the head advances; an unapproved direction uses its head", async () => {
    const config = mockConfig();
    await seedDirection(config, "default");
    await writeDirectionVersions(config, "direction-a", [V1, V2]); // head = v2
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a",
      versionId: VERSION_ID_1, // pin v1, even though head is v2
    });

    const runAssetPack = await loadRunAssetPack();
    await runAssetPack({ cwd: tmpDir });

    const tokens = await readTokens("direction-a");
    expect(tokens.color.primary.$value.hex).toBe("#e84393"); // V1's hex, not V2's #112233
    const manifest = await readManifest("direction-a");
    expect(manifest.generatedFrom).toBe(VERSION_ID_1);

    // A sibling, unapproved direction uses its own HEAD, not the approved pointer.
    const VB1 = makeVersion(VERSION_ID_1, "Direction B v1", "#abcdef");
    const VB2 = { ...V2, id: "2026-07-02T00-00-00-000Z", name: "Direction B v2" };
    await writeDirectionVersions(config, "direction-b", [VB1, VB2]);

    const resultB = await runAssetPack({ cwd: tmpDir, directionId: "direction-b" });
    expect(resultB.directionId).toBe("direction-b");
    const manifestB = await readManifest("direction-b");
    expect(manifestB.generatedFrom).toBe(VB2.id); // the head, not a pin
    expect(manifestB.approved).toBe(false);
    const tokensB = await readTokens("direction-b");
    expect(tokensB.color.primary.$value.hex).toBe("#112233"); // V2's hex (head)
  });

  it("an explicit directionId overrides the approved pointer entirely", async () => {
    const config = mockConfig();
    await seedDirection(config, "default");
    await writeDirectionVersions(config, "direction-a", [V1]);
    await writeDirectionVersions(config, "direction-b", [
      makeVersion(VERSION_ID_1, "Direction B", "#00ff00"),
    ]);
    await writeAssetFixture("asset-a", {
      name: "Asset A",
      directionId: "direction-a",
      versionId: "av1",
      source: SRC_A,
      withPng: true,
    });
    await writeAssetFixture("asset-b", {
      name: "Asset B",
      directionId: "direction-b",
      versionId: "bv1",
      source: { ...SRC_A, directionId: "direction-b" },
      withPng: true,
    });
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a",
      versionId: VERSION_ID_1,
    });

    const runAssetPack = await loadRunAssetPack();
    const result = await runAssetPack({ cwd: tmpDir, directionId: "direction-b" });

    expect(result.directionId).toBe("direction-b");
    expect(result.assetsIncluded).toEqual(["asset-b"]);
    const tokens = await readTokens("direction-b");
    expect(tokens.color.primary.$value.hex).toBe("#00ff00");
    // direction-a's pack was never written by this call.
    expect(await packDirEntries("direction-a")).toEqual([]);
  });

  // WS-10 (SC-11, R-4): the id-omitted POINTER branch resolves the approved
  // pointer's direction SPECIFICALLY — a second, un-approved direction sits on
  // disk so a wrong "pick any direction" implementation fails.
  it("id omitted + approved resolves the pointer's direction, not a sibling on disk (R-4)", async () => {
    const config = mockConfig();
    await seedDirection(config, "default");
    await writeDirectionVersions(config, "direction-a", [V1]);
    await writeDirectionVersions(config, "direction-b", [
      makeVersion(VERSION_ID_1, "Direction B", "#00ff00"),
    ]);
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a",
      versionId: VERSION_ID_1,
    });

    const runAssetPack = await loadRunAssetPack();
    const result = await runAssetPack({ cwd: tmpDir });

    expect(result.directionId).toBe("direction-a"); // the pointer's direction, specifically
    expect(result.packDir).toBe("brand/generated/asset-pack/direction-a");
    // The sibling's pack was never written.
    expect(await packDirEntries("direction-b")).toEqual([]);
  });

  it("throws CommandError naming the remedy when nothing is approved and no direction is given", async () => {
    const config = mockConfig();
    await seedDirection(config, "default");

    const runAssetPack = await loadRunAssetPack();
    await expect(runAssetPack({ cwd: tmpDir })).rejects.toThrow(CommandError);
    await expect(runAssetPack({ cwd: tmpDir })).rejects.toThrow(/approv|direction/i);
    // WS-10 (SC-11, R-4): this is the POINTER branch's landed approve-first
    // error — it names `keyart approve` and NEVER the draft `explore` fix
    // (that error belongs to the explicit-draft-id branch, WS-15's under SC-03).
    await expect(runAssetPack({ cwd: tmpDir })).rejects.toThrow(/keyart approve/);
    const rejection = await runAssetPack({ cwd: tmpDir }).then(
      () => {
        throw new Error("expected runAssetPack to reject");
      },
      (err: unknown) => err as Error,
    );
    expect(rejection.message).not.toContain("keyart explore");
    expect(await packDirEntries("default")).toEqual([]);
  });
});

describe("runAssetPack — asset scoping + pending state", () => {
  it("excludes retired assets and removes their stale PNG on re-run", async () => {
    const config = mockConfig();
    await seedDirection(config, "default");
    await writeDirectionVersions(config, "direction-a", [V1]);
    await writeAssetFixture("keep-me", {
      name: "Keep me",
      directionId: "direction-a",
      versionId: "v1",
      source: SRC_A,
      withPng: true,
    });
    await writeAssetFixture("retire-me", {
      name: "Retire me",
      directionId: "direction-a",
      versionId: "v1",
      source: SRC_A,
      withPng: true,
    });
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a",
      versionId: VERSION_ID_1,
    });

    const runAssetPack = await loadRunAssetPack();
    const firstResult = await runAssetPack({ cwd: tmpDir });
    expect(firstResult.assetsIncluded.sort()).toEqual(["keep-me", "retire-me"]);
    expect(await packDirEntries("direction-a")).toContain("retire-me.png");

    await retireAssetFixture("direction-a", "retire-me");
    const secondResult = await runAssetPack({ cwd: tmpDir });

    expect(secondResult.assetsIncluded).toEqual(["keep-me"]);
    expect(secondResult.assetsPending).toEqual([]);
    const entries = await packDirEntries("direction-a");
    expect(entries).toContain("keep-me.png");
    expect(entries).not.toContain("retire-me.png");
    const manifest = await readManifest("direction-a");
    expect(manifest.assets.map((a: any) => a.id)).toEqual(["keep-me"]);
    const sheet = await fs.readFile(
      path.join(packDirOf("direction-a"), "contact-sheet.md"),
      "utf-8",
    );
    expect(sheet).not.toContain("retire-me");
  });

  it("excludes sibling-direction assets (SC-05)", async () => {
    const config = mockConfig();
    await seedDirection(config, "default");
    await writeDirectionVersions(config, "direction-a", [V1]);
    await writeDirectionVersions(config, "direction-b", [
      makeVersion(VERSION_ID_1, "Direction B", "#00ff00"),
    ]);
    await writeAssetFixture("asset-a", {
      name: "Asset A",
      directionId: "direction-a",
      versionId: "v1",
      source: SRC_A,
      withPng: true,
    });
    await writeAssetFixture("asset-b", {
      name: "Asset B",
      directionId: "direction-b",
      versionId: "v1",
      source: { ...SRC_A, directionId: "direction-b" },
      withPng: true,
    });

    const runAssetPack = await loadRunAssetPack();
    const resultA = await runAssetPack({ cwd: tmpDir, directionId: "direction-a" });
    expect(resultA.assetsIncluded).toEqual(["asset-a"]);
    expect(await packDirEntries("direction-a")).not.toContain("asset-b.png");
    const manifestA = await readManifest("direction-a");
    expect(manifestA.assets.map((a: any) => a.id)).toEqual(["asset-a"]);

    const resultB = await runAssetPack({ cwd: tmpDir, directionId: "direction-b" });
    expect(resultB.assetsIncluded).toEqual(["asset-b"]);
    expect(await packDirEntries("direction-b")).not.toContain("asset-a.png");
  });

  it("lists a dry-run head with no PNG as pending, never fabricating an image, alongside a mixed included sibling", async () => {
    const config = mockConfig();
    await seedDirection(config, "default");
    await writeDirectionVersions(config, "direction-a", [V1]);
    await writeAssetFixture("pending-asset", {
      name: "Pending asset",
      directionId: "direction-a",
      versionId: "v1",
      source: SRC_A,
      withPng: false,
      dryRun: true,
    });
    await writeAssetFixture("shipped-asset", {
      name: "Shipped asset",
      directionId: "direction-a",
      versionId: "v1",
      source: SRC_A,
      withPng: true,
    });

    const runAssetPack = await loadRunAssetPack();
    const result = await runAssetPack({ cwd: tmpDir, directionId: "direction-a" });

    expect(result.assetsPending).toEqual(["pending-asset"]);
    expect(result.assetsIncluded).toEqual(["shipped-asset"]);
    expect(await packDirEntries("direction-a")).not.toContain("pending-asset.png");
    expect(await packDirEntries("direction-a")).toContain("shipped-asset.png");

    const manifest = await readManifest("direction-a");
    const pendingRow = manifest.assets.find((a: any) => a.id === "pending-asset");
    const shippedRow = manifest.assets.find((a: any) => a.id === "shipped-asset");
    expect(pendingRow.pending).toBe(true);
    expect(shippedRow.pending).toBe(false);
    // The manifest states the packed filename explicitly — never inferred by
    // the consumer; a pending row carries no file (no image exists).
    expect(shippedRow.file).toBe("shipped-asset.png");
    expect(pendingRow.file).toBeUndefined();

    // The result mirrors the manifest detail + names the pack folder.
    expect(result.packDir).toBe("brand/generated/asset-pack/direction-a");
    expect(result.assets).toEqual([
      {
        id: "pending-asset",
        name: "Pending asset",
        description: "Pending asset description",
        pending: true,
      },
      {
        id: "shipped-asset",
        name: "Shipped asset",
        description: "Shipped asset description",
        pending: false,
        file: "shipped-asset.png",
      },
    ]);

    const sheet = await fs.readFile(
      path.join(packDirOf("direction-a"), "contact-sheet.svg"),
      "utf-8",
    );
    expect(sheet).toContain("pending (dry-run)");
  });
});

describe("runAssetPack — determinism + honesty", () => {
  it("writes byte-identical files across two runs with identical input, with cwd-relative forward-slash filesWritten", async () => {
    const config = mockConfig();
    await seedDirection(config, "default");
    await writeDirectionVersions(config, "direction-a", [V1]);
    await writeAssetFixture("yak-mascot", {
      name: "Yak mascot",
      directionId: "direction-a",
      versionId: "v1",
      source: SRC_A,
      withPng: true,
    });

    const runAssetPack = await loadRunAssetPack();
    const first = await runAssetPack({ cwd: tmpDir, directionId: "direction-a" });
    const firstBytes = await readAllPackFiles("direction-a");

    const second = await runAssetPack({ cwd: tmpDir, directionId: "direction-a" });
    const secondBytes = await readAllPackFiles("direction-a");

    for (const name of Object.keys(firstBytes)) {
      expect(secondBytes[name].equals(firstBytes[name])).toBe(true);
    }
    expect(first.filesWritten.slice().sort()).toEqual(second.filesWritten.slice().sort());
    expect(first.filesWritten.every((p) => !p.includes("\\"))).toBe(true);
    expect(first.filesWritten.every((p) => !path.isAbsolute(p))).toBe(true);

    async function readAllPackFiles(directionId: string): Promise<Record<string, Buffer>> {
      const dir = packDirOf(directionId);
      const names = await fs.readdir(dir);
      const out: Record<string, Buffer> = {};
      for (const name of names) {
        out[name] = await fs.readFile(path.join(dir, name));
      }
      return out;
    }
  });

  it("fails loudly (never inventing a palette) when the direction has no tokens", async () => {
    const config = mockConfig();
    await seedDirection(config, "default");
    const tokenless = makeVersion(VERSION_ID_1, "Tokenless", "#000000", null);
    await writeDirectionVersions(config, "direction-a", [tokenless]);

    const runAssetPack = await loadRunAssetPack();
    await expect(
      runAssetPack({ cwd: tmpDir, directionId: "direction-a" }),
    ).rejects.toThrow(/tokens/i);
    expect(await packDirEntries("direction-a")).toEqual([]);
  });

  it("runs fully keyless — no OPENAI_API_KEY, no src/openai.js import", async () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    const packSourcePath = fileURLToPath(new URL("./pack.ts", import.meta.url));
    const source = await fs.readFile(packSourcePath, "utf-8");
    expect(source).not.toMatch(/openai\.js/);

    const config = mockConfig();
    await seedDirection(config, "default");
    await writeDirectionVersions(config, "direction-a", [V1]);

    const runAssetPack = await loadRunAssetPack();
    const result = await runAssetPack({ cwd: tmpDir, directionId: "direction-a" });
    expect(result.directionId).toBe("direction-a");
  });
});
