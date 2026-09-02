import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { KeyartConfig } from "../types.js";

// Mock loadConfig (tmp project) AND openai. Every other export keeps its real
// implementation — the openai fns default to `actual` (genuine dry-run without
// a key). Mirrors direction-memory-pipeline.test.ts / art-direction-pipeline.test.ts.
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
    detectContradictionsLLM: vi.fn(actual.detectContradictionsLLM),
  };
});

import { createElementFeedbackApi, type ConnectHandler } from "../ui/server-api.js";
import { runDirection, runRule, runReconcileResolve } from "../commands/direction.js";
import { runExplore } from "../commands/explore.js";
import { runRegenerateVisuals } from "../commands/regenerate-visuals.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import {
  assembleContext,
  renderContextBlock,
  selectNegatives,
} from "../brand/assemble-context.js";
import { deriveLocksFromContext } from "../explore/token-intent.js";
import { isAssetRetired } from "../direction/schema.js";
import { dispatchCommand } from "../mcp/registry.js";
import { directionsRoot } from "../config.js";
import { hasApiKey, generateImage, detectContradictionsLLM } from "../openai.js";
import { readHead } from "../direction/store.js";
import { promoteEntryToGlobal } from "../brand/promote-to-global.js";
import type { Contradiction, ContradictionInput } from "../brand/conflict-guard.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const AGGREGATE_DECISION = "never use a fist-in-the-air icon";
const CORRECTED_BODY = "prefer a minimalist geometric icon instead";
const DISCARD = "garish neon gradient";
const LOCK_HEX = "#3366cc";
const GLOBAL_RULE_TEXT = "Never use stock-photo people";
const DIR_DECISION = "never use stock illustration people";

const AUTHOR = "test-suite";
const SOURCE = "edit-memories-pipeline.test.ts";

/** 1×1 PNG magic-byte prefix — enough for byte-matching + image detection. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const LOCAL_HEADERS = { host: "127.0.0.1:4317" };
const EF = "/api/element-feedback";

// ── Config ────────────────────────────────────────────────────────────────────
function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Edit Memories ITest", type: "prototype", framework: "next" },
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

// ── Fake connect req/res harness (verbatim from direction-memory-pipeline) ────
interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  ended: boolean;
  payload?: string | Buffer;
  json(): unknown;
  setHeader(k: string, v: string): void;
  end(payload?: string | Buffer): void;
  _done: Promise<void>;
}

type FakeReq = Readable & {
  method: string;
  url: string;
  originalUrl: string;
  headers: Record<string, string>;
};

function buildMultipart(parts: {
  fields?: Record<string, string>;
  files?: { field: string; filename: string; contentType: string; content: Buffer }[];
}): { body: Buffer; contentType: string } {
  const boundary = "----keyarteditmemboundary4242";
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(parts.fields ?? {})) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  for (const f of parts.files ?? []) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\n` +
          `Content-Type: ${f.contentType}\r\n\r\n`,
      ),
    );
    chunks.push(f.content);
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function makeMultipartReq(mp: { body: Buffer; contentType: string }): FakeReq {
  const req = Readable.from([mp.body]) as FakeReq;
  req.method = "POST";
  req.originalUrl = EF;
  req.url = EF;
  req.headers = { ...LOCAL_HEADERS, "content-type": mp.contentType };
  return req;
}

function makeRes(): FakeRes {
  let resolveDone: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const res: FakeRes = {
    statusCode: 200,
    headers: {},
    ended: false,
    payload: undefined,
    json() {
      return this.payload === undefined ? undefined : JSON.parse(String(this.payload));
    },
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(payload) {
      this.ended = true;
      this.payload = payload;
      resolveDone();
    },
    _done: done,
  };
  return res;
}

// ── Direction-version helpers (verbatim from direction-memory-pipeline) ──────
function directionsDir(cwd: string): string {
  return directionsRoot(cwd, buildTestConfig(cwd));
}

async function headVersionDir(cwd: string, directionId: string): Promise<string> {
  const dir = directionsDir(cwd);
  const head = (await readHead(dir, directionId)).id;
  return path.join(dir, directionId, "versions", head);
}

async function headPromptFiles(cwd: string, directionId: string): Promise<string[]> {
  const verDir = await headVersionDir(cwd, directionId);
  const parts: string[] = [];
  for (const f of ["style-tile-prompt.md", "homepage-mockup-prompt.md"]) {
    parts.push(await fs.readFile(path.join(verDir, f), "utf-8"));
  }
  return parts;
}

async function headPrompts(cwd: string, directionId: string): Promise<string> {
  return (await headPromptFiles(cwd, directionId)).join("\n\n");
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
let tmpDir: string;
let savedKey: string | undefined;
let dirA: string;
let dirB: string;

interface Handles {
  config: KeyartConfig;
  core: ReturnType<typeof createDirectionCore>;
  brand: ReturnType<typeof createBrandCore>;
}

function handles(): Handles {
  const config = buildTestConfig(tmpDir);
  return { config, core: createDirectionCore(tmpDir, config), brand: createBrandCore(tmpDir, config) };
}

async function driveFeedback(handler: ConnectHandler, mp: { body: Buffer; contentType: string }): Promise<FakeRes> {
  const req = makeMultipartReq(mp);
  const res = makeRes();
  handler(req as unknown as Parameters<ConnectHandler>[0], res as unknown as ServerResponse, () => {
    throw new Error("element-feedback handler unexpectedly called next()");
  });
  await res._done;
  return res;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-editmem-"));
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

  const actualOpenai = await vi.importActual<typeof import("../openai.js")>("../openai.js");
  vi.mocked(hasApiKey).mockImplementation(actualOpenai.hasApiKey);
  vi.mocked(generateImage).mockImplementation(actualOpenai.generateImage);
  vi.mocked(detectContradictionsLLM).mockImplementation(actualOpenai.detectContradictionsLLM);

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  await runDirection({ cwd: tmpDir, verb: "new", id: "alpha" });
  await runDirection({ cwd: tmpDir, verb: "new", id: "echo" });
  const briefPath = path.join(directionsRoot(tmpDir, buildTestConfig(tmpDir)), "alpha", "brief.md");
  await fs.writeFile(briefPath, "Alpha is a precision fintech analytics dashboard.", "utf-8");

  const exploreRun = await runExplore({ cwd: tmpDir, from: "alpha", count: 2 });
  expect(exploreRun.dryRun).toBe(true);
  expect(exploreRun.directionIds).toHaveLength(2);
  dirA = exploreRun.directionIds[0];
  dirB = exploreRun.directionIds[1];

  const handler = createElementFeedbackApi({ cwd: tmpDir });

  // A discard, a keep (inspire crop), and an eyedropper color-lock — all on dirA.
  const discardRes = await driveFeedback(handler, buildMultipart({
    fields: { directionId: dirA, verb: "discard", note: DISCARD },
    files: [{ field: "file", filename: "reject.png", contentType: "image/png", content: PNG_BYTES }],
  }));
  expect(discardRes.statusCode).toBe(201);

  const keepRes = await driveFeedback(handler, buildMultipart({
    fields: { directionId: dirA, verb: "keep", intent: "inspire" },
    files: [{ field: "file", filename: "good.png", contentType: "image/png", content: PNG_BYTES }],
  }));
  expect(keepRes.statusCode).toBe(201);

  const eyedropRes = await driveFeedback(handler, buildMultipart({
    fields: { directionId: dirA, verb: "keep", hex: LOCK_HEX },
  }));
  expect(eyedropRes.statusCode).toBe(201);

  // An aggregate-scoped decision (no directionId — reaches every direction).
  const { core, brand } = handles();
  await core.appendDecision("alpha", { body: AGGREGATE_DECISION, author: AUTHOR, source: SOURCE });

  // A global hard rule (reaches every direction).
  await brand.addRule({ text: GLOBAL_RULE_TEXT, severity: "hard", author: AUTHOR, source: SOURCE });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("edit-memories pipeline (end-to-end, network-free / key-free)", () => {
  it("EDIT supersedes: old absent from assembly, new present, append-only (SC-03)", async () => {
    const { core, brand } = handles();
    const decision = (await core.memoryEntries("alpha")).find(
      (e) => e.body === AGGREGATE_DECISION,
    )!;
    expect(decision).toBeDefined();
    const sizeBefore = (await core.memoryEntries("alpha", { includeRetired: true })).length;

    await core.editMemoryEntry("alpha", {
      entryId: decision.id,
      body: CORRECTED_BODY,
      author: AUTHOR,
      source: SOURCE,
    });

    const all = await core.memoryEntries("alpha", { includeRetired: true });
    expect(all.length).toBeGreaterThan(sizeBefore); // append-only: memory grew

    const original = all.find((e) => e.id === decision.id)!;
    expect(original.retiredAt).toBeDefined();
    expect(original.body).toBe(AGGREGATE_DECISION); // history unchanged
    const corrected = all.find((e) => e.body === CORRECTED_BODY)!;
    expect(corrected).toBeDefined();
    expect(original.supersededBy).toBe(corrected.id);

    const live = await core.memoryEntries("alpha");
    expect(live.some((e) => e.body === AGGREGATE_DECISION)).toBe(false);
    expect(live.some((e) => e.body === CORRECTED_BODY)).toBe(true);

    const global = await brand.read();
    const ctx = assembleContext({ brief: "", global, memory: live });
    const block = renderContextBlock(ctx);
    expect(block).not.toContain(AGGREGATE_DECISION);
    expect(block).toContain(CORRECTED_BODY);
  });

  it("DELETE/retire a KEPT CROP: absent from imageAssetPaths, non-destructive (SC-02)", async () => {
    const { core } = handles();
    const alphaRecord = await core.get(dirA);
    const keptAsset = alphaRecord.assets.find((a) => a.kind === "image")!;
    expect(keptAsset).toBeDefined();

    await core.retireAsset(dirA, { path: keptAsset.path, author: AUTHOR, source: SOURCE });

    const refsAfter = await core.imageAssetPaths(dirA);
    expect(refsAfter.some((r) => r.path === keptAsset.path)).toBe(false);

    const updated = await core.get(dirA);
    const updatedAsset = updated.assets.find((a) => a.path === keptAsset.path)!;
    expect(updatedAsset).toBeDefined(); // still exists — non-destructive
    expect(isAssetRetired(updatedAsset)).toBe(true);

    // `imageAssetPaths` is the exact set `runRegenerateVisuals` elevates as
    // generation references — proving it excludes the retired path proves the
    // next regenerate never conditions on it (kept crops are binary refs passed
    // to the image model, never embedded as text in the prompt files).
    const regen = await runRegenerateVisuals({ cwd: tmpDir, directionId: dirA });
    expect(regen.dryRun).toBe(true);
    const refsAfterRegen = await core.imageAssetPaths(dirA);
    expect(refsAfterRegen.some((r) => r.path === keptAsset.path)).toBe(false);
  });

  it("DELETE/retire a DISCARD entry: absent from negatives + AVOID tier + prompts (SC-02)", async () => {
    const { core, brand } = handles();
    const discardEntry = (await core.memoryEntries(dirA)).find(
      (e) => e.body === DISCARD,
    )!;
    expect(discardEntry).toBeDefined();

    await core.deleteMemoryEntry(dirA, { entryId: discardEntry.id, author: AUTHOR, source: SOURCE });

    const live = await core.memoryEntries(dirA);
    expect(selectNegatives(live)).not.toContain(DISCARD);

    const global = await brand.read();
    const assembled = assembleContext({ brief: "", global, memory: live });
    expect(assembled.visualDirectives.avoid).not.toContain(DISCARD);

    const regen = await runRegenerateVisuals({ cwd: tmpDir, directionId: dirA });
    expect(regen.dryRun).toBe(true);
    const prompts = await headPrompts(tmpDir, dirA);
    expect(prompts).not.toContain(DISCARD);

    const retired = (await core.memoryEntries(dirA, { includeRetired: true })).find(
      (e) => e.id === discardEntry.id,
    )!;
    expect(retired.retiredAt).toBeDefined();
  });

  it("DELETE/retire a COLOR-LOCK decision: absent from derived locks (SC-02)", async () => {
    const { core, brand } = handles();
    const lockEntry = (await core.memoryEntries(dirA)).find((e) =>
      e.body.includes(LOCK_HEX),
    )!;
    expect(lockEntry).toBeDefined();

    await core.deleteMemoryEntry(dirA, { entryId: lockEntry.id, author: AUTHOR, source: SOURCE });

    const global = await brand.read();
    const live = await core.memoryEntries(dirA);
    const ctx = assembleContext({ brief: "", global, memory: live });
    const locks = deriveLocksFromContext(renderContextBlock(ctx));
    expect(locks.some((l) => l.hex === LOCK_HEX)).toBe(false);
  });

  it("DELETE/retire a GLOBAL rule: absent from every direction, HARD needs force (SC-02/SC-05)", async () => {
    const { core, brand } = handles();
    const global = await brand.read();
    const rule = global.rules.find((r) => r.text === GLOBAL_RULE_TEXT)!;
    expect(rule).toBeDefined();
    expect(rule.severity).toBe("hard");

    await expect(brand.removeRule(rule.id)).rejects.toThrow();

    const next = await brand.removeRule(rule.id, { force: true });
    const retiredRule = next.rules.find((r) => r.id === rule.id)!;
    expect(retiredRule.retiredAt).toBeDefined();
    expect(retiredRule.text).toBe(GLOBAL_RULE_TEXT); // non-destructive

    for (const directionId of [dirA, dirB]) {
      const regen = await runRegenerateVisuals({ cwd: tmpDir, directionId });
      expect(regen.dryRun).toBe(true);
      const prompts = await headPrompts(tmpDir, directionId);
      expect(prompts).not.toContain(GLOBAL_RULE_TEXT);
    }

    const live = await core.memoryEntries("alpha");
    const ctx = assembleContext({ brief: "", global: next, memory: live });
    expect(renderContextBlock(ctx)).not.toContain(GLOBAL_RULE_TEXT);
  });

  it("PROMOTE direction→global: source retired, rule reaches every direction (SC-04)", async () => {
    const { core, brand } = handles();
    await core.appendDecision(dirA, {
      body: DIR_DECISION,
      author: AUTHOR,
      source: SOURCE,
      channel: "visual",
      polarity: "avoid",
    });
    const entry = (await core.memoryEntries(dirA)).find(
      (e) => e.body === DIR_DECISION,
    )!;
    expect(entry).toBeDefined();

    const result = await promoteEntryToGlobal(
      { cwd: tmpDir, config: buildTestConfig(tmpDir) },
      {
        directionId: dirA,
        entry: { id: entry.id, body: entry.body, channel: entry.channel, polarity: entry.polarity },
        author: AUTHOR,
        source: SOURCE,
        force: true,
      },
    );
    expect(result.ruleId).toBeDefined();

    // Source retired — no double-count.
    const live = await core.memoryEntries(dirA);
    expect(live.some((e) => e.body === DIR_DECISION)).toBe(false);
    const all = await core.memoryEntries(dirA, { includeRetired: true });
    expect(all.find((e) => e.id === entry.id)!.retiredAt).toBeDefined();

    const global = await brand.read();
    const rule = global.rules.find((r) => r.id === result.ruleId)!;
    expect(rule.text).toBe(DIR_DECISION);
    expect(rule.channel).toBe("visual");
    expect(rule.polarity).toBe("avoid");

    for (const directionId of [dirA, dirB]) {
      const regen = await runRegenerateVisuals({ cwd: tmpDir, directionId });
      expect(regen.dryRun).toBe(true);
      const files = await headPromptFiles(tmpDir, directionId);
      for (const prompt of files) {
        expect(prompt).toContain(DIR_DECISION);
        expect(countOccurrences(prompt, DIR_DECISION)).toBe(1); // not double-counted (source retired, not also present via the rule)
      }
    }
  });

  it("`rule remove` UNDOES the promote — reversible via delete, no demote (SC-05)", async () => {
    const { core, brand } = handles();
    await core.appendDecision(dirA, {
      body: DIR_DECISION,
      author: AUTHOR,
      source: SOURCE,
      channel: "visual",
      polarity: "avoid",
    });
    const entry = (await core.memoryEntries(dirA)).find(
      (e) => e.body === DIR_DECISION,
    )!;
    const result = await promoteEntryToGlobal(
      { cwd: tmpDir, config: buildTestConfig(tmpDir) },
      {
        directionId: dirA,
        entry: { id: entry.id, body: entry.body, channel: entry.channel, polarity: entry.polarity },
        author: AUTHOR,
        source: SOURCE,
        force: true,
      },
    );

    // Sanity: the promoted rule reaches dirB before the undo.
    await runRegenerateVisuals({ cwd: tmpDir, directionId: dirB });
    expect(await headPrompts(tmpDir, dirB)).toContain(DIR_DECISION);

    await brand.removeRule(result.ruleId, { force: true });

    for (const directionId of [dirA, dirB]) {
      const regen = await runRegenerateVisuals({ cwd: tmpDir, directionId });
      expect(regen.dryRun).toBe(true);
      const prompts = await headPrompts(tmpDir, directionId);
      expect(prompts).not.toContain(DIR_DECISION);
    }
  });

  it("MCP round-trip drives edit/promote/delete/rule-remove keylessly (SC-06)", async () => {
    const { core, brand } = handles();

    // EDIT via keyart_brand (keyless).
    const decision = (await core.memoryEntries("alpha")).find(
      (e) => e.body === AGGREGATE_DECISION,
    )!;
    const editRes = await dispatchCommand(
      { command: "direction", input: ["memory", "edit", "alpha", decision.id, "--body", CORRECTED_BODY] },
      { defaultCwd: tmpDir },
    );
    expect(editRes.isError).toBe(false);

    // PROMOTE a fresh direction-scoped decision to global.
    await core.appendDecision(dirB, {
      body: DIR_DECISION,
      author: AUTHOR,
      source: SOURCE,
      channel: "visual",
      polarity: "avoid",
    });
    const dirEntry = (await core.memoryEntries(dirB)).find(
      (e) => e.body === DIR_DECISION,
    )!;
    const promoteRes = await dispatchCommand(
      {
        command: "direction",
        input: ["memory", "promote", dirB, dirEntry.id, "--to", "global", "--severity", "guideline", "--force"],
      },
      { defaultCwd: tmpDir },
    );
    expect(promoteRes.isError).toBe(false);

    // DELETE the discard entry.
    const discardEntry = (await core.memoryEntries(dirA)).find(
      (e) => e.body === DISCARD,
    )!;
    const deleteRes = await dispatchCommand(
      { command: "direction", input: ["memory", "delete", dirA, discardEntry.id, "--reason", "no longer relevant"] },
      { defaultCwd: tmpDir },
    );
    expect(deleteRes.isError).toBe(false);

    // RULE REMOVE the hard global rule (force required).
    const globalBefore = await brand.read();
    const hardRule = globalBefore.rules.find((r) => r.text === GLOBAL_RULE_TEXT)!;
    const ruleRes = await dispatchCommand(
      { command: "rule", input: ["remove", hardRule.id, "--force"] },
      { defaultCwd: tmpDir },
    );
    expect(ruleRes.isError).toBe(false);

    // On-disk state matches every dispatched action.
    const all = await core.memoryEntries("alpha", { includeRetired: true });
    const editedOriginal = all.find((e) => e.id === decision.id)!;
    expect(editedOriginal.retiredAt).toBeDefined();
    expect(all.some((e) => e.body === CORRECTED_BODY)).toBe(true);
    expect((await core.memoryEntries(dirB, { includeRetired: true })).find((e) => e.id === dirEntry.id)!.retiredAt).toBeDefined();
    expect((await core.memoryEntries(dirA, { includeRetired: true })).find((e) => e.id === discardEntry.id)!.retiredAt).toBeDefined();

    const globalAfter = await brand.read();
    expect(globalAfter.rules.some((r) => r.text === DIR_DECISION && r.retiredAt === undefined)).toBe(true);
    expect(globalAfter.rules.find((r) => r.id === hardRule.id)!.retiredAt).toBeDefined();
  });

  it("legacy back-compat: a prior-reconcile-style retire still reads retired (SC-10)", async () => {
    const { core } = handles();
    const decision = (await core.memoryEntries("alpha")).find(
      (e) => e.body === AGGREGATE_DECISION,
    )!;
    // The pre-existing retire path (used directly by `direction reconcile`'s
    // "retire" resolution) — exercised standalone here, mirroring
    // art-direction-pipeline.test.ts's non-destructive-retire assertions.
    await core.retireMemoryEntry("alpha", {
      entryId: decision.id,
      author: AUTHOR,
      source: SOURCE,
      reason: "Legacy reconcile-style retire.",
    });

    // The new standalone lifecycle verbs run afterwards without disturbing it.
    const discardEntry = (await core.memoryEntries(dirA)).find(
      (e) => e.body === DISCARD,
    )!;
    await core.deleteMemoryEntry(dirA, { entryId: discardEntry.id, author: AUTHOR, source: SOURCE });

    const live = await core.memoryEntries("alpha");
    expect(live.some((e) => e.id === decision.id)).toBe(false); // still excluded
    const all = await core.memoryEntries("alpha", { includeRetired: true });
    const retired = all.find((e) => e.id === decision.id)!;
    expect(retired.retiredAt).toBeDefined();
    expect(retired.body).toBe(AGGREGATE_DECISION);

    // The no-op path (no lifecycle action) is byte-identical to today: echo's
    // memory.yaml has never been touched by any lifecycle verb.
    const echoEntries = await core.memoryEntries("echo", { includeRetired: true });
    expect(echoEntries).toHaveLength(0);
  });

  it("per-direction isolation: echo sees none of alpha's lifecycle actions (SC-09/SC-10)", async () => {
    const { core, brand } = handles();
    const alphaAsset = (await core.get(dirA)).assets.find((a) => a.kind === "image")!;
    await core.retireAsset(dirA, { path: alphaAsset.path, author: AUTHOR, source: SOURCE });
    const decision = (await core.memoryEntries("alpha")).find(
      (e) => e.body === AGGREGATE_DECISION,
    )!;
    await core.editMemoryEntry("alpha", { entryId: decision.id, body: CORRECTED_BODY, author: AUTHOR, source: SOURCE });

    const echoEntries = await core.memoryEntries("echo");
    expect(echoEntries).toHaveLength(0);
    const echoRecord = await core.get("echo");
    expect(echoRecord.assets).toHaveLength(0);

    const global = await brand.read();
    const echoCtx = assembleContext({ brief: "", global, memory: echoEntries });
    const echoBlock = renderContextBlock(echoCtx);
    expect(echoBlock).not.toContain(AGGREGATE_DECISION);
    expect(echoBlock).not.toContain(CORRECTED_BODY);
    // Global hard rules DO reach echo — expected (hard-rules-win), not a leak.
    expect(echoBlock).toContain(GLOBAL_RULE_TEXT);
  });

  it("reconcile continuity: `direction reconcile` retire still works over the shared core (SC-11)", async () => {
    const { core } = handles();
    await core.appendDecision("alpha", {
      body: "use a warm terracotta palette",
      author: AUTHOR,
      source: SOURCE,
      channel: "visual",
      polarity: "prefer",
    });
    await core.appendDecision("alpha", {
      body: "use a cool slate palette",
      author: AUTHOR,
      source: SOURCE,
      channel: "visual",
      polarity: "prefer",
    });
    const decisions = (await core.memoryEntries("alpha")).filter((entry) => entry.kind === "decision");
    const terracottaEntry = decisions.find((d) => d.body.includes("terracotta"))!;
    const slateEntry = decisions.find((d) => d.body.includes("slate"))!;

    const mockContradiction: Contradiction = {
      id: `memory-vs-memory::${terracottaEntry.id}::${slateEntry.id}`,
      kind: "memory-vs-memory",
      subject: { source: "memory", id: terracottaEntry.id, text: terracottaEntry.body },
      conflictsWith: { source: "memory", id: slateEntry.id, text: slateEntry.body },
      severity: "info",
      explanation: "Two palette decisions contradict each other: terracotta vs slate.",
      suggestions: ["retire"],
    };
    vi.mocked(detectContradictionsLLM).mockResolvedValue({
      contradictions: [mockContradiction],
      dryRun: false,
    });
    vi.mocked(hasApiKey).mockReturnValue(true);

    const config = buildTestConfig(tmpDir);
    const listDeps = {
      semantic: async (input: ContradictionInput) =>
        (
          await detectContradictionsLLM({
            model: config.models.text,
            liveInstruction: input.liveInstruction,
            hardRules: input.hardRules.map((r) => ({ id: r.id, text: r.text })),
            guidelines: input.guidelines.map((r) => ({ id: r.id, text: r.text })),
            memory: input.memory.map((m) => ({ id: m.id, kind: m.kind, body: m.body })),
          })
        ).contradictions,
    };
    const report = await core.listContradictions("alpha", listDeps);
    const contradiction = report.items.find((c) => c.kind === "memory-vs-memory")!;
    expect(contradiction).toBeDefined();

    const memBefore = await core.readMemory("alpha");
    const sizeBefore = memBefore.entries.length;

    // `runReconcileResolve` is the shared orchestrator behind BOTH the CLI
    // `reconcile` verb and the serve reconciliation-resolve endpoint — the CLI's
    // own list-then-resolve path only ever calls `listContradictions` with no
    // semantic deps (deterministic floor only), so a memory-vs-memory case (which
    // needs the semantic adapter) is driven at the orchestrator directly, exactly
    // as `art-direction-pipeline.test.ts` drives the underlying retire.
    const resolveResult = await runReconcileResolve({
      cwd: tmpDir,
      directionId: "alpha",
      contradiction,
      action: "retire",
      winner: "subject",
      expectedMemoryVersion: memBefore.version,
      author: AUTHOR,
      source: SOURCE,
    });
    expect(typeof resolveResult.memoryVersion).toBe("number");

    // Non-destructive + append-only. winner: "subject" (terracotta) ⇒ the
    // loser (`conflictsWith`, slate) is the one retired.
    const memAfter = await core.readMemory("alpha");
    expect(memAfter.entries.length).toBeGreaterThan(sizeBefore);
    const retired = memAfter.entries.find((e) => e.id === slateEntry.id)!;
    expect(retired.retiredAt).toBeDefined();
    expect(retired.body).toBe("use a cool slate palette");

    // Absent from the compiler; surviving (winning) decision remains.
    vi.mocked(hasApiKey).mockReturnValue(false);
    const live = await core.memoryEntries("alpha");
    expect(live.some((e) => e.body === "use a cool slate palette")).toBe(false);
    expect(live.some((e) => e.body === "use a warm terracotta palette")).toBe(true);
    expect(selectNegatives(live)).not.toContain("use a cool slate palette");
  });

  it("dry-run/keyless parity: the whole flow runs without an API key and never throws (SC-09)", async () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    const { core, brand } = handles();

    const decision = (await core.memoryEntries("alpha")).find(
      (e) => e.body === AGGREGATE_DECISION,
    )!;
    await core.editMemoryEntry("alpha", { entryId: decision.id, body: CORRECTED_BODY, author: AUTHOR, source: SOURCE });

    const regen = await runRegenerateVisuals({ cwd: tmpDir, directionId: dirA });
    expect(regen.dryRun).toBe(true);
    const explore = await runExplore({ cwd: tmpDir, directionId: "alpha" });
    expect(explore.dryRun).toBe(true);

    const res = await dispatchCommand(
      { command: "direction", input: ["memory", "alpha"] },
      { defaultCwd: tmpDir },
    );
    expect(res.isError).toBe(false);

    const global = await brand.read();
    const live = await core.memoryEntries(dirA);
    expect(() => assembleContext({ brief: "", global, memory: live })).not.toThrow();

    // `runRule` remains exercisable directly too (unused here beyond a smoke
    // check that the exported entry point still resolves keylessly).
    expect(typeof runRule).toBe("function");
  });
});
