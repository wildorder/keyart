import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";
import type { KeyartConfig } from "../types.js";

// Mock loadConfig (tmp project) AND openai. Every other export of both modules
// keeps its real implementation — the openai fns default to `actual` (genuine
// dry-run without a key). Mirrors visual-feedback-pipeline.test.ts.
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

import { createElementFeedbackApi, type ConnectHandler } from "../ui/server-api.js";
import { runDirection } from "../commands/direction.js";
import { runExplore } from "../commands/explore.js";
import { runRegenerateVisuals } from "../commands/regenerate-visuals.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import {
  assembleContext,
  renderContextBlock,
} from "../brand/assemble-context.js";
import { deriveLocksFromContext } from "../explore/token-intent.js";
import { dispatchCommand } from "../mcp/registry.js";
import { directionsRoot } from "../config.js";
import { hasApiKey, generateImage } from "../openai.js";
import { readHead } from "../direction/store.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const DISCARD_A = "garish neon gradient A";
const DIR_A_LOCK_HEX = "#3366cc";
const AGGREGATE_DECISION = "never use a fist-in-the-air icon";
const GLOBAL_RULE = "Never use stock-photo people";
/** ≤40 chars so formatNotes() never truncates it in MCP log output. */
const MCP_NOTE = "mcp-direction-a-only";
const LEGACY_ENTRY = "always breathe with generous margins";

const AUTHOR = "test-suite";
const SOURCE = "direction-memory-pipeline.test.ts";

/** 1×1 PNG magic-byte prefix — enough for byte-matching + image detection. */
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
]);
const LOCAL_HEADERS = { host: "127.0.0.1:4317" };
const EF = "/api/element-feedback";

// ── Config ────────────────────────────────────────────────────────────────────
function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: {
      name: "Direction Memory ITest",
      type: "prototype",
      framework: "next",
    },
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
      implementationBrief: path.join(
        cwd,
        "brand",
        "generated",
        "implementation-brief.md",
      ),
    },
  };
}

// ── Fake connect req/res harness (verbatim from visual-feedback-pipeline) ─────
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
  files?: {
    field: string;
    filename: string;
    contentType: string;
    content: Buffer;
  }[];
}): { body: Buffer; contentType: string } {
  const boundary = "----keyartdirmemboundary4242";
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

// ── Direction-version helpers (verbatim from visual-feedback-pipeline) ─────────
function directionsDir(cwd: string): string {
  return directionsRoot(cwd, buildTestConfig(cwd));
}

async function headVersionDir(
  cwd: string,
  directionId: string,
): Promise<string> {
  const dir = directionsDir(cwd);
  const head = (await readHead(dir, directionId)).id;
  return path.join(dir, directionId, "versions", head);
}

async function headPrompts(
  cwd: string,
  directionId: string,
): Promise<string> {
  const verDir = await headVersionDir(cwd, directionId);
  const parts: string[] = [];
  for (const f of ["style-tile-prompt.md", "homepage-mockup-prompt.md"]) {
    parts.push(await fs.readFile(path.join(verDir, f), "utf-8"));
  }
  return parts.join("\n\n");
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────
let tmpDir: string;
let savedKey: string | undefined;
let handler: ConnectHandler;
let dirA: string;
let dirB: string;

async function driveFeedback(
  mp: { body: Buffer; contentType: string },
): Promise<FakeRes> {
  const req = makeMultipartReq(mp);
  const res = makeRes();
  handler(
    req as unknown as Parameters<ConnectHandler>[0],
    res as unknown as ServerResponse,
    () => {
      throw new Error(
        "element-feedback handler unexpectedly called next()",
      );
    },
  );
  await res._done;
  return res;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-dirmem-"));
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

  const actualOpenai = await vi.importActual<typeof import("../openai.js")>(
    "../openai.js",
  );
  vi.mocked(hasApiKey).mockImplementation(actualOpenai.hasApiKey);
  vi.mocked(generateImage).mockImplementation(actualOpenai.generateImage);

  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  // Create both directions; give alpha a brief with searchable content.
  await runDirection({ cwd: tmpDir, verb: "new", id: "alpha" });
  await runDirection({ cwd: tmpDir, verb: "new", id: "echo" });
  const briefPath = path.join(
    directionsRoot(tmpDir, buildTestConfig(tmpDir)),
    "alpha",
    "brief.md",
  );
  await fs.writeFile(
    briefPath,
    "Alpha is a precision fintech analytics dashboard.",
    "utf-8",
  );

  // Dry-run divergent explore to mint dirA + dirB from alpha.
  const exploreRun = await runExplore({
    cwd: tmpDir,
    from: "alpha",
    count: 2,
  });
  expect(exploreRun.dryRun).toBe(true);
  expect(exploreRun.directionIds).toHaveLength(2);
  dirA = exploreRun.directionIds[0];
  dirB = exploreRun.directionIds[1];

  handler = createElementFeedbackApi({ cwd: tmpDir });

  // Author three direction-scoped gestures on dirA only.
  const discardRes = await driveFeedback(
    buildMultipart({
      fields: {
        directionId: dirA,
        verb: "discard",
        note: DISCARD_A,
      },
      files: [
        {
          field: "file",
          filename: "reject.png",
          contentType: "image/png",
          content: PNG_BYTES,
        },
      ],
    }),
  );
  expect(discardRes.statusCode).toBe(201);

  const keepRes = await driveFeedback(
    buildMultipart({
      fields: {
        directionId: dirA,
        verb: "keep",
        intent: "inspire",
      },
      files: [
        {
          field: "file",
          filename: "good.png",
          contentType: "image/png",
          content: PNG_BYTES,
        },
      ],
    }),
  );
  expect(keepRes.statusCode).toBe(201);

  const eyedropRes = await driveFeedback(
    buildMultipart({
      fields: {
        directionId: dirA,
        verb: "keep",
        hex: DIR_A_LOCK_HEX,
      },
    }),
  );
  expect(eyedropRes.statusCode).toBe(201);

  // Author an aggregate-scoped decision (no directionId — reaches every direction).
  const config = buildTestConfig(tmpDir);
  const core = createDirectionCore(tmpDir, config);
  await core.appendDecision("alpha", {
    body: AGGREGATE_DECISION,
    author: AUTHOR,
    source: SOURCE,
  });

  // Author a global hard rule (reaches every direction).
  const brand = createBrandCore(tmpDir, config);
  await brand.addRule({
    text: GLOBAL_RULE,
    severity: "hard",
    author: AUTHOR,
    source: SOURCE,
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = savedKey;
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────
describe("direction-memory pipeline (end-to-end, no network / no key)", () => {
  it("regenerate B — aggregate+global reach B; dirA's direction-scoped gestures do NOT (SC-05)", async () => {
    const regenB = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: dirB,
    });
    expect(regenB.dryRun).toBe(true);

    const promptsB = await headPrompts(tmpDir, dirB);

    // Aggregate-scoped decision + global hard rule reach B.
    expect(promptsB).toContain(GLOBAL_RULE);
    expect(promptsB).not.toContain(AGGREGATE_DECISION);

    // dirA-scoped gestures are strictly absent from B's prompts.
    expect(promptsB).not.toContain(DISCARD_A);
    expect(promptsB).not.toContain(DIR_A_LOCK_HEX);

    // dirA's kept crop is not among B's imageAssetPaths.
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    const alphaRecord = await core.get(dirA);
    const keptAsset = alphaRecord.assets.find(
      (a) => a.kind === "image",
    );
    expect(keptAsset).toBeDefined();
    const bRefs = await core.imageAssetPaths(dirB);
    expect(bRefs.some((r) => r.path === keptAsset!.path)).toBe(false);
  });

  it("regenerate A — dirA's gestures reach A's prompts; color-lock is a palette-engine lock for A not B (SC-05/SC-07)", async () => {
    // feedbackNote triggers auto-logged direction-scoped feedback (gesture path).
    const regenA = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: dirA,
      feedbackNote: "direction A test pass",
    });
    expect(regenA.dryRun).toBe(true);

    const promptsA = await headPrompts(tmpDir, dirA);

    // dirA's direction-scoped gestures reach A's prompts.
    expect(promptsA).toContain(DISCARD_A);
    expect(promptsA).toContain("AVOID (do not use):");
    expect(promptsA).toContain(DIR_A_LOCK_HEX);
    // Aggregate + global also reach A.
    expect(promptsA).toContain(GLOBAL_RULE);
    expect(promptsA).not.toContain(AGGREGATE_DECISION);

    // Color-lock derivation: A gets it, B does not.
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    const brand = createBrandCore(tmpDir, config);
    const global = await brand.read();
    const allMemory = await core.memoryEntries(dirA);

    const ctxA = assembleContext({
      brief: "",
      global,
      memory: allMemory,
    });
    const locksA = deriveLocksFromContext(renderContextBlock(ctxA));
    expect(locksA.some((l) => l.hex === DIR_A_LOCK_HEX)).toBe(true);

    const ctxB = assembleContext({
      brief: "",
      global,
      memory: await core.memoryEntries(dirB),
    });
    const locksB = deriveLocksFromContext(renderContextBlock(ctxB));
    expect(locksB.some((l) => l.hex === DIR_A_LOCK_HEX)).toBe(false);

    // Auto-logged regenerate feedback is direction-scoped to A (not aggregate-scoped).
    const dirAFeedback = (await core.memoryEntries(dirA)).filter((entry) => entry.kind === "feedback");
    const regenFeedback = dirAFeedback.find((e) => e.source === "regenerate");
    expect(regenFeedback).toBeDefined();
  });

  it("fresh explore C — aggregate+global only; no dirA direction-scoped signal bleeds in (SC-06)", async () => {
    // Positional explore writes v1 into the still-draft "alpha" itself — the
    // direction whose memory carries the aggregate-scoped decision.
    const exploreC = await runExplore({
      cwd: tmpDir,
      directionId: "alpha",
    });
    expect(exploreC.dryRun).toBe(true);
    const dirC = exploreC.directionIds[0];

    const promptsC = await headPrompts(tmpDir, dirC);

    // Aggregate + global reach C.
    expect(promptsC).toContain(GLOBAL_RULE);
    expect(promptsC).toContain(AGGREGATE_DECISION);

    // dirA's direction-scoped gestures are absent from C's prompts.
    expect(promptsC).not.toContain(DISCARD_A);
    expect(promptsC).not.toContain(DIR_A_LOCK_HEX);
  });

  it("MCP scoped write+read round-trip — direction-scoped feedback reaches dirA read; absent from dirB read (SC-09)", async () => {
    // Write: body via --body flag (not a positional — the MCP command reads flags["body"]).
    const writeRes = await dispatchCommand(
      {
        command: "direction",
        input: ["feedback", dirA, "--body", MCP_NOTE],
      },
      { defaultCwd: tmpDir },
    );
    expect(writeRes.isError).toBe(false);

    // Read with --direction dirA: aggregate-scoped + dirA-scoped → MCP_NOTE is present.
    const readA = await dispatchCommand(
      { command: "direction", input: ["memory", dirA] },
      { defaultCwd: tmpDir },
    );
    expect(readA.isError).toBe(false);
    expect(readA.text).toContain(MCP_NOTE);

    // Scope filter: --direction dirB returns aggregate-scoped + dirB-scoped only → MCP_NOTE absent.
    const readB = await dispatchCommand(
      { command: "direction", input: ["memory", dirB] },
      { defaultCwd: tmpDir },
    );
    expect(readB.isError).toBe(false);
    expect(readB.text).not.toContain(MCP_NOTE);

    // Verify on disk: entry is direction-scoped to A; not in aggregate scope.
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    const dirAEntries = await core.memoryEntries(dirA);
    expect(
      dirAEntries.some((e) => e.body === MCP_NOTE),
    ).toBe(true);
    const aggregateEntries = await core.memoryEntries("alpha");
    expect(aggregateEntries.some((e) => e.body === MCP_NOTE)).toBe(false);
  });

  it("legacy back-compat — aggregate-scoped entry (no directionId) reaches every direction (SC-11)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    const brand = createBrandCore(tmpDir, config);

    // Append an aggregate-scoped entry with no directionId (legacy write pattern).
    await core.appendDecision("alpha", {
      body: LEGACY_ENTRY,
      author: AUTHOR,
      source: SOURCE,
    });

    const global = await brand.read();
    const allMemory = await core.memoryEntries("alpha");

    // Assembling for dirA includes LEGACY_ENTRY (aggregate-scoped reaches every direction).
    const ctxA = assembleContext({
      brief: "",
      global,
      memory: allMemory,
    });
    expect(renderContextBlock(ctxA)).toContain(LEGACY_ENTRY);

    // Assembling for dirB also includes LEGACY_ENTRY (back-compat).
    const ctxB = assembleContext({
      brief: "",
      global,
      memory: allMemory,
    });
    expect(renderContextBlock(ctxB)).toContain(LEGACY_ENTRY);

    // scopeOf confirms the entry is aggregate-scoped.
    const legacyEntry = allMemory.find((e) => e.body === LEGACY_ENTRY);
    expect(legacyEntry).toBeDefined();
  });

  it("per-direction isolation — echo sees none of alpha's signals (SC-11)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    const brand = createBrandCore(tmpDir, config);

    // echo has no memory entries of any kind.
    const echoEntries = await core.memoryEntries("echo");
    expect(echoEntries).toHaveLength(0);

    // echo has no assets.
    const echoRecord = await core.get("echo");
    expect(echoRecord.assets).toHaveLength(0);

    // echo's assembled context has none of alpha's aggregate or direction-scoped signals.
    const global = await brand.read();
    const echoCtx = assembleContext({
      brief: "",
      global,
      memory: echoEntries,
    });
    const echoBlock = renderContextBlock(echoCtx);
    expect(echoBlock).not.toContain(DISCARD_A);
    expect(echoBlock).not.toContain(AGGREGATE_DECISION);
    // Global hard rules DO reach echo — that's expected, not a leak.
    expect(echoBlock).toContain(GLOBAL_RULE);
  });

  it("dry-run/keyless parity — no API key required, no throws across explore + regenerate + MCP (SC-11)", async () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();

    const regen = await runRegenerateVisuals({
      cwd: tmpDir,
      directionId: dirA,
    });
    expect(regen.dryRun).toBe(true);

    const explore = await runExplore({ cwd: tmpDir, directionId: "alpha" });
    expect(explore.dryRun).toBe(true);

    const res = await dispatchCommand(
      { command: "direction", input: ["memory", "alpha"] },
      { defaultCwd: tmpDir },
    );
    expect(res.isError).toBe(false);
  });
});
