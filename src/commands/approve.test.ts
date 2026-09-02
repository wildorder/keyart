import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { DirectionVersion, KeyartConfig } from "../types.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

const VERSION_ID = "2026-06-30T00-00-00-000Z";

const SAMPLE_DIRECTION: DirectionVersion = {
  id: VERSION_ID,
  createdAt: "2026-06-30T00:00:00.000Z",
  briefSnapshot: "brief snapshot",
  contextSnapshot: "context snapshot",
  name: "Bold & Modern",
  summary: "A bold, modern direction emphasizing clean geometry and strong contrast.",
  positioning: "Position the brand as a confident, forward-thinking leader.",
  character: {
    mood: "High-contrast palette, geometric sans-serif typography, generous whitespace.",
  },
  homepageMockupPrompt: "Design a bold, modern homepage mockup with geometric shapes.",
  styleTilePrompt: "Create a style tile for a bold, modern brand with color swatches.",
  copyExamples: {
    headline: "Built for what comes next",
    subheadline: "A modern platform designed with clarity and confidence.",
    cta: "Get started",
  },
  usage: {
    rules: [
      "Use a maximum of 3 brand colors plus neutrals",
      "Maintain at least 4:1 contrast ratio on all text",
      "Keep layouts grid-aligned with consistent 8px spacing",
    ],
    antiRules: [
      "Never use more than two typefaces on a single page",
      "Avoid rounded or playful shapes — keep geometry sharp",
    ],
  },
  tokens: {
    palette: [
      { role: "primary", name: "Primary", hex: "#3b1e5e" },
      { role: "secondary", name: "Secondary", hex: "#7a4fb5" },
      { role: "background", name: "Background", hex: "#fbf9ff" },
      { role: "surface", name: "Surface", hex: "#efe9f7" },
      { role: "text", name: "Text", hex: "#1c1030" },
      { role: "muted", name: "Muted", hex: "#6b5b83" },
    ],
    typography: { heading: "Fraunces", body: "Nunito Sans", scale: 1.25 },
    shape: { radius: "14px", spacingUnit: "6px" },
  },
};

const SAMPLE_DIRECTION_B: DirectionVersion = {
  ...SAMPLE_DIRECTION,
  name: "Warm Editorial",
  summary: "A warm, editorial direction with earthy tones and serif typography.",
  character: { mood: "Warm earthy palette, refined serif headings, calm spacing." },
};

const TOKENED_DIRECTION: DirectionVersion = {
  ...SAMPLE_DIRECTION,
  name: "Token Direction",
  character: { mood: "prose that must not drive the tokens" },
};

const SAMPLE_PROJECT: KeyartConfig["project"] = {
  name: "Test Project",
  type: "prototype",
  framework: "next",
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-approve-cmd-"));
  delete process.env.OPENAI_API_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function mockConfig(): KeyartConfig {
  return {
    project: SAMPLE_PROJECT,
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
      implementationBrief: path.join(tmpDir, "brand", "generated", "implementation-brief.md"),
    },
    store: { driver: "file" },
  };
}

// Directions now live FLAT under `<brand.root>/directions/<directionId>/` — no
// concept namespace above them (Direction is the top-level aggregate root).
function directionsDir(): string {
  return path.join(tmpDir, "brand", "directions");
}

function directionDirOf(directionId: string): string {
  return path.join(directionsDir(), directionId);
}

/**
 * Writes one version's on-disk files (`direction-version.json` + the prompt
 * projections) under `<directionId>/versions/<versionId>/` — the tree WS-02
 * produces. Does NOT touch `direction.yaml`; callers advance `versions`/`head`
 * via `DirectionCore.appendVersion`, mirroring `direction/store.test.ts`'s
 * `seedVersionFile` + `core.appendVersion` convention.
 */
async function writeVersionFiles(
  directionId: string,
  direction: DirectionVersion,
): Promise<void> {
  const versionDir = path.join(directionDirOf(directionId), "versions", direction.id);
  await fs.mkdir(versionDir, { recursive: true });
  await fs.writeFile(
    path.join(versionDir, "direction-version.json"),
    JSON.stringify(direction),
    "utf-8",
  );
  await fs.writeFile(
    path.join(versionDir, "style-tile-prompt.md"),
    direction.styleTilePrompt,
    "utf-8",
  );
  await fs.writeFile(
    path.join(versionDir, "homepage-mockup-prompt.md"),
    direction.homepageMockupPrompt,
    "utf-8",
  );
}

/**
 * Creates a direction (via the real `DirectionCore`, mirroring
 * `direction/core.test.ts`) and seeds a single version as its head — the
 * flat-model replacement for the old `seedConcept({ directionId, direction })`.
 */
async function seedDirection(
  config: KeyartConfig,
  id: string,
  opts: { direction?: DirectionVersion } = {},
): Promise<void> {
  const core = createDirectionCore(tmpDir, config);
  await core.create({ id, name: id });
  const direction = opts.direction ?? SAMPLE_DIRECTION;
  await writeVersionFiles(id, direction);
  await core.appendVersion(id, direction.id);
}

// Distinct version ids + palettes so we can prove WHICH version approve pinned
// (each varies only the `primary` hex, so brand.css diverges per version).
const VERSION_ID_1 = VERSION_ID; // the direction's first version (v1)
const VERSION_ID_2 = "2026-07-01T00-00-00-000Z";
const VERSION_ID_3 = "2026-07-02T00-00-00-000Z";

/** Clone a base version with a fresh id/name and a distinct `primary` hex. */
function withPrimary(
  base: DirectionVersion,
  id: string,
  name: string,
  primaryHex: string,
): DirectionVersion {
  return {
    ...base,
    id,
    name,
    tokens: {
      ...base.tokens!,
      palette: base.tokens!.palette.map((t) =>
        t.role === "primary" ? { ...t, hex: primaryHex } : t,
      ),
    },
  };
}

const V1 = SAMPLE_DIRECTION; // id VERSION_ID_1, primary #3b1e5e
const V2 = withPrimary(SAMPLE_DIRECTION, VERSION_ID_2, "Bold v2", "#112233");
const V3 = withPrimary(SAMPLE_DIRECTION, VERSION_ID_3, "Bold v3", "#445566");

/**
 * Writes N ordered versions onto an EXISTING direction (advancing `head` to
 * the last one appended), each with its own `direction-version.json` + prompt
 * files — the on-disk shape WS-03 produces when feedback appends a version.
 * Can be called again on the same direction to advance the head further.
 */
async function appendDirectionVersions(
  config: KeyartConfig,
  directionId: string,
  versions: DirectionVersion[],
): Promise<void> {
  const core = createDirectionCore(tmpDir, config);
  for (const v of versions) {
    await writeVersionFiles(directionId, v);
    await core.appendVersion(directionId, v.id);
  }
}

async function readBrandCssFile(): Promise<string> {
  return fs.readFile(
    path.join(tmpDir, "brand", "generated", "brand.css"),
    "utf-8",
  );
}

function packDirOf(directionId: string): string {
  return path.join(tmpDir, "brand", "generated", "asset-pack", directionId);
}

const ASSET_VERSION_ID = "2026-07-20T00-00-00-000Z";

/**
 * Seeds one extracted asset at v1 on a direction via the real asset store
 * (`appendVersionToIndex` writes the version record + index). `png: true`
 * additionally writes a stub head `asset.png` so the pack ships it. Assets
 * now live directly under the direction's own tree (`<directionDir>/extracted-
 * assets/<assetId>/`) — there is no concept-level tree above it any more.
 */
async function seedAsset(
  directionId: string,
  assetId: string,
  opts: { png: boolean },
): Promise<void> {
  const { appendVersionToIndex } = await import("../asset/asset-store.js");
  await appendVersionToIndex(
    directionDirOf(directionId),
    assetId,
    { name: assetId, directionId },
    {
      id: ASSET_VERSION_ID,
      createdAt: "2026-07-20T00:00:00.000Z",
      description: `the ${assetId} element`,
      source: { directionId, versionId: VERSION_ID, image: "styleTile" },
      files: ["asset-prompt.md", ...(opts.png ? ["asset.png"] : [])],
    },
  );
  if (opts.png) {
    await fs.writeFile(
      path.join(
        directionDirOf(directionId),
        "extracted-assets",
        assetId,
        "versions",
        ASSET_VERSION_ID,
        "asset.png",
      ),
      "stub-png-bytes",
      "utf-8",
    );
  }
}

async function loadRunApprove() {
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(mockConfig());
  const { runApprove } = await import("./approve.js");
  return runApprove;
}

async function readApproved(): Promise<Record<string, unknown> & { provenance: Record<string, unknown> }> {
  const raw = await fs.readFile(
    path.join(tmpDir, "brand", "approved", "current-direction.json"),
    "utf-8",
  );
  return JSON.parse(raw);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

describe("runApprove", () => {
  it("approves a direction with the positional-only form", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");

    const runApprove = await loadRunApprove();
    const result = await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });

    expect(result.directionId).toBe("direction-a");

    const approved = await readApproved();
    expect(approved.provenance.versionId).toBe(VERSION_ID);
    expect(approved.provenance.directionId).toBe("direction-a");
    expect(typeof approved.provenance.approvedAt).toBe("string");

    // Global pointer set.
    const global = await createBrandCore(tmpDir, config).read();
    expect(global.approvedPointer).toMatchObject({
      versionId: VERSION_ID,
      directionId: "direction-a",
    });
    expect(typeof global.approvedPointer?.approvedAt).toBe("string");

    // Direction transitioned to approved.
    const record = await createDirectionCore(tmpDir, config).get("direction-a");
    expect(record.status).toBe("approved");
  });

  it("preserves every DirectionVersion field byte-equal in current-direction.json", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");

    const runApprove = await loadRunApprove();
    await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });

    const approved = await readApproved();
    for (const key of Object.keys(SAMPLE_DIRECTION) as (keyof DirectionVersion)[]) {
      expect(approved[key]).toEqual(SAMPLE_DIRECTION[key]);
    }
  });

  it("writes the pointer and a repoint keeps global rules (rebrand-keeps-rules)", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");
    await seedDirection(config, "direction-b", { direction: SAMPLE_DIRECTION_B });

    // A deliberate global hard rule exists BEFORE any approve.
    await createBrandCore(tmpDir, config).addRule({
      severity: "hard",
      text: "Never use pure black",
      author: "test",
      source: "test",
    });

    const runApprove = await loadRunApprove();

    // Approve direction A.
    await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });
    let global = await createBrandCore(tmpDir, config).read();
    expect(global.approvedPointer?.directionId).toBe("direction-a");
    expect(global.rules.map((r) => r.text)).toContain("Never use pure black");

    // Repoint to direction B — the rebrand.
    await runApprove({
      cwd: tmpDir,
      directionId: "direction-b",
      force: true,
    });
    global = await createBrandCore(tmpDir, config).read();
    expect(global.approvedPointer?.directionId).toBe("direction-b");
    // Global rule SURVIVES the rebrand.
    expect(global.rules.map((r) => r.text)).toContain("Never use pure black");
  });

  it("codifies stamped artifacts that inject the global hard rules", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");
    await createBrandCore(tmpDir, config).addRule({
      severity: "hard",
      text: "Never use pure black",
      author: "test",
      source: "test",
    });

    const runApprove = await loadRunApprove();
    await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });

    const stampNeedle = `direction=direction-a version=${VERSION_ID}`;

    const visual = await fs.readFile(
      path.join(tmpDir, "brand", "guides", "visual-style-guide.md"),
      "utf-8",
    );
    expect(visual).toContain(stampNeedle);
    expect(visual).toContain("Non-Negotiable Global Rules");
    expect(visual).toContain("Never use pure black");

    const cursor = await fs.readFile(
      path.join(tmpDir, ".cursor", "rules", "keyart-brand.mdc"),
      "utf-8",
    );
    expect(cursor).toContain(stampNeedle);
    expect(cursor).toContain("Non-Negotiable Global Rules");
    expect(cursor).toContain("Never use pure black");

    const brief = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "implementation-brief.md"),
      "utf-8",
    );
    expect(brief).toContain(stampNeedle);
    expect(brief).toContain("Never use pure black");

    const css = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "brand.css"),
      "utf-8",
    );
    expect(css).toContain(`/* Source: ${stampNeedle}`);
  });

  it("repoint + re-codify fully rebrands the generated guides (pure projection)", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");
    await seedDirection(config, "direction-y", { direction: SAMPLE_DIRECTION_B });

    const runApprove = await loadRunApprove();

    await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });
    const visualA = await fs.readFile(
      path.join(tmpDir, "brand", "guides", "visual-style-guide.md"),
      "utf-8",
    );
    expect(visualA).toContain("Bold & Modern");

    await runApprove({
      cwd: tmpDir,
      directionId: "direction-y",
      force: true,
    });
    const visualB = await fs.readFile(
      path.join(tmpDir, "brand", "guides", "visual-style-guide.md"),
      "utf-8",
    );
    // Reflects Y's direction + stamp; no stale A content.
    expect(visualB).toContain("Warm Editorial");
    expect(visualB).toContain("Warm earthy palette");
    expect(visualB).toContain(`direction=direction-y version=${VERSION_ID}`);
    expect(visualB).not.toContain("Bold & Modern");
  });

  it("direction-not-found lists the available directions", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");

    const runApprove = await loadRunApprove();
    const { CommandError } = await import("../errors.js");
    await expect(
      runApprove({ cwd: tmpDir, directionId: "bogus" }),
    ).rejects.toThrow(CommandError);
    await expect(
      runApprove({ cwd: tmpDir, directionId: "bogus" }),
    ).rejects.toThrow(/Direction not found: bogus/);
    await expect(
      runApprove({ cwd: tmpDir, directionId: "bogus" }),
    ).rejects.toThrow(/direction-a/);
  });

  it("version-not-found lists the direction's available versions", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");

    const runApprove = await loadRunApprove();
    const { CommandError } = await import("../errors.js");
    await expect(
      runApprove({
        cwd: tmpDir,
        directionId: "direction-a",
        versionId: "nope",
      }),
    ).rejects.toThrow(CommandError);
    await expect(
      runApprove({
        cwd: tmpDir,
        directionId: "direction-a",
        versionId: "nope",
      }),
    ).rejects.toThrow(new RegExp(VERSION_ID));
  });

  it("writes the deterministic style board (md + svg) whose hexes match brand.css", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a", { direction: TOKENED_DIRECTION });

    const runApprove = await loadRunApprove();
    const result = await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });

    // Both board artifacts are written and listed (cwd-relative, forward slash).
    expect(result.filesWritten).toContain("brand/guides/style-board.md");
    expect(result.filesWritten).toContain("brand/guides/style-board.svg");

    const md = await fs.readFile(
      path.join(tmpDir, "brand", "guides", "style-board.md"),
      "utf-8",
    );
    const svg = await fs.readFile(
      path.join(tmpDir, "brand", "guides", "style-board.svg"),
      "utf-8",
    );
    const css = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "brand.css"),
      "utf-8",
    );

    expect(md).toContain("# Palette & Type (exact)");
    // The board is a strict projection of the same tokens brand.css uses.
    for (const hex of ["#3b1e5e", "#7a4fb5", "#1c1030", "#6b5b83"]) {
      expect(css).toContain(hex);
      expect(md).toContain(hex);
      expect(svg).toContain(hex);
    }
    for (const family of ["Fraunces", "Nunito Sans"]) {
      expect(css).toContain(family);
      expect(md).toContain(family);
      expect(svg).toContain(family);
    }
  });

  it("carries the extracted tokens into current-direction.json and projects an approximate-labeled brand.css (SC-09/SC-10)", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a", { direction: TOKENED_DIRECTION });
    // A pre-existing global hard rule proves rebrand-keeps-rules through approve.
    await createBrandCore(tmpDir, config).addRule({
      severity: "hard",
      text: "Never use pure black",
      author: "test",
      source: "test",
    });
    const { APPROXIMATE_FONT_NOTE } = await import(
      "../approve/render-guides.js"
    );

    const runApprove = await loadRunApprove();
    await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });

    // current-direction.json carries the SAME extracted tokens, untouched.
    const approved = await readApproved();
    expect(approved.tokens).toEqual(TOKENED_DIRECTION.tokens);

    // brand.css on disk projects the extracted hexes EXACTLY (not the prose
    // keyword hack) and labels the fonts approximate — var contract unchanged.
    const css = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "brand.css"),
      "utf-8",
    );
    expect(css).toContain("--brand-primary: #3b1e5e;");
    expect(css).toContain("--brand-text-muted: #6b5b83;");
    expect(css).toContain(
      "--brand-font-heading: 'Fraunces', system-ui, sans-serif;",
    );
    expect(css).toContain(`/* ${APPROXIMATE_FONT_NOTE} */`);

    // Pointer set to {directionId, versionId}; global rule preserved.
    const global = await createBrandCore(tmpDir, config).read();
    expect(global.approvedPointer).toMatchObject({
      versionId: VERSION_ID,
      directionId: "direction-a",
    });
    expect(global.rules.map((r) => r.text)).toContain("Never use pure black");
  });

  it("approves a tokened direction, writing CSS + board without error", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");

    const runApprove = await loadRunApprove();
    const result = await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });

    expect(result.filesWritten).toContain("brand/guides/style-board.md");
    expect(result.filesWritten).toContain("brand/guides/style-board.svg");
    const md = await fs.readFile(
      path.join(tmpDir, "brand", "guides", "style-board.md"),
      "utf-8",
    );
    expect(md).toContain("# Palette & Type (exact)");
  });

  it("filesWritten includes the approved file, brand.yaml, and direction.yaml with forward slashes", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");

    const runApprove = await loadRunApprove();
    const result = await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });

    expect(result.filesWritten).toContain("brand/approved/current-direction.json");
    expect(result.filesWritten).toContain("brand/brand.yaml");
    expect(result.filesWritten).toContain("brand/directions/direction-a/direction.yaml");
    expect(result.filesWritten.every((p) => !p.includes("\\"))).toBe(true);
  });
});

describe("runApprove — version pinning (SC-04 / SC-08)", () => {
  it("pins the direction's HEAD version by default — no runId anywhere", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");
    await appendDirectionVersions(config, "direction-a", [V2]); // head = v2 (v1 already seeded)

    const runApprove = await loadRunApprove();
    await runApprove({ cwd: tmpDir, directionId: "direction-a", force: true });

    // Provenance + pointer pin the head (v2), not the first version.
    const approved = await readApproved();
    expect(approved.provenance.versionId).toBe(VERSION_ID_2);
    expect(approved.provenance.runId).toBeUndefined();

    const pointer = (await createBrandCore(tmpDir, config).read()).approvedPointer;
    expect(pointer?.versionId).toBe(VERSION_ID_2);
    expect((pointer as Record<string, unknown>).runId).toBeUndefined();

    // brand.css projects v2's tokens (primary #112233), not v1's.
    const css = await readBrandCssFile();
    expect(css).toContain("--brand-primary: #112233;");
    expect(css).not.toContain("#3b1e5e");
  });

  it("pins a specific version when versionId is given, not the head", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");
    await appendDirectionVersions(config, "direction-a", [V2]); // head = v2

    const runApprove = await loadRunApprove();
    await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      versionId: VERSION_ID_1,
      force: true,
    });

    const approved = await readApproved();
    expect(approved.provenance.versionId).toBe(VERSION_ID_1);
    const pointer = (await createBrandCore(tmpDir, config).read()).approvedPointer;
    expect(pointer?.versionId).toBe(VERSION_ID_1);

    // brand.css reflects v1's tokens even though v2 is the head.
    const css = await readBrandCssFile();
    expect(css).toContain("--brand-primary: #3b1e5e;");
    expect(css).not.toContain("#112233");
  });

  it("brand.css is a byte-identical projection of the pinned version (SC-04)", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");
    await appendDirectionVersions(config, "direction-a", [V2]); // head = v2

    const runApprove = await loadRunApprove();
    await runApprove({ cwd: tmpDir, directionId: "direction-a", force: true });

    const { renderBrandCss } = await import("../approve/render-guides.js");
    // Rendering the pinned version directly reproduces the on-disk brand.css
    // byte-for-byte, modulo the provenance `/* Source: … */` stamp line.
    const expected = renderBrandCss(V2);
    const onDisk = (await readBrandCssFile()).replace(
      /\/\* Source:[^\n]*\*\/\n/,
      "",
    );
    expect(onDisk).toBe(expected);
  });

  it("iterating after approve advances the head but leaves the pinned pointer + brand.css unchanged until re-approve (SC-08)", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");
    await appendDirectionVersions(config, "direction-a", [V2]); // head = v2

    const runApprove = await loadRunApprove();
    await runApprove({ cwd: tmpDir, directionId: "direction-a", force: true });

    const pointerBefore = (await createBrandCore(tmpDir, config).read())
      .approvedPointer;
    expect(pointerBefore?.versionId).toBe(VERSION_ID_2);
    const cssBefore = await readBrandCssFile();

    // WS-03 feedback appends v3 — the direction's HEAD advances to v3.
    await appendDirectionVersions(config, "direction-a", [V3]);
    const record = await createDirectionCore(tmpDir, config).get("direction-a");
    expect(record.head).toBe(VERSION_ID_3);

    // The shipped brand does NOT silently move: pointer + brand.css still v2.
    const pointerAfter = (await createBrandCore(tmpDir, config).read())
      .approvedPointer;
    expect(pointerAfter?.versionId).toBe(VERSION_ID_2);
    expect(await readBrandCssFile()).toBe(cssBefore);

    // An explicit re-approve repoints to the new head (v3) and re-projects.
    await runApprove({ cwd: tmpDir, directionId: "direction-a", force: true });
    const pointerRepin = (await createBrandCore(tmpDir, config).read())
      .approvedPointer;
    expect(pointerRepin?.versionId).toBe(VERSION_ID_3);
    expect(await readBrandCssFile()).toContain("--brand-primary: #445566;");
  });

  it("codifies the asset pack even with no extracted assets (tokens + sheet + manifest)", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");

    const runApprove = await loadRunApprove();
    const result = await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });

    for (const file of [
      "contact-sheet.svg",
      "contact-sheet.md",
      "tokens.json",
      "pack-manifest.json",
    ]) {
      expect(result.filesWritten).toContain(
        `brand/generated/asset-pack/direction-a/${file}`,
      );
    }
    expect(result.assetPack).toEqual({ assetsIncluded: [], assetsPending: [] });

    const manifest = JSON.parse(
      await fs.readFile(
        path.join(packDirOf("direction-a"), "pack-manifest.json"),
        "utf-8",
      ),
    );
    expect(manifest.approved).toBe(true);
    expect(manifest.assets).toEqual([]);

    // With no assets the guides carry NO hollow "Brand Assets" section, but
    // the implementation brief's References still names the pack folder.
    const brief = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "implementation-brief.md"),
      "utf-8",
    );
    expect(brief).not.toContain("## Brand Assets");
    expect(brief).toContain("brand/generated/asset-pack/direction-a/");
    const cursor = await fs.readFile(
      path.join(tmpDir, ".cursor", "rules", "keyart-brand.mdc"),
      "utf-8",
    );
    expect(cursor).not.toContain("## Brand Assets");
  });

  it("ships active asset head PNGs, lists image-less assets as pending, and excludes retired assets", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");
    await seedAsset("direction-a", "yak-logo", { png: true });
    await seedAsset("direction-a", "wave-motif", { png: false });
    await seedAsset("direction-a", "old-crest", { png: true });
    const { retireExtractedAsset } = await import("../asset/asset-store.js");
    await retireExtractedAsset(directionDirOf("direction-a"), "old-crest");

    const runApprove = await loadRunApprove();
    const result = await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });

    expect(result.assetPack.assetsIncluded).toEqual(["yak-logo"]);
    expect(result.assetPack.assetsPending).toEqual(["wave-motif"]);
    expect(result.filesWritten).toContain(
      "brand/generated/asset-pack/direction-a/yak-logo.png",
    );

    const packFiles = await fs.readdir(packDirOf("direction-a"));
    expect(packFiles).toContain("yak-logo.png");
    expect(packFiles).not.toContain("wave-motif.png");
    expect(packFiles).not.toContain("old-crest.png");

    const manifest = JSON.parse(
      await fs.readFile(
        path.join(packDirOf("direction-a"), "pack-manifest.json"),
        "utf-8",
      ),
    );
    const byId = Object.fromEntries(
      (
        manifest.assets as { id: string; pending: boolean; file?: string }[]
      ).map((a) => [a.id, a]),
    );
    expect(byId["yak-logo"].pending).toBe(false);
    expect(byId["yak-logo"].file).toBe("yak-logo.png");
    expect(byId["wave-motif"].pending).toBe(true);
    expect(byId["wave-motif"].file).toBeUndefined();
    expect(byId["old-crest"]).toBeUndefined();

    // The codified implementation brief + cursor rules TELL the coding agent
    // the shipped assets exist: name, description, and the exact pack path.
    const brief = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "implementation-brief.md"),
      "utf-8",
    );
    expect(brief).toContain("## Brand Assets");
    expect(brief).toContain(
      "`brand/generated/asset-pack/direction-a/yak-logo.png`",
    );
    expect(brief).toContain("the yak-logo element");
    expect(brief).toMatch(/wave-motif.*pending/);
    expect(brief).not.toContain("old-crest");

    const cursor = await fs.readFile(
      path.join(tmpDir, ".cursor", "rules", "keyart-brand.mdc"),
      "utf-8",
    );
    expect(cursor).toContain("## Brand Assets");
    expect(cursor).toContain(
      "`brand/generated/asset-pack/direction-a/yak-logo.png`",
    );
  });

  it("the pack's tokens.json pins the APPROVED version, byte-matching brand.css, even when the head has moved", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");
    await appendDirectionVersions(config, "direction-a", [V2]); // head = v2

    const runApprove = await loadRunApprove();
    // Approve v1 explicitly while the head is v2.
    await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      versionId: VERSION_ID_1,
      force: true,
    });

    const tokensRaw = await fs.readFile(
      path.join(packDirOf("direction-a"), "tokens.json"),
      "utf-8",
    );
    // The pack ships v1's primary (the pinned/approved version), not v2's.
    expect(tokensRaw).toContain("#3b1e5e");
    expect(tokensRaw).not.toContain("#112233");
    // And agrees with the codified brand.css byte-for-byte on the hex.
    expect(await readBrandCssFile()).toContain("--brand-primary: #3b1e5e;");
  });

  it("rules survive a repoint and hard rules lead the codified guides (SC-11)", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");
    await appendDirectionVersions(config, "direction-a", [V2]);
    await seedDirection(config, "direction-b", {
      direction: withPrimary(SAMPLE_DIRECTION_B, VERSION_ID_1, "Warm Editorial", "#8a5a2b"),
    });

    // A global hard rule exists before any approve.
    await createBrandCore(tmpDir, config).addRule({
      severity: "hard",
      text: "Never use pure black",
      author: "test",
      source: "test",
    });

    const runApprove = await loadRunApprove();
    await runApprove({ cwd: tmpDir, directionId: "direction-a", force: true });

    // Repoint to a different direction/version — the rebrand.
    await runApprove({
      cwd: tmpDir,
      directionId: "direction-b",
      force: true,
    });

    const global = await createBrandCore(tmpDir, config).read();
    expect(global.rules.map((r) => r.text)).toContain("Never use pure black");

    // The hard rule is injected ahead of the direction's own design rules.
    const guide = await fs.readFile(
      path.join(tmpDir, "brand", "guides", "visual-style-guide.md"),
      "utf-8",
    );
    expect(guide).toContain("Non-Negotiable Global Rules");
    expect(guide.indexOf("Never use pure black")).toBeLessThan(
      guide.indexOf("## Design Rules"),
    );
  });
});

describe("runApprove — surface bind joins the codify (surface-manifest WS-07 / SC-08)", () => {
  it("no manifest ⇒ byte-identical approve", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runApprove = await loadRunApprove();
    const result = await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });
    const logs = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    logSpy.mockRestore();

    expect("surface" in result).toBe(false);
    expect(result.filesWritten.some((p) => p.includes("binding"))).toBe(false);
    expect(
      await pathExists(path.join(tmpDir, "brand", "generated", "binding.json")),
    ).toBe(false);
    expect(logs).not.toContain("Surface gaps");
    expect(logs).not.toContain("binding.json");

    const approved = await readApproved();
    const provenance = approved.provenance;
    const { renderImplementationBrief } = await import("../approve/render-guides.js");
    const expectedBrief = renderImplementationBrief(SAMPLE_DIRECTION, SAMPLE_PROJECT, {
      stamp: {
        directionId: provenance.directionId as string,
        versionId: provenance.versionId as string,
        approvedAt: provenance.approvedAt as string,
      },
      hardRules: [],
      assetPack: {
        packDir: "brand/generated/asset-pack/direction-a",
        items: [],
      },
    });

    const brief = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "implementation-brief.md"),
      "utf-8",
    );
    expect(brief).toBe(expectedBrief);
  });

  it("a surface manifest binds in the codify — filesWritten, gap report, and guides all carry it", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");

    const { createSurfaceCore } = await import("../surface/store.js");
    const core = createSurfaceCore(tmpDir, config);
    await core.setManifest([
      {
        id: "icon.mascot",
        kind: "icon",
        description: "the brand mascot icon",
        criticality: "required",
        origin: "authored",
        attributions: [],
      },
      {
        id: "color.rating-star",
        kind: "color-role",
        description: "star rating color",
        criticality: "preferred",
        origin: "authored",
        attributions: [],
        context: { sitsOn: "surface" },
      },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runApprove = await loadRunApprove();
    const result = await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });
    const logs = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    logSpy.mockRestore();

    expect(result.filesWritten).toContain("brand/generated/binding.json");
    expect(result.surface).toBeDefined();

    const binding = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, "brand", "generated", "binding.json"),
        "utf-8",
      ),
    );
    expect(binding.pointer).toMatchObject({
      directionId: "direction-a",
      versionId: VERSION_ID,
    });

    const counts = { bound: 0, derived: 0, gap: 0, pending: 0 };
    for (const row of binding.slots as { status: keyof typeof counts }[]) {
      counts[row.status] += 1;
    }
    expect(result.surface!.counts).toEqual(counts);
    expect(result.surface!.bindingPath).toBe("brand/generated/binding.json");

    expect(logs).toContain("✓ brand/generated/binding.json");
    expect(logs).toContain("Surface gaps");
    expect(logs).toContain("icon.mascot");

    const brief = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "implementation-brief.md"),
      "utf-8",
    );
    expect(brief).toContain("## Surface Bindings (slot → value)");
    expect(brief).toContain("## Surface Requests (when a brand element is missing)");
    expect(brief).toContain("icon.mascot");

    const cursor = await fs.readFile(
      path.join(tmpDir, ".cursor", "rules", "keyart-brand.mdc"),
      "utf-8",
    );
    expect(cursor).toContain("## Surface Bindings (slot → value)");
    expect(cursor).toContain("## Surface Requests (when a brand element is missing)");
  });

  // WS-10 (SC-11): the Surface Bindings table is asserted at the RESOLVED ROW
  // level — exact rows including the value cell — not by mere section
  // existence. An implementation that renders the header but drops the value
  // cell fails here (the defect the manifest-less byte fixture cannot catch).
  it("renders resolved Surface Bindings rows — value cells included — in both guides (SC-11)", async () => {
    const config = mockConfig();
    await seedDirection(config, "direction-a");

    const { createSurfaceCore } = await import("../surface/store.js");
    await createSurfaceCore(tmpDir, config).setManifest([
      {
        // Final segment `text` is a SEMANTIC role — binds to a concrete hex.
        id: "color.text",
        kind: "color-role",
        description: "body text color",
        criticality: "required",
        origin: "authored",
        attributions: [],
      },
      {
        id: "type.heading",
        kind: "type-role",
        description: "heading font",
        criticality: "required",
        origin: "authored",
        attributions: [],
      },
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const runApprove = await loadRunApprove();
    const result = await runApprove({
      cwd: tmpDir,
      directionId: "direction-a",
      force: true,
    });
    logSpy.mockRestore();

    // The expected rows mirror surfaceValueCell's formatting exactly: the
    // resolved value wrapped in backticks, sourced from the SAME
    // resolveBrandVars projection brand.css uses.
    const { resolveBrandVars } = await import("../approve/render-guides.js");
    const vars = resolveBrandVars(SAMPLE_DIRECTION);
    expect(vars.text).toBe("#1c1030"); // pin the concrete hex so the row check has teeth
    expect(vars.fontHeading).toContain("Fraunces");
    const colorRow = "| `color.text` | color-role | bound | `#1c1030` |";
    const typeRow = `| \`type.heading\` | type-role | bound | \`${vars.fontHeading}\` |`;

    const brief = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "implementation-brief.md"),
      "utf-8",
    );
    expect(brief).toContain(colorRow);
    expect(brief).toContain(typeRow);

    // The same resolved rows appear in the written cursor rules.
    const cursor = await fs.readFile(
      path.join(tmpDir, ".cursor", "rules", "keyart-brand.mdc"),
      "utf-8",
    );
    expect(cursor).toContain(colorRow);
    expect(cursor).toContain(typeRow);

    // Codify order preserved (asset pack → surface bind → guides): the pack
    // files, binding.json, and the guide artifacts all landed in ONE approve,
    // and the brief embeds surface rows sourced from the binding — proving
    // Step 5 (bind) ran before Step 6 (guides) with guideSurface populated.
    expect(result.filesWritten).toContain(
      "brand/generated/asset-pack/direction-a/pack-manifest.json",
    );
    expect(result.filesWritten).toContain(
      "brand/generated/asset-pack/direction-a/tokens.json",
    );
    expect(result.filesWritten).toContain("brand/generated/binding.json");
    expect(result.filesWritten).toContain("brand/generated/implementation-brief.md");
    expect(result.filesWritten).toContain(".cursor/rules/keyart-brand.mdc");

    const binding = JSON.parse(
      await fs.readFile(path.join(tmpDir, "brand", "generated", "binding.json"), "utf-8"),
    );
    const bindingTextRow = binding.slots.find(
      (s: { slotId: string }) => s.slotId === "color.text",
    );
    expect(bindingTextRow.value).toBe("#1c1030"); // the brief's cell IS the binding's value
  });
});

// WS-15 (SC-03): a draft refuses with the teaching error; the pointer is not written.
describe("runApprove — draft refusal (WS-15)", () => {
  it("teaches `keyart explore <id>` on a draft and writes no approved pointer", async () => {
    const config = mockConfig();
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "draft-a", name: "Draft A" });

    const runApprove = await loadRunApprove();
    await expect(
      runApprove({ cwd: tmpDir, directionId: "draft-a" }),
    ).rejects.toThrow(/keyart explore draft-a/);

    const pointer = (await createBrandCore(tmpDir, config).read())
      .approvedPointer;
    expect(pointer).toBeNull();
  });
});
