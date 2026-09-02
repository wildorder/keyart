import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import type { ServerResponse } from "node:http";

// Mock loadConfig (tmp project) AND openai. Every other export of both modules
// keeps its real implementation — the openai fns default to `actual` (genuine
// dry-run without a key) and are overridden ONLY inside the biased-regenerate
// test, which needs `generateImage` as a call spy + a present key. This keeps the
// whole suite network-free and key-free (mirrors token-pipeline.test.ts).
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
import { directionsRoot } from "../config.js";
import { hasApiKey, generateImage } from "../openai.js";
import { readHead } from "../direction/store.js";
import type { KeyartConfig } from "../types.js";

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Visual Feedback ITest", type: "prototype", framework: "next" },
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

// --- fake connect req/res harness (mirrors serve-api.test.ts) ---------------

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

const LOCAL_HEADERS = { host: "127.0.0.1:4317" };
const EF = "/api/element-feedback";

/** A 1×1 PNG magic-byte prefix — enough for byte-matching + image detection. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

function buildMultipart(parts: {
  fields?: Record<string, string>;
  files?: { field: string; filename: string; contentType: string; content: Buffer }[];
}): { body: Buffer; contentType: string } {
  const boundary = "----keyartvfitestboundary4242";
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

let tmpDir: string;
let savedKey: string | undefined;
let handler: ConnectHandler;

/** Drives one multipart request through the element-feedback handler. */
async function driveFeedback(mp: { body: Buffer; contentType: string }): Promise<FakeRes> {
  const req = makeMultipartReq(mp);
  const res = makeRes();
  handler(
    req as unknown as Parameters<ConnectHandler>[0],
    res as unknown as ServerResponse,
    () => {
      // Non-POST would fall through; every request here is a POST that the
      // handler ends itself, so `next` must never fire.
      throw new Error("element-feedback handler unexpectedly called next()");
    },
  );
  await res._done;
  return res;
}

/** Overwrite a direction's scaffolded brief with searchable content. */
async function writeBrief(directionId: string, body: string): Promise<void> {
  const config = buildTestConfig(tmpDir);
  const briefPath = path.join(directionsRoot(tmpDir, config), directionId, "brief.md");
  await fs.writeFile(briefPath, body, "utf-8");
}

/** Absolute `directions/` dir for a direction under the tmp project. */
function directionsDir(directionId: string): string {
  return directionsRoot(tmpDir, buildTestConfig(tmpDir));
}

/** Absolute head-version folder of a direction. */
async function headVersionDir(directionId: string): Promise<string> {
  const dir = directionsDir(directionId);
  const head = (await readHead(dir, directionId)).id;
  return path.join(dir, directionId, "versions", head);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-vfpipe-"));
  // Genuinely dry-run / deterministic: no API key, no network. Save + restore so
  // a change never leaks into the ambient environment.
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
  // openai fns default to their real (dry-run) behavior; only the biased-
  // regenerate test overrides them. Reset each test so overrides never bleed.
  const actualOpenai = await vi.importActual<typeof import("../openai.js")>("../openai.js");
  vi.mocked(hasApiKey).mockImplementation(actualOpenai.hasApiKey);
  vi.mocked(generateImage).mockImplementation(actualOpenai.generateImage);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  handler = createElementFeedbackApi({ cwd: tmpDir });
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

describe("visual-feedback pipeline (end-to-end, no network / no key)", () => {
  it("discard → stored thumbnail (never a reference) + the negative reaches the next explore's composed image prompts", async () => {
    const config = buildTestConfig(tmpDir);
    await runDirection({ cwd: tmpDir, verb: "new", id: "alpha" });
    await writeBrief("alpha", "Alpha is a precision fintech analytics dashboard.");

    // A user draws a box, marks it DISCARD with a note, and the client posts the
    // crop blob. No model call anywhere on this path.
    const NOTE = "garish neon gradient";
    const discard = buildMultipart({
      fields: { directionId: "alpha", verb: "discard", note: NOTE },
      files: [{ field: "file", filename: "reject.png", contentType: "image/png", content: PNG_BYTES }],
    });
    const res = await driveFeedback(discard);
    expect(res.statusCode).toBe(201);

    // The discard is stored as a `feedback` entry's thumbnail on disk…
    const core = createDirectionCore(tmpDir, config);
    const thumbRel = "brand/directions/alpha/assets/feedback/reject.png";
    const onDisk = path.join(directionsRoot(tmpDir, config), "alpha", "assets", "feedback", "reject.png");
    expect(await fs.readFile(onDisk)).toEqual(PNG_BYTES);

    const feedback = (await core.memoryEntries("alpha")).filter((entry) => entry.kind === "feedback");
    expect(feedback).toHaveLength(1);
    expect(feedback[0].asset).toBe(thumbRel);
    expect(feedback[0].body).toContain(NOTE);

    // …and it is NEVER a positive reference on the direction (SC-05).
    const record = await core.get("alpha");
    expect(record.assets.some((a) => a.path === thumbRel)).toBe(false);
    expect(record.assets).toHaveLength(0);

    // A dry-run explore now composes the discard note into an AVOID block in
    // every generated image prompt (SC-06). No key ⇒ deterministic, no network.
    const run = await runExplore({ cwd: tmpDir, directionId: "alpha" });
    expect(run.dryRun).toBe(true);
    const directionId = run.directionIds[0];
    const verDir = await headVersionDir(directionId);

    for (const promptFile of ["style-tile-prompt.md", "homepage-mockup-prompt.md"]) {
      const prompt = await fs.readFile(path.join(verDir, promptFile), "utf-8");
      expect(prompt).toContain("AVOID (do not use):");
      expect(prompt).toContain(NOTE);
    }
  });

  it("keep → inspire AssetRef → biased regenerate is reference-conditioned on the kept crop (and never on a discard)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await runDirection({ cwd: tmpDir, verb: "new", id: "beta" });
    await writeBrief("beta", "Beta is a warm neighbourhood yoga studio.");

    // A DISCARD crop (words + thumbnail only) and a KEEP crop (a positive
    // inspire reference) on the same direction.
    const discardRes = await driveFeedback(
      buildMultipart({
        fields: { directionId: "beta", verb: "discard", note: "harsh clinical whitespace" },
        files: [{ field: "file", filename: "bad.png", contentType: "image/png", content: PNG_BYTES }],
      }),
    );
    expect(discardRes.statusCode).toBe(201);

    const keepRes = await driveFeedback(
      buildMultipart({
        fields: { directionId: "beta", verb: "keep", intent: "inspire" },
        files: [{ field: "file", filename: "good.png", contentType: "image/png", content: PNG_BYTES }],
      }),
    );
    expect(keepRes.statusCode).toBe(201);

    // The kept crop is an ordinary inspire AssetRef; the discard is not there.
    const keptRel = "brand/directions/beta/assets/good.png";
    const discardThumbRel = "brand/directions/beta/assets/feedback/bad.png";
    const record = await core.get("beta");
    expect(record.assets).toContainEqual({ kind: "image", path: keptRel, intent: "inspire" });
    expect(record.assets.some((a) => a.path === discardThumbRel)).toBe(false);

    // Flip to a "live" key + a generateImage spy. The aggregate-root explore
    // reads beta's own reference directly; generated siblings do not inherit it.
    vi.mocked(hasApiKey).mockReturnValue(true);
    vi.mocked(generateImage).mockResolvedValue({ written: true, dryRun: false });

    const run = await runExplore({ cwd: tmpDir, directionId: "beta" });
    expect(run.dryRun).toBe(false);

    // Biased regeneration is reference-conditioned on the kept crop (SC-07): the
    // kept crop's ABSOLUTE path is passed to generateImage, the discard thumbnail
    // is NEVER passed as a reference (SC-05).
    const keptAbs = path.resolve(tmpDir, keptRel);
    const discardAbs = path.resolve(tmpDir, discardThumbRel);
    expect(vi.mocked(generateImage).mock.calls.length).toBeGreaterThan(0);
    for (const [args] of vi.mocked(generateImage).mock.calls) {
      expect(args.referenceImagePaths).toContain(keptAbs);
      expect(args.referenceImagePaths).not.toContain(discardAbs);
    }
  });

  it("eyedropper hex → color-lock decision → a palette-engine lock in the next explore's assembled context", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await runDirection({ cwd: tmpDir, verb: "new", id: "gamma" });
    await writeBrief("gamma", "Gamma is a calm, trustworthy analytics product.");

    // A client-side eyedropper pick (no file, just a hex). No model call.
    const HEX = "#3366cc";
    const res = await driveFeedback(
      buildMultipart({ fields: { directionId: "gamma", verb: "keep", hex: HEX } }),
    );
    expect(res.statusCode).toBe(201);
    expect((res.json() as { hex?: string }).hex).toBe(HEX);
    // No positive AssetRef for a pure eyedropper keep.
    expect((await core.get("gamma")).assets).toHaveLength(0);

    // The hex persists as an attributed color-lock decision…
    const decisions = (await core.memoryEntries("gamma")).filter((entry) => entry.kind === "decision");
    expect(decisions.some((d) => d.body.includes(HEX))).toBe(true);

    // …and on the next explore it becomes a palette-engine lock, deterministically
    // and with no model, via the assemble-context → deriveLocksFromContext path
    // (SC-04). Dry-run explore uses placeholder tokens that ignore context locks,
    // so assert the lock-derivation path directly (mirrors token-pipeline.test.ts).
    const global = await createBrandCore(tmpDir, config).read();
    const memory = await core.memoryEntries("gamma");
    const block = renderContextBlock(
      assembleContext({
        brief: "Gamma is a calm, trustworthy analytics product.",
        global,
        memory: memory,
      }),
    );
    const locks = deriveLocksFromContext(block);
    expect(locks.some((l) => l.hex === HEX)).toBe(true);
  });

  it("isolation — a discard/keep/lock on direction A never appears in direction B's memory, assets, or locks", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);
    await runDirection({ cwd: tmpDir, verb: "new", id: "a" });
    await runDirection({ cwd: tmpDir, verb: "new", id: "b" });

    // Record every kind of element feedback on A.
    await driveFeedback(
      buildMultipart({
        fields: { directionId: "a", verb: "discard", note: "a-only-negative" },
        files: [{ field: "file", filename: "bad.png", contentType: "image/png", content: PNG_BYTES }],
      }),
    );
    await driveFeedback(
      buildMultipart({
        fields: { directionId: "a", verb: "keep", intent: "inspire" },
        files: [{ field: "file", filename: "good.png", contentType: "image/png", content: PNG_BYTES }],
      }),
    );
    await driveFeedback(
      buildMultipart({ fields: { directionId: "a", verb: "keep", hex: "#3366cc" } }),
    );

    // A carries all three; B carries none.
    expect((await core.memoryEntries("a")).length).toBeGreaterThan(0);
    expect(await core.memoryEntries("b")).toHaveLength(0);
    expect((await core.get("b")).assets).toHaveLength(0);

    // B's assembled context derives NO lock from A's eyedropper pick.
    const global = await createBrandCore(tmpDir, config).read();
    const blockB = renderContextBlock(
      assembleContext({
        brief: "B brief",
        global,
        memory: await core.memoryEntries("b"),
      }),
    );
    expect(deriveLocksFromContext(blockB).some((l) => l.hex === "#3366cc")).toBe(false);
  });
});
