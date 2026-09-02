import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig, DirectionVersion } from "../types.js";

// Mock loadConfig only — every other config.js export (directionsRoot, storeDriver)
// keeps its real implementation so the cores resolve real on-disk paths under the
// tmp project. Network-free, key-free exercise of the full structured-brief loop.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

// Mock only the openai entry points the loop touches; everything else keeps its
// real (dry-run-safe) implementation. `hasApiKey`/`chatJson`/`generateImage` are
// overridden per-step to prove the SEEDING path without a real key or network.
vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return {
    ...actual,
    hasApiKey: vi.fn(actual.hasApiKey),
    chatJson: vi.fn(actual.chatJson),
    visionJson: vi.fn(actual.visionJson),
    generateImage: vi.fn(actual.generateImage),
    analyzeReferenceForTokens: vi.fn(actual.analyzeReferenceForTokens),
  };
});

import { runDirection } from "../commands/direction.js";
import { runExplore } from "../commands/explore.js";
import { runApprove } from "../commands/approve.js";
import { createDirectionCore } from "../direction/core.js";
import { directionsRoot } from "../config.js";
import { readHead, readDirection as readDirectionIndex } from "../direction/store.js";
import { dispatchCommand } from "../mcp/registry.js";
import { VersionConflictError } from "../store/versioned-store.js";
import { hasApiKey, chatJson, generateImage } from "../openai.js";

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Structured Brief ITest", type: "prototype", framework: "next" },
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

/** Any `#rgb`/`#rrggbb` hex token — the SC-06 leak detector. */
const HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/;

/** A minimal model-valid direction WITHOUT `tokenIntent`, so the brief's soft
 * seed becomes the raw engine intent (mirrors explore.test's SC-12 fixture). */
function validDirection(id: string): Record<string, unknown> {
  return {
    id,
    name: `Dir ${id}`,
    summary: "s",
    positioning: "p",
    character: { mood: "v" },
    homepageMockupPrompt: "hp",
    styleTilePrompt: "st",
    copyExamples: { headline: "h", subheadline: "sh", cta: "c" },
    usage: { rules: ["r1", "r2", "r3"], antiRules: ["a1", "a2"] },
  };
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-structbrief-"));
  // Genuinely dry-run / key-free: no API key, no network.
  delete process.env.OPENAI_API_KEY;
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
  // Silence the cores' progress logging during the test.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Read a direction's on-disk `brief.md` projection. */
async function readBriefMd(config: KeyartConfig, id: string): Promise<string> {
  return fs.readFile(
    path.join(directionsRoot(tmpDir, config), id, "brief.md"),
    "utf-8",
  );
}

/** Absolute `directions/` dir for a direction under the tmp project. */
function directionsDirOf(config: KeyartConfig): string {
  return directionsRoot(tmpDir, config);
}

/** The head DirectionVersion for a seeded direction. */
async function readHeadVersion(
  config: KeyartConfig,
  directionId: string,
): Promise<DirectionVersion> {
  return readHead(directionsDirOf(config), directionId);
}

/** Read a head version-folder file (e.g. `brief-snapshot.md`). */
async function readVersionFile(
  config: KeyartConfig,
  directionId: string,
  file: string,
): Promise<string> {
  const directionsDir = directionsDirOf(config);
  const head = await readHead(directionsDir, directionId);
  return fs.readFile(
    path.join(directionsDir, directionId, "versions", head.id, file),
    "utf-8",
  );
}

describe("structured-brief pipeline (create → write → render → explore → approve; no network / no key)", () => {
  it("proves the full loop, per-direction isolation, versioned writes, and hex→lock hygiene", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);

    // 1. Two sibling directions — `beta` is the untouched isolation witness.
    await runDirection({ cwd: tmpDir, verb: "new", id: "alpha" });
    await runDirection({ cwd: tmpDir, verb: "new", id: "beta" });
    const betaAtCreate = await core.get("beta");

    // ------------------------------------------------------------------
    // 2. FIELD-WRITE via core/CLI (the deterministic, keyless path).
    // ------------------------------------------------------------------
    const before = await core.get("alpha");
    await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "set",
      id: "alpha",
      field: "oneLiner",
      value: "A moody late-night jazz bar.",
    });
    await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "set",
      id: "alpha",
      field: "tone",
      value: "warm, intimate, confident",
    });
    await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "patch",
      id: "alpha",
      json: '{"audiences":[{"who":"night owls","need":"atmosphere"}]}',
    });

    const afterWrites = await core.get("alpha");
    // The record version bumped once per write (3 writes over the created record).
    expect(afterWrites.version).toBeGreaterThan(before.version);
    expect(afterWrites.brief.oneLiner).toBe("A moody late-night jazz bar.");
    expect(afterWrites.brief.tone).toEqual(["warm", "intimate", "confident"]);
    expect(afterWrites.brief.audiences[0].who).toBe("night owls");

    // brief.md IS the deterministic projection of the record (SC-07 chokepoint).
    expect(await readBriefMd(config, "alpha")).toBe(
      await core.getRenderedBrief("alpha"),
    );

    // ------------------------------------------------------------------
    // 3. SIMULATED EXTERNAL MCP HOST WRITE — a host agent dispatches a
    //    structured field write through the `keyart_brand` facade with NO
    //    key and NO Keyart model call (SC-04), then reads it back.
    // ------------------------------------------------------------------
    const setRes = await dispatchCommand(
      {
        command: "direction",
        input: ["brief", "set", "alpha", "colorIntent", "warm earthy"],
      },
      { defaultCwd: tmpDir },
    );
    expect(setRes.isError).toBe(false);
    expect(setRes.text).toContain("brand/directions/alpha/direction.yaml");
    expect(setRes.text).toContain("brand/directions/alpha/brief.md");

    const showRes = await dispatchCommand(
      { command: "direction", input: ["brief", "show", "alpha"] },
      { defaultCwd: tmpDir },
    );
    expect(showRes.isError).toBe(false);
    expect(showRes.text).toContain("warm earthy"); // the value round-trips
    expect((await core.getBrief("alpha")).colorIntent).toBe("warm earthy");

    // ------------------------------------------------------------------
    // 4. HEX ROUTES TO A LOCK, NOT THE BRIEF (SC-06). Drive the WS-03 mapper
    //    with `chatJson` mocked: a freeform ramble containing a hex yields a
    //    proposal whose field patch keeps colorIntent as soft WORDS and whose
    //    hexLocks carries the hex. `--apply` writes the words + routes the hex
    //    to a memory color-lock decision.
    // ------------------------------------------------------------------
    vi.mocked(chatJson).mockResolvedValue({
      data: { colorIntent: "warm earthy, grounded" } as never,
      dryRun: false,
    });
    await runDirection({
      cwd: tmpDir,
      verb: "brief",
      subverb: "map",
      id: "alpha",
      freeform: "keep it warm and earthy but ground it in a near-black #1a1a1a",
      apply: true,
    });

    // (a) No brief field value is a bare hex — the whole structured brief is clean.
    const alphaBrief = await core.getBrief("alpha");
    expect(HEX_RE.test(JSON.stringify(alphaBrief))).toBe(false);
    expect(alphaBrief.colorIntent).toBe("warm earthy, grounded");

    // (b) The hex became an attributed `Color locked:` memory DECISION, not prose.
    const decisions = (await core.memoryEntries("alpha")).filter((entry) => entry.kind === "decision");
    expect(decisions.some((e) => e.body === "Color locked: #1a1a1a")).toBe(true);

    // ------------------------------------------------------------------
    // 5. RENDER PROJECTION — a keyless dry-run explore freezes the projection
    //    as `brief-snapshot.md` (SC-07) and the projection carries no H1.
    // ------------------------------------------------------------------
    const dryRun = await runExplore({ cwd: tmpDir, directionId: "alpha" });
    expect(dryRun.dryRun).toBe(true);

    const projection = await core.getRenderedBrief("alpha");
    // The direction's head version froze the projection as its
    // `brief-snapshot.md` (SC-07).
    const snapshot = await readVersionFile(
      config,
      dryRun.directionIds[0],
      "brief-snapshot.md",
    );
    expect(snapshot).toBe(projection);
    // The projection uses `## `-level headings only — never a document H1.
    expect(/^# /m.test(projection)).toBe(false);

    // Keyless positional run wrote v1 into the draft itself (WS-16: it mints
    // nothing), with a full placeholder token set.
    expect(dryRun.directionIds).toEqual(["alpha"]);
    expect(dryRun.floorCount).toBe(0);
    for (const directionId of dryRun.directionIds) {
      const d = await readHeadVersion(config, directionId);
      expect(d.tokens?.palette).toHaveLength(6);
    }

    // ------------------------------------------------------------------
    // 6. EXPLORE CONSUMES IT + SEEDS (SC-12). The colorIntent bias only becomes
    //    observable on the token-stamping path, so drive one keyless-but-mocked
    //    live explore: `hasApiKey`→true, `chatJson`→a tokenIntent-less direction,
    //    `generateImage`→skip (no network). The brief's soft "warm earthy" seeds
    //    the palette engine's base hue, and the #1a1a1a memory lock reaches the
    //    palette verbatim — proving the intent seeded generation while the hex
    //    stayed a lock, never a brief spec.
    // ------------------------------------------------------------------
    // Positional explore is one-shot ("alpha" already carries its v1 — a second
    // positional run teaches `regenerate`), so the live token-stamping pass runs
    // against a fresh draft carrying the SAME structured brief and the SAME
    // memory color-lock the map step routed on alpha.
    await core.create({
      id: "alpha-live",
      name: "Alpha Live",
      brief: await core.getBrief("alpha"),
    });
    await core.recordColorLock("alpha-live", {
      hex: "#1a1a1a",
      author: "tim",
      source: "studio",
    });

    vi.mocked(hasApiKey).mockReturnValue(true);
    vi.mocked(chatJson).mockResolvedValue({
      data: { directions: [validDirection("direction-a")] } as never,
      dryRun: false,
    });
    vi.mocked(generateImage).mockResolvedValue({ written: false, dryRun: false });

    const seeded = await runExplore({ cwd: tmpDir, directionId: "alpha-live" });
    const seededDirectionId = seeded.directionIds[0];

    // The frozen snapshot is still the projection even on the live path (the
    // clone's brief fields are byte-identical, so its projection is too).
    expect(
      await readVersionFile(config, seededDirectionId, "brief-snapshot.md"),
    ).toBe(projection);

    const seededDir = await readHeadVersion(config, seededDirectionId);
    // Intent phrase → SEED: the base hue landed warm (not the cool ~220 default) —
    // a property that only holds when `briefIntentToSeed` ran.
    expect(seededDir.tokens?.provenance?.baseHue).toBeGreaterThanOrEqual(20);
    expect(seededDir.tokens?.provenance?.baseHue).toBeLessThanOrEqual(60);
    // The typed hex reached the palette as a verbatim lock (via the memory
    // decision → context block), NOT as a brief color field.
    const seededHexes = seededDir.tokens?.palette.map((p) => p.hex) ?? [];
    expect(seededHexes).toContain("#1a1a1a");

    // Restore the keyless (dry-run) default for the remaining steps.
    vi.mocked(hasApiKey).mockReturnValue(false);

    // ------------------------------------------------------------------
    // 7. APPROVE — set the global pointer + codify from a produced direction,
    //    keyless. Approving from the keyless run proves the whole loop needs no
    //    key end to end.
    // ------------------------------------------------------------------
    await runApprove({
      cwd: tmpDir,
      directionId: dryRun.directionIds[0],
      force: true,
    });
    expect((await core.get(dryRun.directionIds[0])).status).toBe("approved");

    // ------------------------------------------------------------------
    // 8. ISOLATION + VERSIONING. `beta` was never read or written by any
    //    `alpha` operation, and a stale-version write on alpha is rejected (409)
    //    unless forced.
    // ------------------------------------------------------------------
    const betaNow = await core.get("beta");
    expect(betaNow.version).toBe(betaAtCreate.version); // untouched record
    expect(betaNow.status).toBe("active");
    expect((await core.getBrief("beta")).colorIntent).toBeUndefined();
    expect(await core.memoryEntries("beta")).toHaveLength(0); // no sibling bleed

    // A stale write (an expectedVersion behind what is persisted) is a 409.
    const stale = await core.get("alpha");
    await core.setBriefFields("alpha", { voice: "hushed" }); // bumps the version
    await expect(
      core.setBriefFields(
        "alpha",
        { voice: "louder" },
        { expectedVersion: stale.version },
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);

    // …unless forced, which overwrites regardless of the stale expectation.
    const forced = await core.setBriefFields(
      "alpha",
      { voice: "louder" },
      { expectedVersion: stale.version, force: true },
    );
    expect(forced.brief.voice).toBe("louder");
  });
});
