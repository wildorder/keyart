import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig, DirectionVersion } from "../types.js";
import type { GlobalBrand } from "../brand/schema.js";
import { buildPlaceholderDirections } from "./placeholders.js";
import { writeDirectionVersion } from "./write-direction-version.js";
import { createDirectionCore } from "../direction/core.js";
import { directionsRoot } from "../config.js";
import { assembleContext } from "../brand/assemble-context.js";
import type { AssembledContext } from "../brand/assemble-context.js";
import { composeContentLock } from "./token-intent.js";

let tmpDir: string;

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Write Version Test", type: "prototype", framework: "next" },
    brand: {
      root: path.join(cwd, "brand"),
      references: path.join(cwd, "brand", "input", "references"),
      approved: path.join(cwd, "brand", "approved"),
      rejected: path.join(cwd, "brand", "rejected"),
      directions: path.join(cwd, "brand", "directions"),
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
    store: { driver: "file" },
  };
}

async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

/** Create a direction record (draft) so writeDirectionVersion's internal
 *  DirectionCore.appendVersion has a target — writeDirectionVersion never
 *  scaffolds the record itself. */
async function createDirection(
  cwd: string,
  config: KeyartConfig,
  id: string,
  name = id,
): Promise<void> {
  await createDirectionCore(cwd, config).create({ id, name });
}

/** Build a DirectionVersion from the first placeholder direction's content. */
function makeVersion(id: string): DirectionVersion {
  const content = buildPlaceholderDirections("A test brief.")[0];
  return {
    ...content,
    id,
    createdAt: "2026-07-11T00:00:00.000Z",
    producedBy: "explore",
    briefSnapshot: "A test brief.",
    contextSnapshot: "## Context\n- rule one",
  };
}

/** Build a GlobalBrand with a visual hard rule + positive visual guideline. */
function buildGlobal(): GlobalBrand {
  return {
    approvedPointer: null,
    rules: [
      {
        id: "r1",
        severity: "hard",
        text: "Never use a fist-in-the-air icon",
        author: "tim",
        source: "cli",
        date: "2026-01-01T00:00:00.000Z",
        channel: "visual",
      },
      {
        id: "r2",
        severity: "guideline",
        text: "Prefer open airy compositions",
        author: "tim",
        source: "cli",
        date: "2026-01-01T00:00:00.000Z",
        channel: "visual",
        polarity: "prefer",
      },
    ],
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** Assembled context exercising the WS-02 classifier end-to-end. */
function buildAssembled(): AssembledContext {
  return assembleContext({
    brief: "A test brief.",
    global: buildGlobal(),
    memory: [
      {
        kind: "decision",
        body: "avoid aggressive diagonal layouts",
        author: "tim",
        source: "cli",
        date: "2026-01-01T00:00:00.000Z",
        channel: "visual",
        polarity: "avoid",
      },
      {
        kind: "learning",
        body: "use conversational tone",
        author: "tim",
        source: "cli",
        date: "2026-01-01T00:00:00.000Z",
        channel: "copy",
      },
      {
        kind: "feedback",
        body: "garish neon",
        author: "tim",
        source: "element-feedback",
        date: "2026-01-01T00:00:00.000Z",
        asset: "brand/directions/moody/discards/thumb.png",
      },
    ],
    references: [],
  });
}

/** Empty assembled context — produces the no-directive path. */
function emptyAssembled(): AssembledContext {
  return assembleContext({
    brief: "",
    global: {
      approvedPointer: null,
      rules: [],
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    memory: [],
    references: [],
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-write-version-"));
  delete process.env.OPENAI_API_KEY; // dry-run: no image attempts
});

afterEach(async () => {
  delete process.env.OPENAI_API_KEY;
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("writeDirectionVersion — WS-03 directive block injection", () => {
  it("directive block lands under the content lock in BOTH written prompt .md files (SC-03/SC-04)", async () => {
    const config = buildTestConfig(tmpDir);
    const directionsDir = directionsRoot(tmpDir, config);
    await createDirection(tmpDir, config, "direction-a");
    const version = makeVersion("v-directive");
    const assembled = buildAssembled();

    const result = await writeDirectionVersion({
      cwd: tmpDir,
      directionsDir,
      directionId: "direction-a",
      version,
      config,
      referenceImagePaths: [],
      assembled,
      skipImages: true,
    });

    const styleMd = await fs.readFile(
      path.join(result.versionDir, "style-tile-prompt.md"),
      "utf-8",
    );
    const homepageMd = await fs.readFile(
      path.join(result.versionDir, "homepage-mockup-prompt.md"),
      "utf-8",
    );

    for (const prompt of [styleMd, homepageMd]) {
      // Content lock present.
      expect(prompt).toContain("CONTENT LOCK");

      // Hard prohibition from global hard rule in MUST — under the content lock.
      const contentIdx = prompt.indexOf("CONTENT LOCK");
      const mustIdx = prompt.indexOf("MUST (non-negotiable — always obey):");
      expect(mustIdx).toBeGreaterThan(contentIdx);
      expect(prompt).toContain("Never use a fist-in-the-air icon");

      // Positive visual guideline in PREFER/DO.
      expect(prompt).toContain("PREFER (do):");
      expect(prompt).toContain("Prefer open airy compositions");

      // Visual-avoid decision in AVOID.
      expect(prompt).toContain("avoid aggressive diagonal layouts");

      // Copy-only learning must NOT appear in image prompts.
      expect(prompt).not.toContain("use conversational tone");
    }
  });

  it("byte-identical no-directive path (SC-11) — empty assembled + no locks ⇒ prompt = base + content lock only", async () => {
    const config = buildTestConfig(tmpDir);
    const directionsDir = directionsRoot(tmpDir, config);
    await createDirection(tmpDir, config, "direction-a");
    const version = makeVersion("v-empty");
    const assembled = emptyAssembled();

    const result = await writeDirectionVersion({
      cwd: tmpDir,
      directionsDir,
      directionId: "direction-a",
      version,
      config,
      referenceImagePaths: [],
      assembled,
      skipImages: true,
    });

    const styleMd = await fs.readFile(
      path.join(result.versionDir, "style-tile-prompt.md"),
      "utf-8",
    );
    // The compiler returned "" so no art tail was appended.
    const expected = `${version.styleTilePrompt}\n\n${composeContentLock(version)}\n`;
    expect(styleMd).toBe(expected);

    const homepageMd = await fs.readFile(
      path.join(result.versionDir, "homepage-mockup-prompt.md"),
      "utf-8",
    );
    const expectedHome = `${version.homepageMockupPrompt}\n\n${composeContentLock(version)}\n`;
    expect(homepageMd).toBe(expectedHome);
  });

  it("dry-run parity (SC-11) — no key + skipImages unset still writes prompt .md files with directive tail and never throws", async () => {
    const config = buildTestConfig(tmpDir);
    const directionsDir = directionsRoot(tmpDir, config);
    await createDirection(tmpDir, config, "direction-a");
    const version = makeVersion("v-dryrun");
    const assembled = buildAssembled();

    // No OPENAI_API_KEY + skipImages omitted → dry-run (no images generated).
    const result = await writeDirectionVersion({
      cwd: tmpDir,
      directionsDir,
      directionId: "direction-a",
      version,
      config,
      referenceImagePaths: [],
      assembled,
    });

    expect(result.extracted).toBe(false);
    expect(result.imageSkips).toHaveLength(0);

    // Both prompt .md files still written with the directive tail.
    const styleMd = await fs.readFile(
      path.join(result.versionDir, "style-tile-prompt.md"),
      "utf-8",
    );
    expect(styleMd).toContain("MUST (non-negotiable — always obey):");
    expect(styleMd).toContain("Never use a fist-in-the-air icon");

    // context-snapshot.md is exactly the supplied contextSnapshot + "\n".
    const contextMd = await fs.readFile(
      path.join(result.versionDir, "context-snapshot.md"),
      "utf-8",
    );
    expect(contextMd).toBe(version.contextSnapshot + "\n");
  });

  it("one-shot art direction IS included in the written prompt file (SC-03 provenance)", async () => {
    const config = buildTestConfig(tmpDir);
    const directionsDir = directionsRoot(tmpDir, config);
    await createDirection(tmpDir, config, "direction-a");

    const result = await writeDirectionVersion({
      cwd: tmpDir,
      directionsDir,
      directionId: "direction-a",
      version: makeVersion("v-oneshot"),
      config,
      referenceImagePaths: [],
      oneShotArtDirection: "make it neon",
      skipImages: true,
    });

    // One-shot now appears in the persisted prompt file (generation provenance).
    const styleMd = await fs.readFile(
      path.join(result.versionDir, "style-tile-prompt.md"),
      "utf-8",
    );
    expect(styleMd).toContain("Additional art direction (this pass only): make it neon");
  });
});

describe("writeDirectionVersion — existing contracts", () => {
  it("writes a version folder + advances the direction record (dry-run, no images)", async () => {
    const config = buildTestConfig(tmpDir);
    const directionsDir = directionsRoot(tmpDir, config);
    await createDirection(tmpDir, config, "direction-a");
    const version = makeVersion("v-one");

    const result = await writeDirectionVersion({
      cwd: tmpDir,
      directionsDir,
      directionId: "direction-a",
      version,
      config,
      referenceImagePaths: [],
    });

    expect(result.versionId).toBe("v-one");
    expect(result.imageSkips).toEqual([]);
    expect(result.extracted).toBe(false);

    const verDir = result.versionDir;
    expect(await exists(path.join(verDir, "direction-version.json"))).toBe(true);
    expect(await exists(path.join(verDir, "brief-snapshot.md"))).toBe(true);
    expect(await exists(path.join(verDir, "context-snapshot.md"))).toBe(true);
    expect(await exists(path.join(verDir, "style-tile-prompt.md"))).toBe(true);
    expect(await exists(path.join(verDir, "homepage-mockup-prompt.md"))).toBe(true);
    // No image attempted in dry-run.
    expect(await exists(path.join(verDir, "style-tile.png"))).toBe(false);

    // Snapshots are the frozen version text.
    expect(
      await fs.readFile(path.join(verDir, "brief-snapshot.md"), "utf-8"),
    ).toBe("A test brief.");

    // The direction record was advanced: versions=[v-one], head=v-one.
    const record = await createDirectionCore(tmpDir, config).get("direction-a");
    expect(record.versions).toEqual(["v-one"]);
    expect(record.head).toBe("v-one");

    // filesWritten are cwd-relative, forward-slash, and none are .png.
    for (const p of result.filesWritten) {
      expect(p).not.toContain("\\");
      expect(p.endsWith(".png")).toBe(false);
    }
  });

  it("extracts tokens from a mocked tile and honors a locked color verbatim", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const openaiModule = await import("../openai.js");
    vi.spyOn(openaiModule, "hasApiKey").mockReturnValue(true);
    const genSpy = vi
      .spyOn(openaiModule, "generateImage")
      .mockResolvedValue({ written: true } as never);

    const READ_COLORS = [
      { hex: "#0e382e", role: "background" },
      { hex: "#fff6e6", role: "text" },
      { hex: "#ff2d8d", role: "primary" },
      { hex: "#5ac8ff", role: "brand" },
    ];
    vi.spyOn(openaiModule, "describeImageBrand").mockResolvedValue({
      read: {
        colors: READ_COLORS,
        type: { printedFamilies: { heading: "Space Grotesk", body: "Inter" } },
      },
      dryRun: false,
    } as never);

    const config = buildTestConfig(tmpDir);
    const directionsDir = directionsRoot(tmpDir, config);
    await createDirection(tmpDir, config, "direction-a");
    const version = makeVersion("v-extract");
    const LOCK = "#3366cc";

    const { tokensFromRoledColors } = await import("../brand/extract-tokens.js");
    const expectedHexes = tokensFromRoledColors(READ_COLORS, {
      locks: [{ hex: LOCK }],
      seed: version.tokens?.provenance?.seed ?? 0,
    }).tokens.palette.map((t) => t.hex);

    const result = await writeDirectionVersion({
      cwd: tmpDir,
      directionsDir,
      directionId: "direction-a",
      version,
      config,
      referenceImagePaths: [],
      lockedColors: [LOCK],
    });

    expect(genSpy).toHaveBeenCalledTimes(2);
    expect(result.extracted).toBe(true);

    const persisted = JSON.parse(
      await fs.readFile(
        path.join(result.versionDir, "direction-version.json"),
        "utf-8",
      ),
    ) as DirectionVersion;
    expect(persisted.tokens!.palette.map((t) => t.hex)).toEqual(expectedHexes);
    expect(persisted.tokens!.typography).toEqual({
      heading: "Space Grotesk",
      body: "Inter",
    });
    const hexes = persisted.tokens!.palette.map((t) => t.hex.toLowerCase());
    expect(hexes).toContain(LOCK);
  });

  it("dry-run parity: direction-version.json is byte-stable across two runs", async () => {
    const config = buildTestConfig(tmpDir);
    const directionsDir = directionsRoot(tmpDir, config);
    await createDirection(tmpDir, config, "direction-a");
    await createDirection(tmpDir, config, "direction-b");

    const one = await writeDirectionVersion({
      cwd: tmpDir,
      directionsDir,
      directionId: "direction-a",
      version: makeVersion("v-fixed"),
      config,
      referenceImagePaths: [],
    });
    const two = await writeDirectionVersion({
      cwd: tmpDir,
      directionsDir,
      directionId: "direction-b",
      version: makeVersion("v-fixed"),
      config,
      referenceImagePaths: [],
    });

    const jsonOne = await fs.readFile(
      path.join(one.versionDir, "direction-version.json"),
      "utf-8",
    );
    const jsonTwo = await fs.readFile(
      path.join(two.versionDir, "direction-version.json"),
      "utf-8",
    );
    expect(jsonOne).toBe(jsonTwo);
  });
});
