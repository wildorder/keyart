import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";

// Mock loadConfig (tmp project) AND openai. Every other export keeps its real
// implementation — the openai fns default to `actual` (genuine dry-run without
// a key). Mirrors edit-memories-pipeline.test.ts / direction-memory-pipeline.test.ts.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});
vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return {
    ...actual,
    hasApiKey: vi.fn(actual.hasApiKey),
    generateImage: vi.fn(actual.generateImage),
  };
});

import { runDirection } from "../commands/direction.js";
import { runExplore } from "../commands/explore.js";
import { runApprove } from "../commands/approve.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { assembleContext } from "../brand/assemble-context.js";
import { dispatchCommand } from "../mcp/registry.js";
import { directionsRoot } from "../config.js";
import { hasApiKey, generateImage } from "../openai.js";
import { readHead } from "../direction/store.js";

import { runAssetExtract, runAssetRegenerate } from "../asset/extract.js";
import { runAssetPack } from "../asset/pack.js";
import { listAssetIds, readAssetIndex, readAssetVersion } from "../asset/asset-store.js";
import { isExtractedAssetRetired } from "../asset/schema.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const GLOBAL_RULE = "Never use stock-photo people";
const DISCARD_A = "garish neon gradient A";
const DISCARD_B = "washed-out pastel wash B";
const REMEMBER_TWEAK = "warmer ochre fur";
const AUTHOR = "test-suite";
const SOURCE = "asset-extraction-pipeline.test.ts";

// ── Config ────────────────────────────────────────────────────────────────────
function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Asset Extraction ITest", type: "prototype", framework: "next" },
    brand: {
      root: path.join(cwd, "brand"),
      references: path.join(cwd, "brand", "input", "references"),
      approved: path.join(cwd, "brand", "approved"),
      rejected: path.join(cwd, "brand", "rejected"),
    },
    models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
    outputs: {
      cursorRules: path.join(cwd, ".cursor", "rules", "keyart-brand.mdc"),
      cssVars: path.join(cwd, "brand", "generated", "brand.css"),
      implementationBrief: path.join(cwd, "brand", "generated", "implementation-brief.md"),
    },
  };
}

// ── Path helpers ──────────────────────────────────────────────────────────────
function directionDirOf(cwd: string, directionId: string): string {
  return path.join(directionsRoot(cwd, buildTestConfig(cwd)), directionId);
}

function directionsDirOf(cwd: string, directionId: string): string {
  return directionsRoot(cwd, buildTestConfig(cwd));
}

function assetVersionDir(
  cwd: string,
  directionId: string,
  assetId: string,
  versionId: string,
): string {
  return path.join(
    directionDirOf(cwd, directionId),
    "extracted-assets",
    assetId,
    "versions",
    versionId,
  );
}

async function assetPrompt(
  cwd: string,
  directionId: string,
  assetId: string,
  versionId: string,
): Promise<string> {
  return fs.readFile(
    path.join(assetVersionDir(cwd, directionId, assetId, versionId), "asset-prompt.md"),
    "utf-8",
  );
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Recursive { relativePath → Buffer } snapshot for byte-equality assertions. */
async function snapshotTree(root: string): Promise<Map<string, Buffer>> {
  const map = new Map<string, Buffer>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else {
        map.set(path.relative(root, abs).split(path.sep).join("/"), await fs.readFile(abs));
      }
    }
  }
  await walk(root);
  return map;
}

function expectSnapshotsEqual(a: Map<string, Buffer>, b: Map<string, Buffer>): void {
  expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
  for (const [key, buf] of a) {
    expect(b.get(key)?.equals(buf)).toBe(true);
  }
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
let tmpDir: string;
let savedKey: string | undefined;
let dirA: string;
let dirB: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-assetx-"));
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

  const actualOpenai = await vi.importActual<typeof import("../openai.js")>("../openai.js");
  vi.mocked(hasApiKey).mockImplementation(actualOpenai.hasApiKey);
  vi.mocked(generateImage).mockImplementation(actualOpenai.generateImage);

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  // Two directions: alpha (the focus) and echo (the per-direction-isolation witness).
  await runDirection({ cwd: tmpDir, verb: "new", id: "alpha" });
  await runDirection({ cwd: tmpDir, verb: "new", id: "echo" });
  const briefPath = path.join(directionsRoot(tmpDir, buildTestConfig(tmpDir)), "alpha", "brief.md");
  await fs.writeFile(briefPath, "Alpha is a precision fintech analytics dashboard.", "utf-8");

  // Dry-run divergent explore mints two directions from alpha: dirA (focus) + dirB (sibling).
  const exploreRun = await runExplore({ cwd: tmpDir, from: "alpha", count: 2 });
  expect(exploreRun.dryRun).toBe(true);
  expect(exploreRun.directionIds).toHaveLength(2);
  dirA = exploreRun.directionIds[0];
  dirB = exploreRun.directionIds[1];

  const config = buildTestConfig(tmpDir);
  const core = createDirectionCore(tmpDir, config);
  const brand = createBrandCore(tmpDir, config);

  // A global visual hard rule (reaches every direction as MUST).
  await brand.addRule({ text: GLOBAL_RULE, severity: "hard", author: AUTHOR, source: SOURCE });

  // Two direction-scoped visual discard notes — one per direction.
  await core.appendFeedback(dirA, {
    body: DISCARD_A,
    author: AUTHOR,
    source: SOURCE,
    channel: "visual",
    polarity: "avoid",
  });
  await core.appendFeedback(dirB, {
    body: DISCARD_B,
    author: AUTHOR,
    source: SOURCE,
    channel: "visual",
    polarity: "avoid",
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("asset-extraction pipeline (end-to-end, network-free / key-free)", () => {
  it("dry-run extract → v1 record + art-directed prompt, NO PNG (SC-03/SC-11)", async () => {
    const result = await runAssetExtract({
      cwd: tmpDir,
      directionId: dirA,
      describe: "the yak mascot",
      name: "Yak Mascot",
    });
    expect(result.dryRun).toBe(true);
    expect(result.assetId).toBeTruthy();
    expect(result.versionId).toBeTruthy();

    const directionDir = directionDirOf(tmpDir, dirA);
    const index = await readAssetIndex(directionDir, result.assetId);
    expect(index.directionId).toBe(dirA);
    expect(index.versions).toEqual([result.versionId]);
    expect(index.head).toBe(result.versionId);

    const version = await readAssetVersion(directionDir, result.assetId, result.versionId);
    expect(version.description).toBe("the yak mascot");
    expect(version.dryRun).toBe(true);
    expect(version.source.directionId).toBe(dirA);
    expect(version.source.image).toBe("styleTile");
    const dirAHead = await readHead(directionsDirOf(tmpDir, "alpha"), dirA);
    expect(version.source.versionId).toBe(dirAHead.id);

    const versionDir = assetVersionDir(tmpDir, dirA, result.assetId, result.versionId);
    expect(await pathExists(path.join(versionDir, "asset.png"))).toBe(false);
    expect(await pathExists(path.join(versionDir, "asset-prompt.md"))).toBe(true);

    const prompt = await assetPrompt(tmpDir, dirA, result.assetId, result.versionId);
    expect(prompt).toContain("fully transparent background");
    expect(prompt).toContain("Render ONLY this element");
    expect(prompt).toContain("MUST (non-negotiable — always obey):");
    expect(prompt).toContain(GLOBAL_RULE);
    expect(prompt).toContain("AVOID (do not use):");
    expect(prompt).toContain(DISCARD_A);
  });

  it("tweak regenerate: v2 appended, v1 byte-untouched; memory only with --remember (SC-04/SC-11)", async () => {
    const extractResult = await runAssetExtract({
      cwd: tmpDir,
      directionId: dirA,
      describe: "the yak mascot",
      name: "Yak Mascot",
    });
    const directionDir = directionDirOf(tmpDir, dirA);
    const v1Dir = assetVersionDir(tmpDir, dirA, extractResult.assetId, extractResult.versionId);
    const v1SnapshotBefore = await snapshotTree(v1Dir);

    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    const memBefore = (await core.memoryEntries(dirA, { includeRetired: true })).length;

    const regen1 = await runAssetRegenerate({
      cwd: tmpDir,
      directionId: dirA,
      assetId: extractResult.assetId,
      tweak: "make it face left",
    });
    expect(regen1.dryRun).toBe(true);
    expect(regen1.versionId).not.toBe(extractResult.versionId);

    const indexAfter1 = await readAssetIndex(directionDir, extractResult.assetId);
    expect(indexAfter1.versions).toEqual([extractResult.versionId, regen1.versionId]);
    expect(indexAfter1.head).toBe(regen1.versionId);

    const v2 = await readAssetVersion(directionDir, extractResult.assetId, regen1.versionId);
    expect(v2.producedBy).toContain("make it face left");

    const v1SnapshotAfter = await snapshotTree(v1Dir);
    expectSnapshotsEqual(v1SnapshotBefore, v1SnapshotAfter);

    const memAfter1 = (await core.memoryEntries(dirA, { includeRetired: true })).length;
    expect(memAfter1).toBe(memBefore); // asset-local by default — zero memory writes

    const regen2 = await runAssetRegenerate({
      cwd: tmpDir,
      directionId: dirA,
      assetId: extractResult.assetId,
      tweak: REMEMBER_TWEAK,
      remember: true,
    });
    expect(regen2.dryRun).toBe(true);

    const memAfter2 = await core.memoryEntries(dirA, { includeRetired: true });
    expect(memAfter2.length).toBe(memBefore + 1); // exactly ONE new entry
    const remembered = memAfter2.find((e) => e.body.includes(REMEMBER_TWEAK));
    expect(remembered).toBeDefined();
    expect(remembered!.source).toBe("asset");

    const indexAfter2 = await readAssetIndex(directionDir, extractResult.assetId);
    expect(indexAfter2.head).toBe(regen2.versionId);
    expect(indexAfter2.versions).toHaveLength(3);
  });

  it("isolation: direction A's assets/notes never reach direction B — and vice versa (SC-05/SC-11)", async () => {
    const yak = await runAssetExtract({
      cwd: tmpDir,
      directionId: dirA,
      describe: "the yak mascot",
      name: "Yak Mascot",
    });
    const wave = await runAssetExtract({
      cwd: tmpDir,
      directionId: dirB,
      describe: "the wave pattern",
      name: "Wave Pattern",
    });

    const yakPrompt = await assetPrompt(tmpDir, dirA, yak.assetId, yak.versionId);
    const wavePrompt = await assetPrompt(tmpDir, dirB, wave.assetId, wave.versionId);

    expect(wavePrompt).toContain(DISCARD_B);
    expect(wavePrompt).toContain(GLOBAL_RULE);
    expect(wavePrompt).not.toContain(DISCARD_A);
    expect(yakPrompt).not.toContain(DISCARD_B);

    const listB = await dispatchCommand(
      { command: "asset", input: ["list", "--direction", dirB] },
      { defaultCwd: tmpDir },
    );
    expect(listB.isError).toBe(false);
    expect(listB.text).toContain(wave.assetId);
    expect(listB.text).not.toContain(yak.assetId);

    const listA = await dispatchCommand(
      { command: "asset", input: ["list", "--direction", dirA] },
      { defaultCwd: tmpDir },
    );
    expect(listA.isError).toBe(false);
    expect(listA.text).toContain(yak.assetId);
    expect(listA.text).not.toContain(wave.assetId);

    const packB = await runAssetPack({ cwd: tmpDir, directionId: dirB });
    const manifestB = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, "brand", "generated", "asset-pack", dirB, "pack-manifest.json"),
        "utf-8",
      ),
    );
    expect(packB.directionId).toBe(dirB);
    expect(manifestB.assets.map((a: { id: string }) => a.id)).toEqual([wave.assetId]);
    expect(manifestB.assets.some((a: { id: string }) => a.id === yak.assetId)).toBe(false);

    // The witness direction `echo` is untouched.
    const echoDirectionDir = directionDirOf(tmpDir, "echo");
    expect(await listAssetIds(echoDirectionDir)).toEqual([]);
    expect(await pathExists(path.join(echoDirectionDir, "extracted-assets"))).toBe(false);
    const echoCore = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    expect(await echoCore.memoryEntries("echo", { includeRetired: true })).toHaveLength(0);
  });

  it("retire: absent from default listing and next pack; on-disk record intact; idempotent (SC-11)", async () => {
    const yak = await runAssetExtract({
      cwd: tmpDir,
      directionId: dirA,
      describe: "the yak mascot",
      name: "Yak Mascot",
    });
    const directionDir = directionDirOf(tmpDir, dirA);
    const versionsDir = path.join(directionDir, "extracted-assets", yak.assetId, "versions");
    const snapshotBefore = await snapshotTree(versionsDir);

    const removeRes = await dispatchCommand(
      { command: "asset", input: ["remove", yak.assetId, "--direction", dirA] },
      { defaultCwd: tmpDir },
    );
    expect(removeRes.isError).toBe(false);

    const listRes = await dispatchCommand(
      { command: "asset", input: ["list", "--direction", dirA] },
      { defaultCwd: tmpDir },
    );
    expect(listRes.isError).toBe(false);
    expect(listRes.text).not.toContain(yak.assetId);

    const indexAfter = await readAssetIndex(directionDir, yak.assetId);
    expect(indexAfter.retiredAt).toBeDefined();
    expect(isExtractedAssetRetired(indexAfter)).toBe(true);

    const snapshotAfter = await snapshotTree(versionsDir);
    expectSnapshotsEqual(snapshotBefore, snapshotAfter); // non-destructive

    const packRes = await runAssetPack({ cwd: tmpDir, directionId: dirA });
    expect(packRes.assetsIncluded).not.toContain(yak.assetId);
    expect(packRes.assetsPending).not.toContain(yak.assetId);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, "brand", "generated", "asset-pack", dirA, "pack-manifest.json"),
        "utf-8",
      ),
    );
    expect(manifest.assets.some((a: { id: string }) => a.id === yak.assetId)).toBe(false);
    expect(
      await pathExists(
        path.join(tmpDir, "brand", "generated", "asset-pack", dirA, `${yak.assetId}.png`),
      ),
    ).toBe(false);

    // Second retire is idempotent — preserves the ORIGINAL retiredAt.
    const removeRes2 = await dispatchCommand(
      { command: "asset", input: ["remove", yak.assetId, "--direction", dirA] },
      { defaultCwd: tmpDir },
    );
    expect(removeRes2.isError).toBe(false);
    const indexAfter2 = await readAssetIndex(directionDir, yak.assetId);
    expect(indexAfter2.retiredAt).toBe(indexAfter.retiredAt);
  });

  it("the deterministic keyless pack: double-run byte-equality; DTCG == brand.css; pending honest (SC-06/SC-11)", async () => {
    const wave = await runAssetExtract({
      cwd: tmpDir,
      directionId: dirB,
      describe: "the wave pattern",
      name: "Wave Pattern",
    });

    const approveResult = await runApprove({ cwd: tmpDir, directionId: dirB });
    expect(approveResult.directionId).toBe(dirB);

    const pack1 = await runAssetPack({ cwd: tmpDir });
    expect(pack1.directionId).toBe(dirB); // resolves to the approved direction

    const packDir = path.join(tmpDir, "brand", "generated", "asset-pack", dirB);
    const snap1 = await snapshotTree(packDir);

    const pack2 = await runAssetPack({ cwd: tmpDir });
    expect(pack2.directionId).toBe(dirB);
    const snap2 = await snapshotTree(packDir);
    expectSnapshotsEqual(snap1, snap2); // double-run byte-equality, incl. both contact sheets

    const tokens = JSON.parse(await fs.readFile(path.join(packDir, "tokens.json"), "utf-8"));
    const brandCss = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "brand.css"),
      "utf-8",
    );
    function cssHex(cssVarSuffix: string): string {
      const match = new RegExp(`--brand-${cssVarSuffix}:\\s*(#[0-9a-fA-F]{6})`).exec(brandCss);
      expect(match).not.toBeNull();
      return match![1];
    }

    const roleToCssVar: Record<string, string> = {
      background: "background",
      surface: "surface",
      text: "text",
      muted: "text-muted",
      primary: "primary",
      secondary: "secondary",
    };
    for (const [tokenRole, cssVarSuffix] of Object.entries(roleToCssVar)) {
      const colorToken = tokens.color[tokenRole];
      expect(colorToken.$type).toBe("color");
      expect(colorToken.$value).toHaveProperty("colorSpace", "srgb");
      expect(colorToken.$value).toHaveProperty("components");
      expect(colorToken.$value).toHaveProperty("alpha", 1);
      expect(colorToken.$value.hex).toBe(cssHex(cssVarSuffix));
    }

    // The keyless wave asset — no PNG — is listed honestly, never fabricated.
    expect(pack1.assetsPending).toContain(wave.assetId);
    expect(pack1.assetsIncluded).not.toContain(wave.assetId);
    const manifest = JSON.parse(
      await fs.readFile(path.join(packDir, "pack-manifest.json"), "utf-8"),
    );
    const waveEntry = manifest.assets.find((a: { id: string }) => a.id === wave.assetId);
    expect(waveEntry.pending).toBe(true);
    expect(await pathExists(path.join(packDir, `${wave.assetId}.png`))).toBe(false);
  });

  it("MCP round-trip: keyart_brand-path dispatch drives extract/list/remove/pack keylessly (SC-07/SC-11)", async () => {
    const extractRes = await dispatchCommand(
      {
        command: "asset",
        input: [
          "extract",
          "--direction",
          dirA,
          "--describe",
          "the mountain badge",
          "--name",
          "Mountain Badge",
        ],
      },
      { defaultCwd: tmpDir },
    );
    expect(extractRes.isError).toBe(false);
    expect(extractRes.text.toLowerCase()).toContain("dry-run");

    const directionDir = directionDirOf(tmpDir, dirA);
    const ids = await listAssetIds(directionDir);
    const assetId = ids.find((id) => id.startsWith("mountain-badge"));
    expect(assetId).toBeDefined();
    const index = await readAssetIndex(directionDir, assetId!);
    const v1 = index.head;
    expect(
      await pathExists(path.join(directionDir, "extracted-assets", assetId!, "versions", v1, "asset.png")),
    ).toBe(false);
    expect(
      await pathExists(
        path.join(directionDir, "extracted-assets", assetId!, "versions", v1, "asset-prompt.md"),
      ),
    ).toBe(true);

    const listRes = await dispatchCommand(
      { command: "asset", input: ["list", "--direction", dirA] },
      { defaultCwd: tmpDir },
    );
    expect(listRes.isError).toBe(false);
    expect(listRes.text).toContain(assetId!);

    const removeRes = await dispatchCommand(
      { command: "asset", input: ["remove", assetId!, "--direction", dirA] },
      { defaultCwd: tmpDir },
    );
    expect(removeRes.isError).toBe(false);
    const indexAfterRemove = await readAssetIndex(directionDir, assetId!);
    expect(isExtractedAssetRetired(indexAfterRemove)).toBe(true);

    const packRes = await dispatchCommand(
      { command: "asset", input: ["pack", "--direction", dirA] },
      { defaultCwd: tmpDir },
    );
    expect(packRes.isError).toBe(false);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, "brand", "generated", "asset-pack", dirA, "pack-manifest.json"),
        "utf-8",
      ),
    );
    expect(manifest.assets.some((a: { id: string }) => a.id === assetId)).toBe(false);
  });

  it("per-direction isolation + keyless/dry-run parity as standing closers (SC-11/SC-12)", async () => {
    const yak = await runAssetExtract({
      cwd: tmpDir,
      directionId: dirA,
      describe: "the yak mascot",
      name: "Yak Mascot",
    });
    expect(yak.dryRun).toBe(true);

    const regen = await runAssetRegenerate({
      cwd: tmpDir,
      directionId: dirA,
      assetId: yak.assetId,
      tweak: "test tweak",
    });
    expect(regen.dryRun).toBe(true);

    const packRes = await runAssetPack({ cwd: tmpDir, directionId: dirA });
    expect(packRes.assetsIncluded).toHaveLength(0); // fully keyless — nothing has a real PNG

    const mcpRes = await dispatchCommand(
      { command: "asset", input: ["list", "--direction", dirA] },
      { defaultCwd: tmpDir },
    );
    expect(mcpRes.isError).toBe(false);

    expect(process.env.OPENAI_API_KEY).toBeUndefined();

    // echo's end-state: no extracted-assets tree, zero memory, no assets.
    const echoDirectionDir = directionDirOf(tmpDir, "echo");
    expect(await pathExists(path.join(echoDirectionDir, "extracted-assets"))).toBe(false);
    const echoCore = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    expect(await echoCore.memoryEntries("echo", { includeRetired: true })).toHaveLength(0);
    expect((await echoCore.get("echo")).assets).toHaveLength(0);

    // echo's assembled context carries none of alpha's asset/discard signals —
    // but DOES see the global hard rule (hard-rules-win, not a leak).
    const brand = createBrandCore(tmpDir, buildTestConfig(tmpDir));
    const global = await brand.read();
    const echoCtx = assembleContext({ brief: "", global, memory: [] });
    const echoCtxText = JSON.stringify(echoCtx);
    expect(echoCtxText).not.toContain("yak mascot");
    expect(echoCtxText).not.toContain(DISCARD_A);
    expect(echoCtxText).not.toContain(DISCARD_B);
    expect(echoCtx.hardRules.some((r) => r.text === GLOBAL_RULE)).toBe(true);
  });
});
