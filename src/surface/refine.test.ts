import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";
import { CommandError } from "../errors.js";
import { surfaceManifestPath } from "../config.js";
import { createSurfaceCore } from "./store.js";
import type { SlotKind, SurfaceSlot } from "./schema.js";
import type { ScanCandidate, ScanProposal } from "./scan.js";
import { runSurfaceScan, candidateSignature } from "./scan.js";
import { runSurfaceRefine, mergeRefinement, isValueDerivedId } from "./refine.js";
import type { SurfaceCandidateSuggestion } from "../openai.js";
import { runSurface } from "../commands/surface.js";
import { getCommand } from "../mcp/registry.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return { ...actual, classifySurfaceCandidates: vi.fn() };
});

import { classifySurfaceCandidates } from "../openai.js";

// A fake Playwright — the scan-wiring tests exercise runSurfaceScan without a
// real browser (network-free, key-free, browser-free).
const { mockLaunch, mockNewPage, mockClose, mockGoto, mockEvaluate, mockScreenshot } = vi.hoisted(
  () => ({
    mockLaunch: vi.fn(),
    mockNewPage: vi.fn(),
    mockClose: vi.fn(),
    mockGoto: vi.fn(),
    mockEvaluate: vi.fn(),
    mockScreenshot: vi.fn(),
  }),
);

vi.mock("playwright", () => ({
  chromium: { launch: mockLaunch },
}));

// A fake `openai` package client — used only by the WS-04 Test 1 prompt-content
// proof, which drives the REAL `classifySurfaceCandidates` (via
// `vi.importActual`) and must intercept the request the real seam sends to
// assert on the captured `system` prompt (mocking `../openai.js`'s exports
// cannot intercept a same-module internal call to `visionJson`).
const { chatCreate } = vi.hoisted(() => ({ chatCreate: vi.fn() }));

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: chatCreate } };
  }
  return { default: MockOpenAI };
});

const SVG_SOURCE = '<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>';
const ICON_SIGNATURE = candidateSignature("icon", SVG_SOURCE);

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Refine Test", type: "prototype", framework: "next" },
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
    store: { driver: "file" },
  };
}

function makeSlot(id: string, kind: SlotKind, overrides?: Partial<SurfaceSlot>): SurfaceSlot {
  return {
    id,
    kind,
    description: `Description for ${id}`,
    criticality: "required",
    origin: "authored",
    attributions: [],
    ...overrides,
  };
}

function candidate(signature: string, overrides: Partial<ScanCandidate> = {}): ScanCandidate {
  return {
    signature,
    kind: "icon",
    proposedId: `icon.unnamed-${signature}`,
    cropFile: `brand/generated/surface-scan/crops/${signature}.png`,
    hints: {},
    ...overrides,
  };
}

async function writeCrop(cwd: string, relPath: string): Promise<void> {
  const abs = path.join(cwd, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
}

function proposalPathFor(config: KeyartConfig): string {
  return path.join(config.brand.root, "generated", "surface-scan", "proposal.json");
}

async function writeProposal(config: KeyartConfig, proposal: ScanProposal): Promise<void> {
  const p = proposalPathFor(config);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(proposal, null, 2), "utf-8");
}

async function readProposal(config: KeyartConfig): Promise<ScanProposal> {
  return JSON.parse(await fs.readFile(proposalPathFor(config), "utf-8")) as ScanProposal;
}

function baseProposal(candidates: ScanCandidate[]): ScanProposal {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    urls: ["http://example.test"],
    candidates,
    rejectedSignatures: [],
    migrations: [],
    skipped: [],
  };
}

let tmpDir: string;
let config: KeyartConfig;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-surface-refine-"));
  delete process.env.OPENAI_API_KEY;
  config = buildTestConfig(tmpDir);
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(config);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// mergeRefinement — pure
// ===========================================================================

describe("mergeRefinement — pure merge", () => {
  it("merges enrichment and marks per-field flags (Test 1, SC-07)", () => {
    const proposal = baseProposal([
      candidate("sig1", { proposedId: "icon.unnamed-1" }),
      candidate("sig2", { proposedId: "icon.unnamed-2" }),
      candidate("sig3", { kind: "color-role", proposedId: "color.unnamed-1" }),
    ]);
    const suggestions: SurfaceCandidateSuggestion[] = [
      {
        signature: "sig1",
        suggestedId: "icon.restaurant",
        description: "A fork-and-knife restaurant glyph",
        tone: "friendly",
      },
      { signature: "sig3", kind: "color-role", description: "warm accent" },
    ];

    const outcome = mergeRefinement(proposal, suggestions, {
      takenSlotIds: new Set(),
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(outcome.refinedCount).toBe(2);

    const c1 = outcome.proposal.candidates.find((c) => c.signature === "sig1")!;
    expect(c1.proposedId).toBe("icon.restaurant");
    expect(c1.description).toBe("A fork-and-knife restaurant glyph");
    expect(c1.context?.tone).toBe("friendly");
    expect(c1.refined).toEqual({ proposedId: true, description: true });

    const c3 = outcome.proposal.candidates.find((c) => c.signature === "sig3")!;
    expect(c3.refined).toEqual({ kind: true, description: true });

    const c2 = outcome.proposal.candidates.find((c) => c.signature === "sig2")!;
    expect(c2.refined).toBeUndefined();

    expect(outcome.proposal.refinedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(outcome.proposal.candidates.map((c) => c.signature)).toEqual(["sig1", "sig2", "sig3"]);
    expect(proposal.candidates.find((c) => c.signature === "sig1")!.proposedId).toBe(
      "icon.unnamed-1",
    ); // input proposal untouched (pure)
  });

  it("drops invalid suggestions with recorded reasons, never mangles (Test 2)", () => {
    const proposal = baseProposal([
      candidate("bad-fmt", { proposedId: "icon.unnamed-bad-fmt" }),
      candidate("exist-collide", { proposedId: "icon.unnamed-exist" }),
      candidate("retired-collide", { proposedId: "icon.unnamed-retired" }),
      candidate("dup-a", { proposedId: "icon.unnamed-dup-a" }),
      candidate("dup-b", { proposedId: "icon.unnamed-dup-b" }),
      candidate("bad-kind", { proposedId: "icon.unnamed-bad-kind" }),
    ]);
    const suggestions: SurfaceCandidateSuggestion[] = [
      { signature: "bad-fmt", suggestedId: "Icon Restaurant!" },
      { signature: "exist-collide", suggestedId: "icon.taken" },
      { signature: "retired-collide", suggestedId: "icon.retired" },
      { signature: "dup-a", suggestedId: "icon.dup-target" },
      { signature: "dup-b", suggestedId: "icon.dup-target" },
      { signature: "bad-kind", kind: "graphic" },
    ];

    const outcome = mergeRefinement(proposal, suggestions, {
      takenSlotIds: new Set(["icon.taken", "icon.retired"]),
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(outcome.droppedSuggestions).toHaveLength(5);
    const reasonFor = (sig: string) =>
      outcome.droppedSuggestions.find((d) => d.signature === sig)?.reason;

    expect(reasonFor("bad-fmt")).toBe("invalid id format");
    expect(reasonFor("exist-collide")).toBe("collides with existing manifest slot icon.taken");
    expect(reasonFor("retired-collide")).toBe(
      "collides with existing manifest slot icon.retired",
    );
    expect(reasonFor("dup-b")).toBe("duplicate of another candidate's id");
    expect(reasonFor("bad-kind")).toBe("unknown kind");

    const byId = (sig: string) => outcome.proposal.candidates.find((c) => c.signature === sig)!;
    expect(byId("bad-fmt").proposedId).toBe("icon.unnamed-bad-fmt");
    expect(byId("bad-fmt").refined).toBeUndefined();
    expect(byId("exist-collide").proposedId).toBe("icon.unnamed-exist");
    expect(byId("retired-collide").proposedId).toBe("icon.unnamed-retired");
    expect(byId("bad-kind").kind).toBe("icon");
    expect(byId("bad-kind").refined).toBeUndefined();

    // Duplicate: first candidate order wins.
    expect(byId("dup-a").proposedId).toBe("icon.dup-target");
    expect(byId("dup-a").refined).toEqual({ proposedId: true });
    expect(byId("dup-b").proposedId).toBe("icon.unnamed-dup-b");
    expect(byId("dup-b").refined).toBeUndefined();

    expect(outcome.proposal.refineNotes).toHaveLength(5);
    expect(outcome.proposal.refineNotes).toContain(
      'dropped suggestedId "Icon Restaurant!" for bad-fmt: invalid id format',
    );
    expect(outcome.proposal.refineNotes).toContain(
      'dropped kind "graphic" for bad-kind: unknown kind',
    );
  });
});

// ===========================================================================
// runSurfaceRefine
// ===========================================================================

describe("runSurfaceRefine", () => {
  it("never touches the manifest (Test 3, SC-07)", async () => {
    await createSurfaceCore(tmpDir, config).setManifest([makeSlot("icon.existing", "icon")]);
    const manifestPath = surfaceManifestPath(tmpDir, config);
    const before = await fs.readFile(manifestPath);

    const proposal = baseProposal([candidate("sig1")]);
    await writeProposal(config, proposal);
    await writeCrop(tmpDir, proposal.candidates[0].cropFile);

    process.env.OPENAI_API_KEY = "test";
    vi.mocked(classifySurfaceCandidates).mockResolvedValue({
      candidates: [{ signature: "sig1", suggestedId: "icon.restaurant" }],
      dryRun: false,
    });

    const result = await runSurfaceRefine({ cwd: tmpDir });
    expect(result.dryRun).toBe(false);
    expect(result.refinedCount).toBe(1);

    const after = await fs.readFile(manifestPath);
    expect(after.equals(before)).toBe(true);
  });

  it("keyless ⇒ honest floor-only, no fabrication, no throw (Test 4, SC-07)", async () => {
    const actualOpenai = await vi.importActual<typeof import("../openai.js")>("../openai.js");
    vi.mocked(classifySurfaceCandidates).mockImplementation(actualOpenai.classifySurfaceCandidates);

    const proposal = baseProposal([candidate("sig1")]);
    await writeProposal(config, proposal);
    await writeCrop(tmpDir, proposal.candidates[0].cropFile);

    const before = await readProposal(config);

    const result = await runSurfaceRefine({ cwd: tmpDir });

    expect(result.dryRun).toBe(true);
    expect(result.refinedCount).toBe(0);
    expect(result.filesWritten).toEqual([]);

    const after = await readProposal(config);
    expect(after).toEqual(before);
    expect(after.refinedAt).toBeUndefined();
    expect(after.candidates[0].proposedId).toBe("icon.unnamed-sig1");
  });

  it("adapter failure (skippedReason) degrades gracefully, proposal untouched (Test 5)", async () => {
    const proposal = baseProposal([candidate("sig1")]);
    await writeProposal(config, proposal);
    await writeCrop(tmpDir, proposal.candidates[0].cropFile);
    const before = await readProposal(config);

    process.env.OPENAI_API_KEY = "test";
    vi.mocked(classifySurfaceCandidates).mockResolvedValue({
      candidates: [],
      dryRun: false,
      skippedReason: "boom",
    });

    const result = await runSurfaceRefine({ cwd: tmpDir });
    expect(result.dryRun).toBe(false);
    expect(result.skippedReason).toBe("boom");
    expect(result.filesWritten).toEqual([]);

    const after = await readProposal(config);
    expect(after).toEqual(before);
  });

  it("a rejecting adapter surfaces a failure, not an unhandled rejection (Test 5)", async () => {
    const proposal = baseProposal([candidate("sig1")]);
    await writeProposal(config, proposal);
    await writeCrop(tmpDir, proposal.candidates[0].cropFile);
    const before = await readProposal(config);

    process.env.OPENAI_API_KEY = "test";
    vi.mocked(classifySurfaceCandidates).mockRejectedValue(new Error("adapter exploded"));

    const result = await runSurfaceRefine({ cwd: tmpDir });
    expect(result.dryRun).toBe(false);
    expect(result.skippedReason).toBe("adapter exploded");

    const after = await readProposal(config);
    expect(after).toEqual(before);
  });

  it("re-refine upgrades the same proposal in place (Test 6)", async () => {
    const proposal = baseProposal([candidate("sig1"), candidate("sig2")]);
    await writeProposal(config, proposal);
    await writeCrop(tmpDir, proposal.candidates[0].cropFile);
    await writeCrop(tmpDir, proposal.candidates[1].cropFile);

    process.env.OPENAI_API_KEY = "test";
    vi.mocked(classifySurfaceCandidates).mockResolvedValueOnce({
      candidates: [{ signature: "sig1", suggestedId: "icon.okay-name" }],
      dryRun: false,
    });
    const first = await runSurfaceRefine({ cwd: tmpDir });
    expect(first.refinedCount).toBe(1);
    const afterFirst = await readProposal(config);
    expect(afterFirst.candidates[0].proposedId).toBe("icon.okay-name");
    expect(typeof afterFirst.refinedAt).toBe("string");

    vi.mocked(classifySurfaceCandidates).mockResolvedValueOnce({
      candidates: [
        { signature: "sig1", suggestedId: "icon.better-name" },
        { signature: "sig2", description: "a second candidate" },
      ],
      dryRun: false,
    });
    const second = await runSurfaceRefine({ cwd: tmpDir });
    expect(second.refinedCount).toBe(2);

    const afterSecond = await readProposal(config);
    expect(afterSecond.candidates[0].proposedId).toBe("icon.better-name");
    expect(afterSecond.candidates[1].description).toBe("a second candidate");
    expect(typeof afterSecond.refinedAt).toBe("string");
    expect(afterSecond.refineNotes).toEqual([]);

    // No duplicate proposal files.
    const scanDir = path.join(config.brand.root, "generated", "surface-scan");
    const entries = await fs.readdir(scanDir);
    expect(entries.filter((e) => e.endsWith(".json"))).toEqual(["proposal.json"]);
  });

  it("missing proposal ⇒ a helpful CommandError; a candidate with a missing crop is excluded (Test 7)", async () => {
    await expect(runSurfaceRefine({ cwd: tmpDir })).rejects.toThrow(CommandError);
    await expect(runSurfaceRefine({ cwd: tmpDir })).rejects.toThrow(/surface scan/);

    const proposal = baseProposal([candidate("has-crop"), candidate("missing-crop")]);
    await writeProposal(config, proposal);
    await writeCrop(tmpDir, "brand/generated/surface-scan/crops/has-crop.png");
    // "missing-crop"'s crop file is never written.

    process.env.OPENAI_API_KEY = "test";
    vi.mocked(classifySurfaceCandidates).mockResolvedValue({ candidates: [], dryRun: false });

    await runSurfaceRefine({ cwd: tmpDir });

    const sentCandidates = vi.mocked(classifySurfaceCandidates).mock.calls.at(-1)![0].candidates;
    expect(sentCandidates.map((c) => c.signature)).toEqual(["has-crop"]);
  });

  it("a key stored only in .env.local gates refinement ON (Test 11)", async () => {
    const proposal = baseProposal([candidate("sig1")]);
    await writeProposal(config, proposal);
    await writeCrop(tmpDir, proposal.candidates[0].cropFile);
    await fs.writeFile(path.join(tmpDir, ".env.local"), "OPENAI_API_KEY=from-dotenv\n", "utf-8");

    vi.mocked(classifySurfaceCandidates).mockResolvedValue({
      candidates: [{ signature: "sig1", suggestedId: "icon.dotenv-name" }],
      dryRun: false,
    });

    const result = await runSurfaceRefine({ cwd: tmpDir });
    expect(result.dryRun).toBe(false);
    expect(classifySurfaceCandidates).toHaveBeenCalled();

    delete process.env.OPENAI_API_KEY;
  });
});

// ===========================================================================
// runSurfaceScan wiring — no browser (playwright mocked)
// ===========================================================================

describe("runSurfaceScan wiring — auto-refine, --no-refine, ordering (Test 8)", () => {
  beforeEach(() => {
    mockLaunch.mockImplementation(async () => ({ newPage: mockNewPage, close: mockClose }));
    mockNewPage.mockImplementation(async () => ({
      goto: mockGoto,
      evaluate: mockEvaluate,
      screenshot: mockScreenshot,
    }));
    mockGoto.mockImplementation(async () => undefined);
    mockClose.mockImplementation(async () => undefined);
    mockEvaluate.mockImplementation(async () => ({
      elements: [
        {
          type: "svg",
          source: SVG_SOURCE,
          box: { x: 0, y: 0, width: 24, height: 24 },
          visible: true,
          hints: {},
        },
      ],
      colors: [],
      fontFamilies: [],
    }));
    mockScreenshot.mockImplementation(async (opts: { path: string }) => {
      await fs.mkdir(path.dirname(opts.path), { recursive: true });
      await fs.writeFile(opts.path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
  });

  it("(a) a fake key: the mocked seam is called once post-floor and the written proposal is refined", async () => {
    process.env.OPENAI_API_KEY = "test";
    vi.mocked(classifySurfaceCandidates).mockResolvedValue({
      candidates: [{ signature: ICON_SIGNATURE, suggestedId: "icon.restaurant" }],
      dryRun: false,
    });

    await runSurfaceScan({ cwd: tmpDir, urls: ["http://example.test"] });

    expect(classifySurfaceCandidates).toHaveBeenCalledTimes(1);
    const proposal = await readProposal(config);
    expect(proposal.candidates[0].proposedId).toBe("icon.restaurant");
    expect(proposal.candidates[0].refined).toEqual({ proposedId: true });
  });

  it("(b) --no-refine: the seam is never called, even with a key", async () => {
    process.env.OPENAI_API_KEY = "test";
    vi.mocked(classifySurfaceCandidates).mockResolvedValue({ candidates: [], dryRun: false });

    await runSurfaceScan({ cwd: tmpDir, urls: ["http://example.test"], noRefine: true });

    expect(classifySurfaceCandidates).not.toHaveBeenCalled();
    const proposal = await readProposal(config);
    expect(proposal.refinedAt).toBeUndefined();
  });

  it("(c) keyless: the seam is never called; the summary keeps the honest unrefined label", async () => {
    delete process.env.OPENAI_API_KEY;

    await runSurfaceScan({ cwd: tmpDir, urls: ["http://example.test"] });

    expect(classifySurfaceCandidates).not.toHaveBeenCalled();
    const proposal = await readProposal(config);
    expect(proposal.refinedAt).toBeUndefined();
    expect(proposal.candidates[0].proposedId).toBe("icon.unnamed-1");
  });

  it("(d) apply + a fake key: the merged manifest slot carries the REFINED id — refine ran before apply", async () => {
    process.env.OPENAI_API_KEY = "test";
    vi.mocked(classifySurfaceCandidates).mockResolvedValue({
      candidates: [{ signature: ICON_SIGNATURE, suggestedId: "icon.restaurant" }],
      dryRun: false,
    });

    const result = await runSurfaceScan({
      cwd: tmpDir,
      urls: ["http://example.test"],
      apply: true,
    });

    expect(result.applied?.slotIds).toEqual(["icon.restaurant"]);
    const manifest = await createSurfaceCore(tmpDir, config).read();
    expect(manifest!.slots.map((s) => s.id)).toEqual(["icon.restaurant"]);
  });
});

// ===========================================================================
// CLI form + registry (Test 10)
// ===========================================================================

describe("CLI form + registry (Test 10)", () => {
  it("`surface scan --refine-only` dispatches runSurfaceRefine via the registry", async () => {
    const proposal = baseProposal([candidate("sig1")]);
    await writeProposal(config, proposal);
    await writeCrop(tmpDir, proposal.candidates[0].cropFile);
    vi.mocked(classifySurfaceCandidates).mockResolvedValue({ candidates: [], dryRun: true });

    const surfaceMeta = getCommand("surface")!;
    const outcome = await surfaceMeta.run!({ cwd: tmpDir, input: ["scan", "--refine-only"] });

    expect(outcome.summary.toLowerCase()).toContain("unrefined");
  });

  it("--refine-only combined with a URL, --apply, or --no-refine ⇒ CommandError", async () => {
    await expect(
      runSurface(tmpDir, ["scan"], { apply: true, refineOnly: true }),
    ).rejects.toThrow(CommandError);
    await expect(
      runSurface(tmpDir, ["scan", "http://x"], { refineOnly: true }),
    ).rejects.toThrow(CommandError);
    await expect(
      runSurface(tmpDir, ["scan"], { noRefine: true, refineOnly: true }),
    ).rejects.toThrow(CommandError);
  });

  it("getCommand(\"surface\") flags include --no-refine/--refine-only; helpDoc mentions key-gating; no new registry command exists", () => {
    const surfaceMeta = getCommand("surface")!;
    const flagNames = surfaceMeta.flags.map((f) => f.name);
    expect(flagNames).toContain("--no-refine");
    expect(flagNames).toContain("--refine-only");
    expect(surfaceMeta.helpDoc).toContain("--refine-only");
    expect(surfaceMeta.helpDoc.toLowerCase()).toContain("key-gated");
    expect(getCommand("refine")).toBeUndefined();
  });
});

// ===========================================================================
// WS-04: role-not-value-naming
// ===========================================================================

describe("classifySurfaceCandidates — the ROLE-NAMING LAW prompt (Test 1, SC-06)", () => {
  it("states the law, keeps the crop-only description rule, resolves normally", async () => {
    const actualOpenai = await vi.importActual<typeof import("../openai.js")>("../openai.js");
    vi.mocked(classifySurfaceCandidates).mockImplementation(actualOpenai.classifySurfaceCandidates);

    process.env.OPENAI_API_KEY = "test";
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ candidates: [] }) } }],
    });

    const cropPath = path.join(tmpDir, "crop.png");
    await fs.writeFile(cropPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = await classifySurfaceCandidates({
      model: "gpt-5.5",
      candidates: [
        {
          signature: "sig1",
          kind: "color-role",
          cropPath,
          hints: {},
          contextNote: "observed color #2e7d32 on http://localhost:3000",
        },
      ],
      taxonomy: "icon | illustration | color-role | type-role | other",
    });

    expect(result.dryRun).toBe(false);
    expect(result.candidates).toEqual([]);

    expect(chatCreate).toHaveBeenCalledTimes(1);
    const messages = chatCreate.mock.calls[0][0].messages as { role: string; content: unknown }[];
    const system = messages[0].content as string;

    expect(system).toContain("ROLE-NAMING LAW");
    expect(system).toContain("never the VALUE");
    expect(system).toContain("color-role.status-late");
    expect(system).toContain("OMIT `suggestedId`");
    expect(system.toLowerCase()).toContain("never a naming source");
    expect(system).toContain("ONLY what the crop shows");
  });
});

describe("isValueDerivedId / the fourth drop-ladder rung (SC-06)", () => {
  it("drops color-word ids on color-role and type-role, keeps proposedId unchanged (Test 2)", () => {
    const proposal = baseProposal([
      candidate("c1", { kind: "color-role", proposedId: "color.unnamed-1" }),
      candidate("c2", { kind: "type-role", proposedId: "type.unnamed-1" }),
    ]);
    const suggestions: SurfaceCandidateSuggestion[] = [
      { signature: "c1", suggestedId: "color.brand-green" },
      { signature: "c2", suggestedId: "type-role.navy-caption" },
    ];

    const outcome = mergeRefinement(proposal, suggestions, {
      takenSlotIds: new Set(),
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(outcome.droppedSuggestions).toHaveLength(2);
    const c1 = outcome.proposal.candidates.find((c) => c.signature === "c1")!;
    const c2 = outcome.proposal.candidates.find((c) => c.signature === "c2")!;
    expect(c1.proposedId).toBe("color.unnamed-1");
    expect(c2.proposedId).toBe("type.unnamed-1");
    expect(c1.refined).toBeUndefined();
    expect(c2.refined).toBeUndefined();

    const reasonFor = (sig: string) =>
      outcome.droppedSuggestions.find((d) => d.signature === sig)?.reason;
    expect(reasonFor("c1")).toMatch(/^value-derived id \(color word "green"\)/);
    expect(reasonFor("c2")).toMatch(/color word "navy"/);
  });

  it("drops hex-ish and color-format-token ids; accepts hex-letter words with no digit (Test 3)", () => {
    const proposal = baseProposal([
      candidate("tint", { kind: "color-role", proposedId: "color.unnamed-1" }),
      candidate("f0f", { kind: "color-role", proposedId: "color.unnamed-2" }),
      candidate("rgbish", { kind: "color-role", proposedId: "color.unnamed-3" }),
      candidate("beef", { kind: "color-role", proposedId: "color.unnamed-4" }),
      candidate("cafe", { kind: "color-role", proposedId: "color.unnamed-5" }),
    ]);
    const suggestions: SurfaceCandidateSuggestion[] = [
      { signature: "tint", suggestedId: "color-role.tint-2e7d32" },
      { signature: "f0f", suggestedId: "color-role.f0f-badge" },
      { signature: "rgbish", suggestedId: "color-role.rgb-brandish" },
      { signature: "beef", suggestedId: "color-role.beef-grade" },
      { signature: "cafe", suggestedId: "color-role.cafe-hours" },
    ];

    const outcome = mergeRefinement(proposal, suggestions, {
      takenSlotIds: new Set(),
      now: "2026-01-02T00:00:00.000Z",
    });

    const reasonFor = (sig: string) =>
      outcome.droppedSuggestions.find((d) => d.signature === sig)?.reason;
    expect(reasonFor("tint")).toContain('hex-ish token "2e7d32"');
    expect(reasonFor("f0f")).toContain('hex-ish token "f0f"');
    expect(reasonFor("rgbish")).toContain('color-format token "rgb"');
    expect(outcome.droppedSuggestions).toHaveLength(3);

    const byId = (sig: string) => outcome.proposal.candidates.find((c) => c.signature === sig)!;
    expect(byId("beef").proposedId).toBe("color-role.beef-grade");
    expect(byId("beef").refined?.proposedId).toBe(true);
    expect(byId("cafe").proposedId).toBe("color-role.cafe-hours");
    expect(byId("cafe").refined?.proposedId).toBe(true);
  });

  it("drops catalog font-family and generic-family ids; handles generics precisely (Test 4)", () => {
    const proposal = baseProposal([
      candidate("t1", { kind: "type-role", proposedId: "type.unnamed-1" }),
      candidate("t2", { kind: "type-role", proposedId: "type.unnamed-2" }),
      candidate("t3", { kind: "type-role", proposedId: "type.unnamed-3" }),
      candidate("t4", { kind: "type-role", proposedId: "type.unnamed-4" }),
      candidate("t5", { kind: "type-role", proposedId: "type.unnamed-5" }),
    ]);
    const suggestions: SurfaceCandidateSuggestion[] = [
      { signature: "t1", suggestedId: "type-role.space-grotesk" },
      { signature: "t2", suggestedId: "type-role.inter-body" },
      { signature: "t3", suggestedId: "type-role.serif-quote" },
      { signature: "t4", suggestedId: "type-role.display-heading" },
      { signature: "t5", suggestedId: "type-role.sans-nav" },
    ];

    const outcome = mergeRefinement(proposal, suggestions, {
      takenSlotIds: new Set(),
      now: "2026-01-02T00:00:00.000Z",
    });

    const reasonFor = (sig: string) =>
      outcome.droppedSuggestions.find((d) => d.signature === sig)?.reason;
    expect(reasonFor("t1")).toContain('font family "Space Grotesk"');
    expect(reasonFor("t2")).toContain('font family "Inter"');
    expect(reasonFor("t3")).toContain('generic font family "serif"');
    expect(outcome.droppedSuggestions).toHaveLength(3);

    const byId = (sig: string) => outcome.proposal.candidates.find((c) => c.signature === sig)!;
    expect(byId("t4").proposedId).toBe("type-role.display-heading");
    expect(byId("t5").proposedId).toBe("type-role.sans-nav");
  });

  it("never judges icon/illustration ids (Test 5)", () => {
    const proposal = baseProposal([
      candidate("i1", { kind: "icon", proposedId: "icon.unnamed-1" }),
      candidate("i2", { kind: "illustration", proposedId: "illustration.unnamed-1" }),
      candidate("i3", { kind: "icon", proposedId: "icon.unnamed-2" }),
    ]);
    const suggestions: SurfaceCandidateSuggestion[] = [
      { signature: "i1", suggestedId: "icon.green-flag" },
      { signature: "i2", suggestedId: "illustration.blue-sky-empty-state" },
      { signature: "i3", suggestedId: "icon.space-grotesk-glyph" },
    ];

    const outcome = mergeRefinement(proposal, suggestions, {
      takenSlotIds: new Set(),
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(outcome.droppedSuggestions).toHaveLength(0);
    const byId = (sig: string) => outcome.proposal.candidates.find((c) => c.signature === sig)!;
    expect(byId("i1").proposedId).toBe("icon.green-flag");
    expect(byId("i1").refined?.proposedId).toBe(true);
    expect(byId("i2").proposedId).toBe("illustration.blue-sky-empty-state");
    expect(byId("i3").proposedId).toBe("icon.space-grotesk-glyph");

    expect(isValueDerivedId("icon.green-flag", "icon")).toBe(false);
    expect(isValueDerivedId("color-role.brand-green", "color-role")).toBe(true);
  });

  it("records the drop and keeps the candidate anonymous + triageable (Test 6)", () => {
    const proposal = baseProposal([
      candidate("sig1", { kind: "color-role", proposedId: "color.unnamed-1" }),
    ]);
    const suggestions: SurfaceCandidateSuggestion[] = [
      {
        signature: "sig1",
        suggestedId: "color.brand-green",
        description: "A saturated green swatch",
        tone: "vivid",
      },
    ];

    const outcome = mergeRefinement(proposal, suggestions, {
      takenSlotIds: new Set(),
      now: "2026-01-02T00:00:00.000Z",
    });

    const c1 = outcome.proposal.candidates[0];
    expect(c1.proposedId).toBe("color.unnamed-1");
    expect(c1.refined).toEqual({ description: true });
    expect(outcome.proposal.refineNotes).toContain(
      'dropped suggestedId "color.brand-green" for sig1: value-derived id (color word "green") — name the role, not the value',
    );
    expect(isValueDerivedId("color.unnamed-1", "color-role")).toBe(false);
  });

  it("judges the EFFECTIVE kind — closes the kind-correction bypass, both directions (Test 7b)", () => {
    const proposal = baseProposal([
      candidate("icon-to-color", { kind: "icon", proposedId: "icon.unnamed-1" }),
      candidate("color-to-icon", { kind: "color-role", proposedId: "color.unnamed-1" }),
    ]);
    const suggestions: SurfaceCandidateSuggestion[] = [
      { signature: "icon-to-color", suggestedId: "color-role.brand-green", kind: "color-role" },
      { signature: "color-to-icon", suggestedId: "icon.green-flag", kind: "icon" },
    ];

    const outcome = mergeRefinement(proposal, suggestions, {
      takenSlotIds: new Set(),
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(outcome.droppedSuggestions).toHaveLength(1);
    expect(outcome.droppedSuggestions[0]).toMatchObject({
      signature: "icon-to-color",
      field: "suggestedId",
    });
    expect(outcome.droppedSuggestions[0].reason).toContain('color word "green"');

    const c1 = outcome.proposal.candidates.find((c) => c.signature === "icon-to-color")!;
    expect(c1.proposedId).toBe("icon.unnamed-1");
    expect(c1.kind).toBe("color-role");
    expect(c1.refined?.proposedId).toBeUndefined();
    expect(c1.refined?.kind).toBe(true);

    // Converse: a color-role-floor candidate whose suggestion corrects the
    // kind to `icon` is NOT dropped — the effective kind is `icon`, and icon
    // ids are never judged.
    const c2 = outcome.proposal.candidates.find((c) => c.signature === "color-to-icon")!;
    expect(c2.proposedId).toBe("icon.green-flag");
    expect(c2.kind).toBe("icon");
    expect(c2.refined?.proposedId).toBe(true);
    expect(c2.refined?.kind).toBe(true);
  });

  it("determinism + purity: repeated calls agree, mergeRefinement never mutates its input (Test 9)", () => {
    const table: [string, SlotKind, boolean][] = [
      ["color-role.brand-green", "color-role", true],
      ["color-role.status-late", "color-role", false],
      ["type-role.navy-caption", "type-role", true],
      ["type-role.data-table", "type-role", false],
      ["color-role.tint-2e7d32", "color-role", true],
      ["color-role.f0f-badge", "color-role", true],
      ["color-role.rgb-brandish", "color-role", true],
      ["color-role.beef-grade", "color-role", false],
      ["color-role.cafe-hours", "color-role", false],
      ["type-role.space-grotesk", "type-role", true],
      ["type-role.inter-body", "type-role", true],
      ["type-role.serif-quote", "type-role", true],
      ["type-role.display-heading", "type-role", false],
      ["type-role.sans-nav", "type-role", false],
      ["icon.green-flag", "icon", false],
      ["illustration.blue-sky-empty-state", "illustration", false],
      ["icon.space-grotesk-glyph", "icon", false],
      ["color-role.gold-tier", "color-role", true],
      ["color-role.b2b-banner", "color-role", true],
      ["color.unnamed-1", "color-role", false],
    ];

    for (const [id, kind, expected] of table) {
      for (let i = 0; i < 100; i += 1) {
        expect(isValueDerivedId(id, kind)).toBe(expected);
      }
    }

    const proposal = baseProposal([
      candidate("sig1", { kind: "color-role", proposedId: "color.unnamed-1" }),
    ]);
    const frozenProposal = JSON.parse(JSON.stringify(proposal)) as ScanProposal;
    const suggestions: SurfaceCandidateSuggestion[] = [
      { signature: "sig1", suggestedId: "color.brand-green" },
    ];

    const outcomeA = mergeRefinement(proposal, suggestions, {
      takenSlotIds: new Set(),
      now: "2026-01-02T00:00:00.000Z",
    });
    const outcomeB = mergeRefinement(proposal, suggestions, {
      takenSlotIds: new Set(),
      now: "2026-01-02T00:00:00.000Z",
    });

    expect(outcomeA).toEqual(outcomeB);
    expect(proposal).toEqual(frozenProposal);
  });
});

describe("THE ENFORCEMENT PROOF — a model that ignores the law cannot reach the manifest (Test 7, SC-06)", () => {
  beforeEach(() => {
    mockLaunch.mockImplementation(async () => ({ newPage: mockNewPage, close: mockClose }));
    mockNewPage.mockImplementation(async () => ({
      goto: mockGoto,
      evaluate: mockEvaluate,
      screenshot: mockScreenshot,
    }));
    mockGoto.mockImplementation(async () => undefined);
    mockClose.mockImplementation(async () => undefined);
    mockEvaluate.mockImplementation(async () => ({
      elements: [
        {
          type: "svg",
          source: SVG_SOURCE,
          box: { x: 0, y: 0, width: 24, height: 24 },
          visible: true,
          hints: {},
        },
      ],
      colors: [{ value: "#2e7d32", count: 5, firstBox: { x: 0, y: 0, width: 10, height: 10 } }],
      fontFamilies: [],
    }));
    mockScreenshot.mockImplementation(async (opts: { path: string }) => {
      await fs.mkdir(path.dirname(opts.path), { recursive: true });
      await fs.writeFile(opts.path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    });
  });

  it("a defiantly value-derived suggestion never reaches brand/surface.yaml via --apply", async () => {
    process.env.OPENAI_API_KEY = "test";
    const COLOR_SIGNATURE = candidateSignature("color-role", "#2e7d32");
    vi.mocked(classifySurfaceCandidates).mockResolvedValue({
      candidates: [
        { signature: COLOR_SIGNATURE, suggestedId: "color.brand-green" },
        { signature: ICON_SIGNATURE, suggestedId: "icon.restaurant" },
      ],
      dryRun: false,
    });

    await runSurfaceScan({ cwd: tmpDir, urls: ["http://example.test"], apply: true });

    const manifest = await createSurfaceCore(tmpDir, config).read();
    const ids = manifest!.slots.map((s) => s.id);
    expect(ids).toContain("icon.restaurant");
    expect(ids).toContain("color.unnamed-1");
    expect(ids).not.toContain("color.brand-green");
    expect(ids.some((id) => /green/.test(id))).toBe(false);

    const proposal = await readProposal(config);
    expect(proposal.refineNotes?.some((n) => n.includes("color.brand-green"))).toBe(true);
  });
});
