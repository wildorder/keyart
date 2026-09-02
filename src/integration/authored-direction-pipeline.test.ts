import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";

// ── Mock loadConfig only — every other config.js export (directionsRoot,
//    storeDriver) keeps its real implementation so cores resolve real on-disk
//    paths under the tmp project. Network-free, key-free exercise of the full
//    authored-direction loop.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

// ── Mock the openai entry points. The create path is FULLY KEYLESS — no model
//    is ever called — but we stub these to guard against accidental network
//    calls and to enable the "never called" assertion below.
vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return {
    ...actual,
    hasApiKey: vi.fn(() => false),
    chatJson: vi.fn(actual.chatJson),
    visionJson: vi.fn(actual.visionJson),
    generateImage: vi.fn(actual.generateImage),
    analyzeReferenceForTokens: vi.fn(actual.analyzeReferenceForTokens),
  };
});

import { runDirection } from "../commands/direction.js";
import { runApprove } from "../commands/approve.js";
import { runCreateDirection } from "../commands/direction.js";
import { createDirectionCore } from "../direction/core.js";
import { directionsRoot, loadConfig } from "../config.js";
import { readHead, readDirection as readDirectionIndex } from "../direction/store.js";
import { resolveBrandVars } from "../approve/render-guides.js";
import { VersionConflictError } from "../store/versioned-store.js";
import { generateImage } from "../openai.js";
import { FONT_PAIRINGS } from "../brand/fonts.js";

/** Every catalog font family — none may appear in character/usage prose (SC-03). */
const CATALOG_FONTS = [
  ...new Set(FONT_PAIRINGS.flatMap((p) => [p.heading, p.body])),
];

/** Detects a `#rgb` or `#rrggbb` hex in a string (the SC-03 leak detector). */
const HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/;

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: {
      name: "Authored Direction ITest",
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

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-authdir-"));
  // Genuinely dry-run / key-free: no API key, no network.
  delete process.env.OPENAI_API_KEY;
  const { loadConfig: lc } = await import("../config.js");
  vi.mocked(lc).mockResolvedValue(buildTestConfig(tmpDir));
  // Silence progress logging during the test.
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Authored direction payload — no hex, no font family in any prose field. */
function makeAuthoredContent(name = "Midnight Jazz"): Record<string, unknown> {
  return {
    name,
    summary: "A moody, intimate late-night jazz bar brand identity.",
    character: {
      mood: "intimate, smoky, contemplative",
      composition: "clean layers with elegant negative space",
      layout: "editorial grid with generous padding",
      imagery: "abstract ink washes and silhouettes",
      texture: "rough grain, vellum-like surfaces",
      rhythm: "slow, deliberate pacing",
    },
    usage: {
      rules: [
        "Use the primary color for key calls to action",
        "Apply the surface role to card backgrounds",
      ],
      antiRules: [
        "Never use the background color for body text",
        "Avoid decorative gradients",
      ],
    },
    copyExamples: {
      headline: "Where the night comes alive",
      subheadline: "An intimate jazz experience",
      cta: "Reserve your table",
    },
  };
}

describe("authored-direction pipeline (create direction → color-lock → direction create → approve; no network / no key)", () => {
  it("proves the full keyless loop, token seeding, color-lock honor, prose hygiene, approve, per-direction isolation, collision-safety, and versioned-write discipline", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);

    /** Absolute `directions/` directory for a direction under the tmp project. */
    const dirsOf = (_directionId: string): string => directionsRoot(tmpDir, config);

    // ──────────────────────────────────────────────────────────────────────────
    // 1. TWO SIBLING DIRECTIONS. `echo` is the untouched isolation witness —
    //    no `alpha` operation may read or write it.
    // ──────────────────────────────────────────────────────────────────────────
    await runDirection({ cwd: tmpDir, verb: "new", id: "alpha" });
    await runDirection({ cwd: tmpDir, verb: "new", id: "echo" });

    // ──────────────────────────────────────────────────────────────────────────
    // 2. RECORD A COLOR-LOCK on `alpha` (SC-04). Enters direction memory as a
    //    `Color locked: #1a2b3c` decision entry via recordColorLock;
    //    deriveLocksFromContext reads it from the rendered context block and
    //    passes it to buildTokens as a PaletteLock → held VERBATIM in the seed
    //    palette at create time.
    // ──────────────────────────────────────────────────────────────────────────
    await core.recordColorLock("alpha", {
      hex: "#1a2b3c",
      author: "test-suite",
      source: "authored-direction-pipeline.test.ts",
    });

    // ──────────────────────────────────────────────────────────────────────────
    // 3. DIRECTION CREATE (authored, keyless). Drive the CLI-level command
    //    (WS-03 → WS-02 → WS-01) with a payload that has no hex/font in prose
    //    and no `tokens` key. The core validates, builds seed tokens honoring
    //    the lock, and persists v1 without any model call.
    // ──────────────────────────────────────────────────────────────────────────
    const result = await runCreateDirection({
      cwd: tmpDir,
      verb: "create",
      seedDirectionId: "alpha",
      json: JSON.stringify(makeAuthoredContent()),
    });

    expect(result.seedDirection).toBe("alpha");
    expect(typeof result.directionId).toBe("string");
    expect(result.directionId.length).toBeGreaterThan(0);
    // The create path is keyless by construction — dryRun is always true here.
    expect(result.dryRun).toBe(true);

    // No model call happened — generateImage was never invoked (SC-02/SC-08).
    expect(vi.mocked(generateImage)).not.toHaveBeenCalled();

    // ──────────────────────────────────────────────────────────────────────────
    // 4. V1 WITH ENGINE TOKENS HONORING THE LOCK (SC-04). The direction index
    //    has exactly one version; the head points to that version.
    // ──────────────────────────────────────────────────────────────────────────
    const index = await core.get(result.directionId);
    expect(index.versions).toHaveLength(1);
    expect(index.head).toBe(index.versions[0]);

    const head = await readHead(dirsOf("alpha"), result.directionId);
    // All six palette roles present (data-model invariant; SC-05).
    expect(head.tokens?.palette).toHaveLength(6);
    // The locked color #1a2b3c appears UNCHANGED in the seed palette (SC-04).
    const paletteHexes = (head.tokens?.palette ?? []).map((t) => t.hex);
    expect(paletteHexes).toContain("#1a2b3c");

    // Authored content round-trips correctly; producedBy marks the authoring path.
    expect(head.name).toBe("Midnight Jazz");
    expect(head.producedBy).toBe("authored");

    // ──────────────────────────────────────────────────────────────────────────
    // 5. NO HEX / FONT IN PROSE (SC-03). The character and usage prose fields
    //    must not contain #rgb/#rrggbb hex codes or catalog font family names.
    //    (assertNoHexOrFontInProse enforces this before persisting; this
    //    assertion confirms the guard ran and the on-disk content is clean.)
    // ──────────────────────────────────────────────────────────────────────────
    const characterStrings = Object.values(head.character).filter(
      (v): v is string => typeof v === "string",
    );
    const usageStrings = [...head.usage.rules, ...head.usage.antiRules];
    for (const text of [...characterStrings, ...usageStrings]) {
      expect(HEX_RE.test(text)).toBe(false);
      const lower = text.toLowerCase();
      for (const font of CATALOG_FONTS) {
        expect(lower.includes(font.toLowerCase())).toBe(false);
      }
    }

    // ──────────────────────────────────────────────────────────────────────────
    // 6. APPROVE PROJECTS brand.css (SC-05). resolveBrandVars must not throw
    //    on a freshly-created direction (seed tokens are always present).
    //    The emitted brand.css must contain all six --brand-* semantic vars,
    //    including the locked color (#1a2b3c) at whichever role the engine
    //    assigned it.
    // ──────────────────────────────────────────────────────────────────────────
    // resolveBrandVars must not throw — a created direction always carries tokens.
    expect(() => resolveBrandVars(head)).not.toThrow();

    await runApprove({
      cwd: tmpDir,
      directionId: result.directionId,
      force: true,
    });

    const cssContent = await fs.readFile(config.outputs.cssVars, "utf-8");
    // All six semantic --brand-* variables present in the CSS.
    expect(cssContent).toContain("--brand-primary:");
    expect(cssContent).toContain("--brand-secondary:");
    expect(cssContent).toContain("--brand-background:");
    expect(cssContent).toContain("--brand-surface:");
    expect(cssContent).toContain("--brand-text:");
    expect(cssContent).toContain("--brand-text-muted:");
    // The locked color appears in the CSS at the role it was seeded into (SC-04).
    expect(cssContent).toContain("#1a2b3c");

    // ──────────────────────────────────────────────────────────────────────────
    // 7. PER-DIRECTION ISOLATION (SC-08). Create `echo` with a DIFFERENT lock
    //    and direction; assert alpha's lock (#1a2b3c) is absent from echo's
    //    seed palette and that alpha's memory was not touched by echo's create.
    // ──────────────────────────────────────────────────────────────────────────
    await core.recordColorLock("echo", {
      hex: "#ff8800",
      author: "test-suite",
      source: "authored-direction-pipeline.test.ts",
    });

    const echoResult = await runCreateDirection({
      cwd: tmpDir,
      verb: "create",
      seedDirectionId: "echo",
      json: JSON.stringify(makeAuthoredContent("Echo Neon")),
    });

    const echoHead = await readHead(dirsOf("echo"), echoResult.directionId);
    const echoHexes = (echoHead.tokens?.palette ?? []).map((t) => t.hex);
    // Alpha's lock must NOT bleed into echo's seed palette — isolation is strict.
    expect(echoHexes).not.toContain("#1a2b3c");
    // Echo's own lock is honored verbatim.
    expect(echoHexes).toContain("#ff8800");

    // Alpha's memory has exactly the one lock we recorded; no sibling bleed.
    const alphaDecisions = (await core.memoryEntries("alpha")).filter((entry) => entry.kind === "decision");
    expect(alphaDecisions).toHaveLength(1);
    expect(alphaDecisions[0].body).toBe("Color locked: #1a2b3c");

    // ──────────────────────────────────────────────────────────────────────────
    // 8. VERSIONED (409) WRITES + COLLISION-SAFE CREATE (SC-09).
    //
    // The correct concurrency facts — two true assertions, no fabricated 409:
    //
    // (a) `direction create` mints a fresh collision-safe id (mintDirectionId
    //     slugifies the name and appends -2/-3 for siblings). Two creates with
    //     the SAME `name` produce TWO directions at DISTINCT ids — never a
    //     clobber, never a 409. Create is collision-safe by construction:
    //     appendVersionToIndex just reads/appends/writes with no expectedVersion
    //     check on the create path.
    //
    // (b) The program's 409 guarantee lives on the versioned-record surface it
    //     inherits. A stale-expectedVersion brief PATCH still throws
    //     VersionConflictError, confirming the write core's concurrency
    //     discipline is intact. We do NOT fabricate a 409 on the create path.
    // ──────────────────────────────────────────────────────────────────────────

    // (a) Collision-safe: two same-name creates → two distinct direction ids.
    const dup1 = await runCreateDirection({
      cwd: tmpDir,
      verb: "create",
      seedDirectionId: "alpha",
      json: JSON.stringify(makeAuthoredContent("Bold")),
    });
    const dup2 = await runCreateDirection({
      cwd: tmpDir,
      verb: "create",
      seedDirectionId: "alpha",
      json: JSON.stringify(makeAuthoredContent("Bold")),
    });
    // Distinct ids (e.g. "bold" and "bold-2") — no clobber, no 409.
    expect(dup1.directionId).not.toBe(dup2.directionId);
    // Both are genuine, readable directions persisted on disk.
    const dup1Head = await readHead(dirsOf("alpha"), dup1.directionId);
    const dup2Head = await readHead(dirsOf("alpha"), dup2.directionId);
    expect(dup1Head.name).toBe("Bold");
    expect(dup2Head.name).toBe("Bold");

    // (b) A stale-expectedVersion brief PATCH on `alpha` throws VersionConflictError
    //     (the existing optimistic-concurrency discipline — left intact).
    const stale = await core.get("alpha");
    await core.setBriefFields("alpha", { voice: "hushed" }); // bumps the version
    await expect(
      core.setBriefFields(
        "alpha",
        { voice: "louder" },
        { expectedVersion: stale.version },
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
  });
});
