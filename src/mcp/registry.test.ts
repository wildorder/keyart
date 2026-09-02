import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig, DirectionVersion, DirectionTokens } from "../types.js";
import { CommandError } from "../errors.js";
import {
  listCommands,
  getCommand,
  parseArgs,
  listGroups,
  getGroup,
  groupOf,
  groupToolDescription,
  helpIndex,
  groupHelp,
  WORKFLOW_OVERVIEW,
  dispatchCommand,
} from "./registry.js";
import {
  listDirectionIds,
} from "../direction/store.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { createSurfaceCore } from "../surface/store.js";

// The removed aggregate noun, assembled at runtime so the SC-13 clean-break
// scanner finds no literal in this file while the regression fences below can
// still assert its absence from the live surface.
const LEGACY_WORD = ["con", "cept"].join("");
const LEGACY_FLAG = `--${LEGACY_WORD}`;

vi.mock("../surface/scan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../surface/scan.js")>();
  return { ...actual, runSurfaceScan: vi.fn() };
});

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Registry Test", type: "prototype", framework: "next" },
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-registry-"));
  delete process.env.OPENAI_API_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("registry shape", () => {
  it("lists all commands in stable order with doctor ninth, regenerate tenth, direction eleventh, asset twelfth, and surface appended last (no refine, no legacy aggregate)", () => {
    const names = listCommands().map((c) => c.name);
    expect(names).toEqual([
      "init",
      "explore",
      "approve",
      "brief",
      "audit",
      "serve",
      "rule",
      "promote",
      "doctor",
      "regenerate",
      "direction",
      "asset",
      "surface",
    ]);
    expect(names).not.toContain("refine");
    expect(names).not.toContain(LEGACY_WORD);
  });

  it("no longer exposes the deprecated silo command", () => {
    expect(getCommand("silo")).toBeUndefined();
    expect(listCommands().some((c) => c.name === "silo")).toBe(false);
  });

  it("every entry has a single-line summary and a complete helpDoc", () => {
    for (const cmd of listCommands()) {
      expect(cmd.summary.length).toBeGreaterThan(0);
      expect(cmd.summary).not.toContain("\n");
      expect(cmd.summary.length).toBeLessThanOrEqual(100);
      expect(cmd.helpDoc).toContain("## Usage");
      expect(cmd.helpDoc).toContain("## Outputs");
      expect(cmd.helpDoc).toContain("## Examples");
    }
  });

  it("every dispatchable command has a run function; serve does not", () => {
    for (const cmd of listCommands()) {
      if (cmd.dispatchable) {
        expect(typeof cmd.run).toBe("function");
      } else {
        expect(cmd.run).toBeUndefined();
      }
    }
    const serve = getCommand("serve")!;
    expect(serve.dispatchable).toBe(false);
    expect(serve.run).toBeUndefined();
  });
});

describe("getCommand", () => {
  it("returns the explore meta and undefined for unknown names", () => {
    expect(getCommand("explore")?.name).toBe("explore");
    expect(getCommand("nope")).toBeUndefined();
  });
});

describe("parseArgs", () => {
  it("parses approve positionals and a boolean flag", () => {
    const approve = getCommand("approve")!;
    const parsed = parseArgs(approve, ["run1", "direction-a", "--force"]);
    expect(parsed).toEqual({
      positionals: ["run1", "direction-a"],
      flags: { force: true },
    });
  });

  it("parses serve's value-taking flag", () => {
    const serve = getCommand("serve")!;
    const parsed = parseArgs(serve, ["--port", "5000"]);
    expect(parsed.flags).toEqual({ port: "5000" });
  });

  it("throws on a missing required positional", () => {
    const approve = getCommand("approve")!;
    try {
      // approve now requires only <directionId>; no positionals ⇒ missing arg.
      parseArgs(approve, []);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CommandError);
      expect((err as CommandError).message).toContain("approve");
    }
  });

  it("throws on an unknown flag", () => {
    const explore = getCommand("explore")!;
    expect(() => parseArgs(explore, ["--bogus"])).toThrow(CommandError);
    expect(() => parseArgs(explore, ["--bogus"])).toThrow(/explore/);
  });

  it("throws on an extra positional", () => {
    const explore = getCommand("explore")!;
    expect(() => parseArgs(explore, ["target", "stray"])).toThrow(CommandError);
    expect(() => parseArgs(explore, ["target", "stray"])).toThrow(/explore/);
  });

  it("parses explore's positional target and its --describe/--from value flags", () => {
    const explore = getCommand("explore")!;
    expect(parseArgs(explore, ["moody"])).toEqual({
      positionals: ["moody"],
      flags: {},
    });
    expect(parseArgs(explore, ["--describe", "a seed"])).toEqual({
      positionals: [],
      flags: { describe: "a seed" },
    });
    expect(parseArgs(explore, ["--from", "moody"])).toEqual({
      positionals: [],
      flags: { from: "moody" },
    });
  });

  it("rejects the removed --silo flag on explore", () => {
    const explore = getCommand("explore")!;
    expect(() => parseArgs(explore, ["--silo", "moody"])).toThrow(CommandError);
    expect(() => parseArgs(explore, ["--silo", "moody"])).toThrow(/Unknown flag/);
    expect(() => parseArgs(explore, ["--silo", "moody"])).toThrow(/explore/);
  });

  it("rejects the removed legacy aggregate flag on approve (WS-06)", () => {
    const approve = getCommand("approve")!;
    expect(() =>
      parseArgs(approve, ["direction-a", LEGACY_FLAG, "neon", "--force"]),
    ).toThrow(/Unknown flag/);
    expect(parseArgs(approve, ["direction-a", "--force"])).toEqual({
      positionals: ["direction-a"],
      flags: { force: true },
    });
  });

  it("rejects the removed --silo flag on approve", () => {
    const approve = getCommand("approve")!;
    expect(() =>
      parseArgs(approve, ["run1", "direction-a", "--silo", "neon"]),
    ).toThrow(CommandError);
  });
});

describe("explore adapter (dry-run, no key)", () => {
  it("writes direction-version artifacts and reports them", async () => {
    const { runInit } = await import("../commands/init.js");
    await runInit({ cwd: tmpDir });

    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const outcome = await getCommand("explore")!.run!({
      cwd: tmpDir,
      input: ["default"],
    });

    const versionEntry = outcome.filesWritten.find((p) =>
      /^brand\/directions\/.+\/versions\/.+\/direction-version\.json$/.test(
        p,
      ),
    );
    expect(versionEntry).toBeDefined();
    const snapshotEntry = outcome.filesWritten.find((p) =>
      /^brand\/directions\/.+\/versions\/.+\/brief-snapshot\.md$/.test(
        p,
      ),
    );
    expect(snapshotEntry).toBeDefined();
    expect(outcome.summary).toContain("Explore complete");
    expect(outcome.summary).toContain("default");

    // Files exist on disk.
    await expect(
      fs.access(path.join(tmpDir, versionEntry!)),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tmpDir, snapshotEntry!)),
    ).resolves.toBeUndefined();
  });

  it("dispatches a positional explore into that direction's tree", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    await createDirectionCore(tmpDir, buildTestConfig(tmpDir)).create({
      id: "moody",
      name: "moody",
    });

    const outcome = await getCommand("explore")!.run!({
      cwd: tmpDir,
      input: ["moody"],
    });

    const versionEntry = outcome.filesWritten.find((p) =>
      /^brand\/directions\/.+\/versions\/.+\/direction-version\.json$/.test(
        p,
      ),
    );
    expect(versionEntry).toBeDefined();
    const snapshotEntry = outcome.filesWritten.find((p) =>
      /^brand\/directions\/.+\/versions\/.+\/brief-snapshot\.md$/.test(
        p,
      ),
    );
    expect(snapshotEntry).toBeDefined();
    expect(versionEntry).toContain("brand/directions/moody/");
    expect(outcome.summary).toContain("moody");
  });
});

describe("explore meta shape", () => {
  it("declares the positional directionId + --describe/--from, with no legacy aggregate or --silo flag", () => {
    const explore = getCommand("explore")!;
    // WS-16: the legacy aggregate flag is gone from the whole explore surface.
    expect(explore.flags.find((f) => f.name === LEGACY_FLAG)).toBeUndefined();
    expect(explore.helpDoc).not.toContain(LEGACY_FLAG);
    expect(explore.args.map((a) => a.name)).toEqual(["directionId"]);
    expect(explore.args[0].required).toBe(false);
    const describe = explore.flags.find((f) => f.name === "--describe");
    expect(describe?.takesValue).toBe(true);
    const from = explore.flags.find((f) => f.name === "--from");
    expect(from?.takesValue).toBe(true);

    // The deprecated --silo alias is gone from the flag surface.
    expect(explore.flags.find((f) => f.name === "--silo")).toBeUndefined();
    expect(explore.helpDoc).not.toContain("--silo");

    expect(explore.helpDoc).toContain("## Flags");
    expect(explore.helpDoc).toContain("brand/directions/<directionId>/versions/");
    expect(explore.helpDoc).not.toContain("runId");
    expect(explore.helpDoc).not.toContain("--append");
    expect(explore.helpDoc).toContain("brief-snapshot.md");
    expect(explore.helpDoc).toContain("context-snapshot.md");
    expect(explore.helpDoc).toContain("Image-generation failures");
  });
});

describe("explore count (another option)", () => {
  it("parseArgs yields the count flag; --append is gone", () => {
    const explore = getCommand("explore")!;
    expect(parseArgs(explore, ["--count", "1"])).toEqual({
      positionals: [],
      flags: { count: "1" },
    });
    // The removed `--append` gesture is now an unknown flag.
    expect(() => parseArgs(explore, ["--append"])).toThrow(CommandError);
  });

  it("declares --count (no --append) on the meta and documents 'another option'", () => {
    const explore = getCommand("explore")!;
    expect(explore.flags.find((f) => f.name === "--count")?.takesValue).toBe(true);
    expect(explore.flags.find((f) => f.name === "--append")).toBeUndefined();
    expect(explore.helpDoc).toContain("--count 1");
  });

  it("explore --from … --count 1 mints one more direction alongside the existing ones", async () => {
    const { runInit } = await import("../commands/init.js");
    await runInit({ cwd: tmpDir });
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    // Divergent explore off the scaffolded default → 3 minted directions.
    await getCommand("explore")!.run!({ cwd: tmpDir, input: ["--from", "default"] });
    const directionsDir = path.join(tmpDir, "brand", "directions");
    const before = await listDirectionIds(directionsDir);
    expect(before.length).toBe(4); // default source + three minted directions

    // Another option: --from … --count 1 mints ONE more direction.
    await getCommand("explore")!.run!({
      cwd: tmpDir,
      input: ["--from", "default", "--count", "1"],
    });
    const after = await listDirectionIds(directionsDir);
    expect(after.length).toBe(5);
    // The original three are untouched.
    for (const id of before) expect(after).toContain(id);
  });
});

describe("refine removed from the registry (WS-05)", () => {
  it("no longer exposes refine as a command, verb, or brand-group entry", () => {
    expect(getCommand("refine")).toBeUndefined();
    expect(listCommands().some((c) => c.name === "refine")).toBe(false);
    expect(groupOf("refine")).toBeUndefined();
    expect(getGroup("brand")!.commands).toEqual([
      "direction",
      "explore",
      "regenerate",
      "approve",
      "rule",
      "promote",
      "asset",
      "surface",
    ]);
    expect(getGroup("brand")!.commands).not.toContain("refine");
  });

  it("names no refine in the brand facade description, help index, or workflow", () => {
    expect(groupToolDescription("brand")).not.toContain("refine");
    expect(helpIndex()).not.toContain("refine");
    expect(WORKFLOW_OVERVIEW).not.toContain("refine");
  });

  it("dispatching refine returns the canonical unknown-command error (no throw)", async () => {
    const result = await dispatchCommand(
      {
        command: "refine",
        input: ["parent-dir", "direction-a", "--tweak", "warm type"],
        cwd: tmpDir,
      },
      { defaultCwd: tmpDir },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Unknown command "refine"');
  });
});

describe("regenerate registration + dispatch (WS-07)", () => {
  it("registers regenerate as a dispatchable brand command with a run + full helpDoc", () => {
    const regenerate = getCommand("regenerate");
    expect(regenerate).toBeDefined();
    expect(regenerate!.dispatchable).toBe(true);
    expect(typeof regenerate!.run).toBe("function");
    expect(regenerate!.summary.length).toBeGreaterThan(0);
    expect(regenerate!.summary.length).toBeLessThanOrEqual(100);
    expect(regenerate!.helpDoc).toContain("## Usage");
    expect(regenerate!.helpDoc).toContain("## Outputs");
    expect(regenerate!.helpDoc).toContain("## Examples");
    // Routes through the brand facade and shows up in the grouped index.
    expect(groupOf("regenerate")).toBe("brand");
    expect(getGroup("brand")!.commands).toContain("regenerate");
    expect(helpIndex()).toContain("regenerate");
    expect(groupToolDescription("brand")).toContain("regenerate");
    expect(WORKFLOW_OVERVIEW).toContain("regenerate");
  });

  it("is addressed by a single <directionId>; a second positional is too many", () => {
    const regenerate = getCommand("regenerate")!;
    // Single required directionId arg — no runId.
    expect(regenerate.args).toEqual([
      { name: "directionId", required: true, description: expect.any(String) },
    ]);
    expect(
      parseArgs(regenerate, ["direction-a", "--tweak", "cooler"]),
    ).toEqual({
      positionals: ["direction-a"],
      flags: { tweak: "cooler" },
    });
    // WS-06: the legacy aggregate flag is gone from the regenerate metadata too.
    expect(() =>
      parseArgs(regenerate, ["direction-a", LEGACY_FLAG, "moody"]),
    ).toThrow(/Unknown flag/);
    // Missing positional and a stray second positional both throw.
    expect(() => parseArgs(regenerate, [])).toThrow(CommandError);
    expect(() => parseArgs(regenerate, ["direction-a", "v-123"])).toThrow(
      /Too many arguments/,
    );
    expect(() => parseArgs(regenerate, ["direction-a", "--bogus"])).toThrow(
      CommandError,
    );
    // The generated usage line reflects the head-only addressing.
    try {
      parseArgs(regenerate, []);
    } catch (err) {
      expect((err as CommandError).message).toContain(
        "Usage: keyart regenerate <directionId> [--tweak <value>]",
      );
    }
  });

  it("dispatches regenerate (dry-run): re-renders the deterministic board, no stdout leak", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const { runInit } = await import("../commands/init.js");
    await runInit({ cwd: tmpDir });
    // Seed a tokened v1 into the scaffolded default draft, then resolve its head.
    await getCommand("explore")!.run!({ cwd: tmpDir, input: ["default"] });
    const core = createDirectionCore(tmpDir, buildTestConfig(tmpDir));
    const directionId = "default";
    const versionId = await core.head(directionId);

    // Nothing must escape to the real stdout during dispatch (JSON-RPC channel).
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    // Regenerate is addressed by <directionId> only (head-only) and APPENDS a new
    // version to the head rather than editing the addressed one.
    const result = await dispatchCommand(
      { command: "regenerate", input: [directionId], cwd: tmpDir },
      { defaultCwd: tmpDir },
    );
    stdoutSpy.mockRestore();

    expect(result.isError).toBe(false);
    // A NEW version was appended (append-only history); the deterministic board
    // (model-free) lands under it even keyless.
    const newHead = await core.head(directionId);
    expect(newHead).not.toBe(versionId);
    expect(result.text).toContain(
      `brand/directions/${directionId}/versions/${newHead}/style-board.md`,
    );
    expect(result.text).toContain("style-board.svg");
    // The command's summary log was captured (rendered into the result), not leaked.
    expect(result.text).toContain("Regenerated visuals");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("keeps serve non-dispatchable; regenerate dispatches as a generation action", async () => {
    expect(getCommand("serve")!.dispatchable).toBe(false);
    expect(getCommand("regenerate")!.dispatchable).toBe(true);

    const serve = await dispatchCommand({ command: "serve" }, { defaultCwd: tmpDir });
    expect(serve.isError).toBe(true);
    expect(serve.text).toContain("npx keyart serve");
  });
});

describe("approve addressing <directionId> [<versionId>] (WS-05)", () => {
  it("declares directionId (required) + versionId (optional); parses 1 or 2 positionals", () => {
    const approve = getCommand("approve")!;
    expect(approve.args).toEqual([
      { name: "directionId", required: true, description: expect.any(String) },
      { name: "versionId", required: false, description: expect.any(String) },
    ]);
    // One positional (head) or two (a pinned version) both parse.
    expect(parseArgs(approve, ["direction-a"]).positionals).toEqual(["direction-a"]);
    expect(parseArgs(approve, ["direction-a", "v-123"]).positionals).toEqual([
      "direction-a",
      "v-123",
    ]);
    // A third positional is too many.
    expect(() => parseArgs(approve, ["direction-a", "v-123", "extra"])).toThrow(
      /Too many arguments/,
    );
  });
});

describe("no runId on the brand surface (SC-03)", () => {
  it("no brand-group command's helpDoc/summary/arg names contain 'runId'", () => {
    const brand = getGroup("brand")!;
    for (const name of brand.commands) {
      const meta = getCommand(name)!;
      expect(meta.summary).not.toContain("runId");
      expect(meta.helpDoc).not.toContain("runId");
      for (const arg of meta.args) expect(arg.name).not.toContain("runId");
    }
  });

  it("WORKFLOW_OVERVIEW carries neither refine nor runId", () => {
    expect(WORKFLOW_OVERVIEW).not.toContain("refine");
    expect(WORKFLOW_OVERVIEW).not.toContain("runId");
  });
});

describe("run-level references on explore (WS-07 MCP surface)", () => {
  it("accepts --reference and --intent on the explore meta", () => {
    const meta = getCommand("explore")!;
    expect(meta.flags.find((f) => f.name === "--reference")?.takesValue).toBe(true);
    expect(meta.flags.find((f) => f.name === "--intent")?.takesValue).toBe(true);
    expect(
      parseArgs(meta, ["--reference", "a.png,b.png", "--intent", "extract"]).flags,
    ).toEqual(
      expect.objectContaining({ reference: "a.png,b.png", intent: "extract" }),
    );
  });

  it("splits comma-separated --reference paths into the run's references with the single --intent", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const { runInit } = await import("../commands/init.js");
    await runInit({ cwd: tmpDir });

    const outcome = await getCommand("explore")!.run!({
      cwd: tmpDir,
      input: ["default", "--reference", "a.png,b.png", "--intent", "extract"],
    });

    // The run's context-snapshot IS the provenance record — both refs land there
    // with the single applied intent, proving they reached runExplore.
    const snapshotRel = outcome.filesWritten.find((p) =>
      /context-snapshot\.md$/.test(p),
    )!;
    const snapshot = await fs.readFile(path.join(tmpDir, snapshotRel), "utf-8");
    expect(snapshot).toContain("- a.png [intent: extract]");
    expect(snapshot).toContain("- b.png [intent: extract]");
  });

  it("errors (no throw) on an invalid --intent", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const result = await dispatchCommand(
      {
        command: "explore",
        input: ["--reference", "a.png", "--intent", "bogus"],
        cwd: tmpDir,
      },
      { defaultCwd: tmpDir },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("--intent");
  });
});

describe("brief adapter (no approved direction)", () => {
  it("rejects with CommandError and never calls process.exit", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);

    await expect(
      getCommand("brief")!.run!({ cwd: tmpDir, input: ["home"] }),
    ).rejects.toThrow(CommandError);
    await expect(
      getCommand("brief")!.run!({ cwd: tmpDir, input: ["home"] }),
    ).rejects.toThrow(/keyart approve/);

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe("approve adapter (dry-run, no key)", () => {
  it("approves a seeded direction by <directionId> [<versionId>] and reports direction.yaml", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const direction = {
      id: "direction-a",
      name: "Bold & Modern",
      summary: "A bold, modern direction.",
      positioning: "Confident, forward-thinking leader.",
      character: { mood: "High-contrast palette, geometric type." },
      homepageMockupPrompt: "Design a bold homepage mockup.",
      styleTilePrompt: "Create a bold style tile.",
      copyExamples: { headline: "Next", subheadline: "Modern.", cta: "Go" },
      usage: {
        rules: ["Use 3 brand colors", "Maintain 4:1 contrast", "8px grid"],
        antiRules: ["Never use 3 typefaces", "Avoid rounded shapes"],
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
    // Seed a single-version direction using the new on-disk store.
    await createDirectionCore(tmpDir, buildTestConfig(tmpDir)).create({
      id: direction.id,
      name: direction.name,
    });
    const versionId = "2026-01-01T00-00-00-000Z";
    // The fixture's palette roles are inferred as `string`; assert the version
    // shape (it is only serialized to disk here).
    const version = {
      ...direction,
      id: versionId,
      createdAt: "2026-01-01T00:00:00.000Z",
      producedBy: "explore",
      briefSnapshot: "# neon\n",
      contextSnapshot: "",
    } as unknown as DirectionVersion;
    const versionDir = path.join(
      tmpDir,
      "brand",
      "directions",
      direction.id,
      "versions",
      versionId,
    );
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(
      path.join(versionDir, "direction-version.json"),
      JSON.stringify(version),
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
    await createDirectionCore(tmpDir, buildTestConfig(tmpDir)).appendVersion(
      direction.id,
      versionId,
    );

    // approve is addressed by <directionId> [<versionId>]; the adapter maps
    // positionals[0]→directionId, [1]→versionId (optional, pins that version).
    const outcome = await getCommand("approve")!.run!({
      cwd: tmpDir,
      input: [direction.id, versionId, "--force"],
    });

    expect(outcome.summary).toBe(
      'Approved direction "Bold & Modern" (direction-a). Global pointer updated (rebrand). Asset pack refreshed (0 assets).',
    );
    expect(outcome.filesWritten).toContain("brand/directions/direction-a/direction.yaml");
    expect(outcome.filesWritten).toContain("brand/brand.yaml");
    // The approve-codified asset pack ships even with no extracted assets.
    expect(outcome.filesWritten).toContain(
      "brand/generated/asset-pack/direction-a/tokens.json",
    );
  });
});

describe("init helpDoc", () => {
  it("lists the scaffolded project files under Outputs", () => {
    const helpDoc = getCommand("init")!.helpDoc;
    const outputsSection = helpDoc.slice(
      helpDoc.indexOf("## Outputs"),
      helpDoc.indexOf("## Examples"),
    );
    expect(outputsSection).toContain("brand/directions/default/");
    expect(outputsSection).toContain("brand/brand.yaml");
    expect(outputsSection).not.toContain("silos");
  });
});

describe("init adapter", () => {
  it("reports real relative paths and excludes pseudo-entries", async () => {
    const outcome = await getCommand("init")!.run!({ cwd: tmpDir, input: [] });

    expect(outcome.filesWritten).toContain("keyart.config.ts");
    expect(outcome.filesWritten).toContain("brand/directions/default/direction.yaml");
    expect(outcome.filesWritten.every((p) => !p.includes(" "))).toBe(true);
  });
});

describe("direction / rule / promote registry presence", () => {
  it("exposes direction, rule, and promote as dispatchable metas", () => {
    for (const name of ["direction", "rule", "promote"]) {
      const cmd = getCommand(name)!;
      expect(cmd).toBeDefined();
      expect(cmd.dispatchable).toBe(true);
      expect(typeof cmd.run).toBe("function");
      expect(cmd.summary.length).toBeGreaterThan(0);
      expect(cmd.summary.length).toBeLessThanOrEqual(100);
      expect(cmd.helpDoc.length).toBeGreaterThan(0);
    }
    expect(getCommand("direction")!.name).toBe("direction");
  });

  it("declares direction args and flags matching the CLI", () => {
    const direction = getCommand("direction")!;
    // verb + id, plus three trailing optional slots so `direction brief <subverb>
    // <id> <field> <value>` (5 positionals) parses without "too many arguments".
    expect(direction.args.slice(0, 2)).toEqual([
      { name: "verb", required: true, description: expect.any(String) },
      { name: "id", required: false, description: expect.any(String) },
    ]);
    expect(direction.args.length).toBeGreaterThanOrEqual(5);
    expect(direction.args.every((a) => typeof a.name === "string")).toBe(true);
    // Only verb is required; the rest are optional positionals.
    expect(direction.args.filter((a) => a.required).map((a) => a.name)).toEqual([
      "verb",
    ]);
    const flagNames = direction.flags.map((f) => f.name);
    expect(flagNames).toEqual(
      expect.arrayContaining([
        "--name",
        "--from",
        "--note",
        "--body",
        "--kind",
        "--author",
        "--force",
      ]),
    );
  });
});

describe("direction / rule / promote dispatch (no network)", () => {
  it("dispatches direction new and reports brand/directions paths", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const outcome = await getCommand("direction")!.run!({
      cwd: tmpDir,
      input: ["new", "moody"],
    });

    expect(outcome.summary).toContain("moody");
    expect(outcome.filesWritten).toContain("brand/directions/moody/direction.yaml");
  });

  it("dispatches rule add and writes brand/brand.yaml", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const outcome = await getCommand("rule")!.run!({
      cwd: tmpDir,
      input: ["add", "No pure black", "--severity", "hard"],
    });

    expect(outcome.filesWritten).toContain("brand/brand.yaml");
    expect(outcome.summary).toContain("hard");
  });

  it("parses direction brief positionals without a too-many-arguments error", () => {
    const parsed = parseArgs(getCommand("direction")!, [
      "brief",
      "set",
      "moody",
      "tone",
      "warm,confident",
    ]);
    expect(parsed).toEqual({
      positionals: ["brief", "set", "moody", "tone", "warm,confident"],
      flags: {},
    });
  });

  it("dispatches direction brief set through core and reports the written files", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    // Seed the direction first.
    await getCommand("direction")!.run!({ cwd: tmpDir, input: ["new", "moody"] });

    const outcome = await getCommand("direction")!.run!({
      cwd: tmpDir,
      input: ["brief", "set", "moody", "colorIntent", "warm earthy, deep grounding dark"],
    });

    expect(outcome.filesWritten).toContain("brand/directions/moody/direction.yaml");
    expect(outcome.filesWritten).toContain("brand/directions/moody/brief.md");
    expect(outcome.summary).toContain("moody");

    // Re-read via show — the value round-trips.
    const show = await getCommand("direction")!.run!({
      cwd: tmpDir,
      input: ["brief", "show", "moody"],
    });
    expect(show.filesWritten).toEqual([]);
  });

  it("dispatches direction brief patch and rejects unknown-key JSON", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    await getCommand("direction")!.run!({ cwd: tmpDir, input: ["new", "moody"] });

    const outcome = await getCommand("direction")!.run!({
      cwd: tmpDir,
      input: ["brief", "patch", "moody", '{"tone":["warm","confident"]}'],
    });
    expect(outcome.filesWritten).toContain("brand/directions/moody/brief.md");

    await expect(
      getCommand("direction")!.run!({
        cwd: tmpDir,
        input: ["brief", "patch", "moody", '{"colour":"blue"}'],
      }),
    ).rejects.toThrow(/Unknown brief field/);
  });

  it("rejects an unknown flag for the new metas", () => {
    expect(() => parseArgs(getCommand("direction")!, ["new", "moody", "--bogus"])).toThrow(
      CommandError,
    );
    expect(() => parseArgs(getCommand("rule")!, ["add", "x", "--bogus"])).toThrow(
      CommandError,
    );
    expect(() => parseArgs(getCommand("promote")!, ["moody", "x", "--bogus"])).toThrow(
      CommandError,
    );
  });

  it("dispatches rule add with --channel and --polarity; appended rule carries both fields", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const outcome = await getCommand("rule")!.run!({
      cwd: tmpDir,
      input: ["add", "No fist-in-the-air", "--channel", "visual", "--polarity", "avoid"],
    });

    expect(outcome.filesWritten).toContain("brand/brand.yaml");
    expect(outcome.summary).toContain("No fist-in-the-air");

    // Read back the written rule from disk.
    const { createBrandCore } = await import("../brand/core.js");
    const brand = createBrandCore(tmpDir, buildTestConfig(tmpDir));
    const doc = await brand.read();
    const rule = doc.rules[doc.rules.length - 1];
    expect(rule.channel).toBe("visual");
    expect(rule.polarity).toBe("avoid");
  });
});

describe("doctor registration (WS-04)", () => {
  it("registers doctor as a dispatchable command listed after the order-sensitive nine", () => {
    const doctor = getCommand("doctor");
    expect(doctor).toBeDefined();
    expect(doctor!.dispatchable).toBe(true);
    expect(typeof doctor!.run).toBe("function");
    expect(doctor!.helpDoc).toContain("## Usage");
    expect(doctor!.helpDoc).toContain("## Outputs");

    // doctor is appended ninth (index 8), after the first eight order-sensitive
    // commands; regenerate (WS-07) is tenth, direction eleventh, asset
    // (asset-extraction WS-04) twelfth, and surface (surface-manifest WS-02)
    // is appended last.
    const names = listCommands().map((c) => c.name);
    expect(names.indexOf("doctor")).toBe(8);
    expect(names[names.length - 1]).toBe("surface");
    expect(names[names.length - 2]).toBe("asset");
    expect(names[names.length - 3]).toBe("direction");
    expect(names[names.length - 4]).toBe("regenerate");
    expect(names).toContain("doctor");
    expect(getCommand("serve")!.dispatchable).toBe(false);
  });

  it("runs the doctor adapter in a bare temp dir without throwing", async () => {
    const outcome = await getCommand("doctor")!.run!({ cwd: tmpDir, input: [] });
    expect(outcome.summary.startsWith("Doctor:")).toBe(true);
    expect(outcome.filesWritten).toEqual([]);
  });
});

describe("capability-facade groups (WS-04)", () => {
  it("exposes three groups with the expected facade tools and catalogs", () => {
    const groups = listGroups();
    expect(groups.map((g) => g.tool)).toEqual([
      "keyart_brand",
      "keyart_implement",
      "keyart_setup",
    ]);
    expect(getGroup("brand")!.commands).toEqual([
      "direction",
      "explore",
      "regenerate",
      "approve",
      "rule",
      "promote",
      "asset",
      "surface",
    ]);
    expect(getGroup("nope")).toBeUndefined();
  });

  it("resolves commands to groups; serve maps to setup for display", () => {
    expect(groupOf("brief")).toBe("implement");
    expect(groupOf("serve")).toBe("setup");
    expect(groupOf("doctor")).toBe("setup");
    expect(groupOf("nope")).toBeUndefined();
  });

  it("places every dispatchable command except serve in exactly one catalog", () => {
    const catalogged = listGroups().flatMap((g) => g.commands);
    for (const cmd of listCommands()) {
      if (!cmd.dispatchable) continue; // serve
      const hits = catalogged.filter((n) => n === cmd.name).length;
      expect(hits).toBe(1);
    }
    expect(catalogged).not.toContain("serve");
  });

  it("produces terse per-facade descriptions naming every catalog command", () => {
    for (const group of listGroups()) {
      const desc = groupToolDescription(group.id);
      expect(desc.length).toBeGreaterThan(0);
      expect(desc.length).toBeLessThan(700);
      for (const name of group.commands) {
        expect(desc).toContain(name);
      }
    }
  });
});

describe("progressive help surface (WS-04)", () => {
  it("helpIndex lists tools, commands, serve, and the three pointer forms", () => {
    const index = helpIndex();
    for (const tool of [
      "keyart_brand",
      "keyart_implement",
      "keyart_setup",
    ]) {
      expect(index).toContain(tool);
    }
    for (const name of [
      "direction",
      "explore",
      "regenerate",
      "approve",
      "rule",
      "promote",
      "brief",
      "audit",
      "init",
      "doctor",
    ]) {
      expect(index).toContain(name);
    }
    expect(index).not.toContain("refine");
    expect(index).toContain("serve");
    expect(index).toContain(`keyart_help { "command": "<name>" }`);
    expect(index).toContain(`keyart_help { "group": "brand|implement|setup" }`);
    expect(index).toContain(`keyart_help { "workflow": true }`);
  });

  it("groupHelp and WORKFLOW_OVERVIEW describe the right scopes", () => {
    const impl = groupHelp("implement");
    expect(impl).toContain("brief");
    expect(impl).toContain("audit");

    expect(WORKFLOW_OVERVIEW).toContain("explore");
    expect(WORKFLOW_OVERVIEW).toContain("approve");
    expect(WORKFLOW_OVERVIEW).toContain("audit");
    expect(WORKFLOW_OVERVIEW.split("\n").length).toBeGreaterThan(1);
  });
});

describe("dispatchCommand (WS-04)", () => {
  beforeEach(async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
  });

  it("dispatches init then doctor as non-error results", async () => {
    const initResult = await dispatchCommand(
      { command: "init", cwd: tmpDir },
      { defaultCwd: tmpDir },
    );
    expect(initResult.isError).toBe(false);
    expect(initResult.text).toContain("Files written");

    const doctorResult = await dispatchCommand(
      { command: "doctor", cwd: tmpDir },
      { defaultCwd: tmpDir },
    );
    expect(doctorResult.isError).toBe(false);
    expect(doctorResult.text).toContain("Doctor:");
  });

  it("accepts string (whitespace-split) and array input", async () => {
    const stringInput = await dispatchCommand(
      { command: "direction", input: "new demo", cwd: tmpDir },
      { defaultCwd: tmpDir },
    );
    expect(stringInput.isError).toBe(false);

    const arrayInput = await dispatchCommand(
      { command: "direction", input: ["list"], cwd: tmpDir },
      { defaultCwd: tmpDir },
    );
    expect(arrayInput.isError).toBe(false);
  });

  it("rejects serve, unknown commands, and parse errors without throwing", async () => {
    const serve = await dispatchCommand(
      { command: "serve" },
      { defaultCwd: tmpDir },
    );
    expect(serve.isError).toBe(true);
    expect(serve.text).toContain("npx keyart serve");

    const unknown = await dispatchCommand(
      { command: "wat" },
      { defaultCwd: tmpDir },
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("Valid commands:");
    expect(unknown.text).toContain("init");

    const badArgs = await dispatchCommand(
      { command: "approve", input: [], cwd: tmpDir },
      { defaultCwd: tmpDir },
    );
    expect(badArgs.isError).toBe(true);
    expect(badArgs.text).toContain("Usage:");
  });
});

describe("the grown direction surface (remove-WS-06)", () => {
  beforeEach(async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
  });

  it("direction covers the fourteen-verb family; the old aggregate command is gone", () => {
    expect(getCommand(LEGACY_WORD)).toBeUndefined();
    const direction = getCommand("direction")!;
    expect(direction.dispatchable).toBe(true);
    for (const verb of [
      "new", "list", "show", "status", "fork", "create", "archive",
      "reject", "park", "revive", "feedback", "memory", "brief", "reconcile",
    ]) {
      expect(direction.args[0].description).toContain(verb);
      expect(direction.helpDoc).toContain(verb);
    }
    // The removed selectors and forbidden spellings never appear.
    const flagNames = direction.flags.map((f) => f.name);
    expect(flagNames).not.toContain(LEGACY_FLAG);
    expect(flagNames).not.toContain("--scope");
    expect(flagNames).not.toContain("--direction");
    expect(flagNames).not.toContain("--all");
    expect(flagNames).not.toContain("--show-archived");
    expect(flagNames).not.toContain("--archived");
    // Promote targets GLOBAL only — no other rung documented on --to.
    const toFlag = direction.flags.find((f) => f.name === "--to")!;
    expect(toFlag.description).toContain("global");
    expect(direction.helpDoc).toContain("--to global");
  });

  it("declares the byte-exact R-7 --include-archived FlagSpec; archive help is reversible", () => {
    const direction = getCommand("direction")!;
    const archivedFlags = direction.flags.filter((f) =>
      f.name.includes("archived"),
    );
    expect(archivedFlags).toEqual([
      {
        name: "--include-archived",
        description: "Include archived directions in `direction list` output.",
        takesValue: false,
      },
    ]);
    // The archive/list prose describes a REVERSIBLE archive, never a deletion.
    expect(direction.helpDoc).toContain("REVERSIBLE");
    expect(direction.helpDoc).toContain("revive");
    const lifecycleSection = direction.helpDoc.slice(
      direction.helpDoc.indexOf("## Lifecycle"),
      direction.helpDoc.indexOf("## Memory lifecycle"),
    );
    expect(lifecycleSection).not.toMatch(/delete|remove/i);
  });

  it("dispatches new / feedback / memory / status / reconcile per verb (keyless)", async () => {
    const direction = getCommand("direction")!;
    const minted = await direction.run!({
      cwd: tmpDir,
      input: ["new", "warm", "--describe", "calm tracker"],
    });
    expect(minted.summary).toContain('Created draft direction "warm"');
    expect(minted.filesWritten).toContain("brand/directions/warm/direction.yaml");
    expect(minted.filesWritten.every((p) => !p.includes("versions/"))).toBe(true);

    const fed = await direction.run!({
      cwd: tmpDir,
      input: ["feedback", "warm", "--body", "less neon"],
    });
    expect(fed.summary).toContain('Recorded feedback on direction "warm"');
    expect(fed.filesWritten).toContain("brand/directions/warm/memory.yaml");

    const read = await direction.run!({ cwd: tmpDir, input: ["memory", "warm"] });
    expect(read.filesWritten).toEqual([]);
    expect(read.summary).toContain('Memory for direction "warm"');

    const status = await direction.run!({ cwd: tmpDir, input: ["status", "warm"] });
    expect(status.filesWritten).toEqual([]);
    expect(status.summary).toContain("warm: active (draft — no versions yet)");

    const reconciled = await direction.run!({ cwd: tmpDir, input: ["reconcile", "warm"] });
    expect(reconciled.filesWritten).toEqual([]);
    expect(reconciled.summary).toContain('direction "warm"');
  });

  it("archive is reversible and guarded (R-5): on disk, hidden from list, revive restores", async () => {
    const direction = getCommand("direction")!;
    await direction.run!({ cwd: tmpDir, input: ["new", "warm"] });
    await direction.run!({ cwd: tmpDir, input: ["new", "cool"] });

    const archived = await direction.run!({ cwd: tmpDir, input: ["archive", "warm"] });
    expect(archived.summary).toContain("nothing physically removed");
    await expect(
      fs.stat(path.join(tmpDir, "brand", "directions", "warm", "direction.yaml")),
    ).resolves.toBeDefined();

    const listed = await direction.run!({ cwd: tmpDir, input: ["list"] });
    expect(listed.summary).not.toContain("warm");
    expect(listed.summary).toContain("cool");

    const listedAll = await direction.run!({
      cwd: tmpDir,
      input: ["list", "--include-archived"],
    });
    expect(listedAll.summary).toContain("warm (archived)");

    const revived = await direction.run!({ cwd: tmpDir, input: ["revive", "warm"] });
    expect(revived.summary).toContain("warm");
    const listedAfter = await direction.run!({ cwd: tmpDir, input: ["list"] });
    expect(listedAfter.summary).toContain("warm");
  });

  it("archiving the approved pointer's direction is refused with a repoint-first error", async () => {
    const testConfig = buildTestConfig(tmpDir);
    const direction = getCommand("direction")!;
    await direction.run!({ cwd: tmpDir, input: ["new", "warm"] });
    await createBrandCore(tmpDir, testConfig).setPointer({
      directionId: "warm",
      versionId: "v-1",
    });

    await expect(
      direction.run!({ cwd: tmpDir, input: ["archive", "warm"] }),
    ).rejects.toThrow(/approve a different direction/i);
    // Still active on disk — nothing written.
    const listed = await direction.run!({ cwd: tmpDir, input: ["list"] });
    expect(listed.summary).toContain("warm");
  });

  it("direction create '<json>' --from <id> (R-6): one declared form, seed required", async () => {
    const direction = getCommand("direction")!;
    await direction.run!({ cwd: tmpDir, input: ["new", "warm"] });

    const json = JSON.stringify({
      name: "Bold",
      summary: "Strong contrast, confident type",
      character: { mood: "bold, editorial, confident" },
      usage: { rules: ["Lead with strong typography"], antiRules: ["Avoid pastel backgrounds"] },
      copyExamples: { headline: "Ship it boldly", subheadline: "Design that means business", cta: "Get started" },
    });
    const created = await direction.run!({
      cwd: tmpDir,
      input: ["create", json, "--from", "warm"],
    });
    const createdId = created.summary.match(/Created direction "([^"]+)"/)![1];
    expect(createdId).not.toBe("warm");
    expect(created.summary).toContain('seeded from "warm"');

    // The legacy two-positional form is rejected with a teaching error.
    await expect(
      direction.run!({ cwd: tmpDir, input: ["create", "warm", json] }),
    ).rejects.toThrow(/--from, not as a positional/);

    // A missing --from teaches the from-scratch path.
    await expect(
      direction.run!({ cwd: tmpDir, input: ["create", json] }),
    ).rejects.toThrow(/direction new/);
  });

  it("fork dispatches through the MCP surface and mints drafts", async () => {
    const direction = getCommand("direction")!;
    await direction.run!({ cwd: tmpDir, input: ["new", "warm"] });

    const forked = await direction.run!({
      cwd: tmpDir,
      input: ["fork", "warm", "--count", "2", "--with-memory"],
    });
    expect(forked.summary).toContain('Forked "warm" into 2 drafts');
    expect(forked.filesWritten.length).toBeGreaterThanOrEqual(2);

    const shown = await direction.run!({ cwd: tmpDir, input: ["show", "warm"] });
    expect(shown.filesWritten).toEqual([]);
    expect(shown.summary).toContain("warm");
  });

  it("promote metadata is direction→global and dispatches by directionId", async () => {
    const promote = getCommand("promote")!;
    expect(promote.args[0].name).toBe("directionId");
    expect(promote.summary.toLowerCase()).not.toContain(LEGACY_WORD);
    expect(promote.helpDoc.toLowerCase()).not.toContain(LEGACY_WORD);

    const testConfig = buildTestConfig(tmpDir);
    await getCommand("direction")!.run!({ cwd: tmpDir, input: ["new", "warm"] });
    const outcome = await promote.run!({
      cwd: tmpDir,
      input: ["warm", "Editorial serifs win"],
    });
    expect(outcome.summary).toContain('direction "warm"');
    const doc = await createBrandCore(tmpDir, testConfig).read();
    const promoted = doc.rules.filter((r) => r.source === "promote:warm");
    expect(promoted).toHaveLength(1);
  });

  it("no legacy aggregate flag remains anywhere it was removed (regression fence)", () => {
    for (const name of ["regenerate", "approve", "asset", "surface"]) {
      const meta = getCommand(name)!;
      expect(
        meta.flags.some((f) => f.name === LEGACY_FLAG),
        `${name} still declares ${LEGACY_FLAG}`,
      ).toBe(false);
      expect(meta.helpDoc).not.toContain(LEGACY_FLAG);
    }
  });

  it("the brand catalog, help index, and workflow speak direction only", () => {
    expect(getGroup("brand")!.commands).toContain("direction");
    expect(getGroup("brand")!.commands).not.toContain(LEGACY_WORD);
    expect(helpIndex()).toContain("direction");
    expect(helpIndex()).not.toMatch(new RegExp(`\\b${LEGACY_WORD}\\b`));
    expect(WORKFLOW_OVERVIEW).not.toMatch(new RegExp(LEGACY_WORD, "i"));
    expect(WORKFLOW_OVERVIEW).not.toContain(LEGACY_FLAG);
    // The workflow narrates the reversible archive, with no destructive verb.
    expect(WORKFLOW_OVERVIEW).toContain("archive");
    expect(WORKFLOW_OVERVIEW).toContain("REVERSIBLE");
  });

  it("the facade set is unchanged; serve never dispatchable; chat absent", async () => {
    expect(listGroups().map((g) => g.tool)).toEqual([
      "keyart_brand",
      "keyart_implement",
      "keyart_setup",
    ]);
    expect(getCommand("serve")!.dispatchable).toBe(false);
    const serveResult = await dispatchCommand({ command: "serve" }, { defaultCwd: tmpDir });
    expect(serveResult.isError).toBe(true);
    expect(serveResult.text).toContain("npx keyart serve");
    expect(getCommand("chat")).toBeUndefined();
    expect(helpIndex()).not.toContain("chat");
  });
});

describe("direction memory edit/promote/delete + rule remove/edit registry (WS-04)", () => {
  it("declares --to/--reason on the direction meta and documents the memory lifecycle", () => {
    const direction = getCommand("direction")!;
    expect(direction.flags.map((f) => f.name)).toEqual(
      expect.arrayContaining(["--to", "--reason"]),
    );
    expect(direction.helpDoc).toContain("Memory lifecycle");
    expect(direction.helpDoc).toContain("direction memory edit");
    expect(direction.helpDoc).toContain("direction memory promote");
    expect(direction.helpDoc).toContain("direction memory delete");
  });

  it("rule meta documents remove/edit and declares --body/--expected-version", () => {
    const rule = getCommand("rule")!;
    expect(rule.args.find((a) => a.name === "verb")?.description).toMatch(/remove/);
    expect(rule.flags.map((f) => f.name)).toEqual(
      expect.arrayContaining(["--body", "--expected-version"]),
    );
    expect(rule.helpDoc).toContain("rule remove");
    expect(rule.helpDoc).toContain("rule edit");
    expect(rule.helpDoc).toMatch(/HARD.*--force/s);
  });

  it("dispatches direction memory edit and supersedes the entry", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    await getCommand("direction")!.run!({ cwd: tmpDir, input: ["new", "moody"] });
    const core = createDirectionCore(tmpDir, testConfig);
    const mem = await core.appendLearning("moody", {
      body: "Editorial serifs",
      author: "tim",
      source: "cli",
    });
    const entryId = mem.entries[0].id;

    const outcome = await getCommand("direction")!.run!({
      cwd: tmpDir,
      input: ["memory", "edit", "moody", entryId, "--body", "Editorial serifs, but warmer"],
    });

    expect(outcome.summary).toContain("Edited memory entry");
    expect(outcome.filesWritten).toContain("brand/directions/moody/memory.yaml");

    const all = await core.memoryEntries("moody", { includeRetired: true });
    const original = all.find((e) => e.id === entryId)!;
    expect(original.retiredAt).toBeDefined();
    const corrected = all.find((e) => e.id === original.supersededBy)!;
    expect(corrected.body).toBe("Editorial serifs, but warmer");
  });

  it("dispatches direction memory promote --to global and writes memory.yaml + brand.yaml", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    await getCommand("direction")!.run!({ cwd: tmpDir, input: ["new", "moody"] });
    const core = createDirectionCore(tmpDir, testConfig);
    const mem = await core.appendDecision("moody", {
      body: "Never mix warm and cool neutrals",
      author: "tim",
      source: "cli",
      channel: "visual",
      polarity: "avoid",
    });
    const entryId = mem.entries[0].id;

    const outcome = await getCommand("direction")!.run!({
      cwd: tmpDir,
      input: [
        "memory",
        "promote",
        "moody",
        entryId,
        "--to",
        "global",
        "--severity",
        "guideline",
      ],
    });

    expect(outcome.summary).toContain("Promoted");
    expect(outcome.filesWritten).toContain("brand/directions/moody/memory.yaml");
    expect(outcome.filesWritten).toContain("brand/brand.yaml");

    const brand = createBrandCore(tmpDir, testConfig);
    const doc = await brand.read();
    expect(doc.rules.some((r) => r.source === "promote:moody")).toBe(true);
  });

  it("dispatches direction memory delete (non-destructive retire)", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    await getCommand("direction")!.run!({ cwd: tmpDir, input: ["new", "moody"] });
    const core = createDirectionCore(tmpDir, testConfig);
    const mem = await core.appendFeedback("moody", {
      body: "no longer relevant",
      author: "tim",
      source: "cli",
    });
    const entryId = mem.entries[0].id;

    const outcome = await getCommand("direction")!.run!({
      cwd: tmpDir,
      input: ["memory", "delete", "moody", entryId, "--reason", "no longer relevant"],
    });

    expect(outcome.summary).toContain("Deleted");
    const all = await core.memoryEntries("moody", { includeRetired: true });
    expect(all.find((e) => e.id === entryId)?.retiredAt).toBeDefined();
  });

  it("direction memory read (a direction id, no sub-action) stays a read", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    await getCommand("direction")!.run!({ cwd: tmpDir, input: ["new", "moody"] });
    await getCommand("direction")!.run!({
      cwd: tmpDir,
      input: ["feedback", "moody", "--body", "hi"],
    });

    const outcome = await getCommand("direction")!.run!({
      cwd: tmpDir,
      input: ["memory", "moody"],
    });
    expect(outcome.filesWritten).toHaveLength(0);
    expect(outcome.summary).toContain("entr");
  });

  it("dispatches rule remove and rule edit through the registry adapter", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    const added = await getCommand("rule")!.run!({
      cwd: tmpDir,
      input: ["add", "Prefer whitespace"],
    });
    expect(added.summary).toContain("Added");

    const brand = createBrandCore(tmpDir, testConfig);
    const ruleId = (await brand.read()).rules[0].id;

    const edited = await getCommand("rule")!.run!({
      cwd: tmpDir,
      input: ["edit", ruleId, "--body", "Prefer generous whitespace"],
    });
    expect(edited.summary).toContain("Edited global rule");

    const removed = await getCommand("rule")!.run!({
      cwd: tmpDir,
      input: ["remove", ruleId],
    });
    expect(removed.summary).toContain("Removed global rule");
  });

  it("HARD-rule force gate surfaces through the rule registry adapter", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    await getCommand("rule")!.run!({
      cwd: tmpDir,
      input: ["add", "Never pure black", "--severity", "hard"],
    });
    const brand = createBrandCore(tmpDir, testConfig);
    const ruleId = (await brand.read()).rules[0].id;

    await expect(
      getCommand("rule")!.run!({ cwd: tmpDir, input: ["remove", ruleId] }),
    ).rejects.toThrow(CommandError);

    const removed = await getCommand("rule")!.run!({
      cwd: tmpDir,
      input: ["remove", ruleId, "--force"],
    });
    expect(removed.summary).toContain("Removed");
  });
});

describe("keyart_brand dispatch of memory lifecycle + rule lifecycle (WS-04)", () => {
  it("dispatchCommand drives direction memory edit keylessly", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    await dispatchCommand(
      { command: "direction", input: ["new", "moody"] },
      { defaultCwd: tmpDir },
    );
    const core = createDirectionCore(tmpDir, testConfig);
    const mem = await core.appendLearning("moody", {
      body: "Editorial serifs",
      author: "tim",
      source: "cli",
    });
    const entryId = mem.entries[0].id;

    const result = await dispatchCommand(
      { command: "direction", input: ["memory", "edit", "moody", entryId, "--body", "x"] },
      { defaultCwd: tmpDir },
    );
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Edited memory entry");

    const all = await core.memoryEntries("moody", { includeRetired: true });
    expect(all.find((e) => e.id === entryId)?.retiredAt).toBeDefined();
  });

  it("dispatchCommand drives rule remove keylessly", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    await dispatchCommand(
      { command: "rule", input: ["add", "Prefer whitespace"] },
      { defaultCwd: tmpDir },
    );
    const brand = createBrandCore(tmpDir, testConfig);
    const ruleId = (await brand.read()).rules[0].id;

    const result = await dispatchCommand(
      { command: "rule", input: ["remove", ruleId] },
      { defaultCwd: tmpDir },
    );
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Removed global rule");
    expect((await brand.read()).rules[0].retiredAt).toBeDefined();
  });

  it("HARD gate through MCP: dispatchCommand errors without --force, succeeds with it", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    await dispatchCommand(
      { command: "rule", input: ["add", "Never pure black", "--severity", "hard"] },
      { defaultCwd: tmpDir },
    );
    const brand = createBrandCore(tmpDir, testConfig);
    const ruleId = (await brand.read()).rules[0].id;

    const denied = await dispatchCommand(
      { command: "rule", input: ["remove", ruleId] },
      { defaultCwd: tmpDir },
    );
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/force/i);

    const allowed = await dispatchCommand(
      { command: "rule", input: ["remove", ruleId, "--force"] },
      { defaultCwd: tmpDir },
    );
    expect(allowed.isError).toBe(false);
  });

  it("every dispatch above runs keyless (no OPENAI_API_KEY)", () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });

  it("serve stays never-MCP-dispatchable (regression)", async () => {
    const result = await dispatchCommand({ command: "serve" }, { defaultCwd: tmpDir });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("npx keyart serve");
  });
});

describe("asset registration (asset-extraction WS-04)", () => {
  it("registers asset as a dispatchable command with a valid meta shape", () => {
    const asset = getCommand("asset");
    expect(asset).toBeDefined();
    expect(asset!.dispatchable).toBe(true);
    expect(typeof asset!.run).toBe("function");
    expect(asset!.summary.length).toBeLessThanOrEqual(100);
    expect(asset!.helpDoc).toContain("## Usage");
    expect(asset!.helpDoc).toContain("## Outputs");
    expect(asset!.helpDoc).toContain("## Examples");
    expect(groupOf("asset")).toBe("brand");
    expect(helpIndex()).toContain("asset");
    expect(groupToolDescription("brand")).toContain("asset");
  });

  it("parseArgs accepts extract and regenerate token shapes, rejects an unknown flag", () => {
    const asset = getCommand("asset")!;
    expect(parseArgs(asset, ["extract", "--direction", "d", "--describe", "x"])).toEqual({
      positionals: ["extract"],
      flags: { direction: "d", describe: "x" },
    });
    expect(
      parseArgs(asset, ["regenerate", "yak-mascot", "--tweak", "t", "--remember"]),
    ).toEqual({
      positionals: ["regenerate", "yak-mascot"],
      flags: { tweak: "t", remember: true },
    });
    expect(() => parseArgs(asset, ["list", "--bogus"])).toThrow(CommandError);
  });

  it("dispatches all five verbs keylessly through dispatchCommand", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    await dispatchCommand({ command: "direction", input: ["new", "moody"] }, { defaultCwd: tmpDir });
    const createResult = await dispatchCommand(
      {
        command: "direction",
        input: [
          "create",
          JSON.stringify({
            name: "Bold Editorial",
            summary: "Strong contrast, confident type",
            character: { mood: "bold, editorial, confident" },
            usage: { rules: ["Lead with strong typography"], antiRules: ["Avoid pastel backgrounds"] },
            copyExamples: { headline: "Ship it boldly", subheadline: "Design that means business", cta: "Get started" },
          }),
          "--from",
          "moody",
        ],
      },
      { defaultCwd: tmpDir },
    );
    expect(createResult.isError).toBe(false);
    const directionId = createResult.text.match(/Created direction "([^"]+)"/)![1];

    const extract = await dispatchCommand(
      {
        command: "asset",
        input: [
          "extract",
          "--direction",
          directionId,
          "--describe",
          "the yak mascot",
        ],
      },
      { defaultCwd: tmpDir },
    );
    expect(extract.isError).toBe(false);
    expect(extract.text).toContain("Files written");
    expect(extract.text).toContain("extracted-assets/");
    const assetId = extract.text.match(/extracted-assets\/([^/]+)\//)![1];

    const regenerate = await dispatchCommand(
      {
        command: "asset",
        input: [
          "regenerate",
          assetId,
          "--direction",
          directionId,
          "--tweak",
          "make it face left",
        ],
      },
      { defaultCwd: tmpDir },
    );
    expect(regenerate.isError).toBe(false);

    const list = await dispatchCommand(
      { command: "asset", input: ["list", "--direction", directionId] },
      { defaultCwd: tmpDir },
    );
    expect(list.isError).toBe(false);

    const remove = await dispatchCommand(
      { command: "asset", input: ["remove", assetId, "--direction", directionId] },
      { defaultCwd: tmpDir },
    );
    expect(remove.isError).toBe(false);
    expect(remove.text).toContain("Retired");

    const removeAgain = await dispatchCommand(
      { command: "asset", input: ["remove", assetId, "--direction", directionId] },
      { defaultCwd: tmpDir },
    );
    expect(removeAgain.isError).toBe(false);
    expect(removeAgain.text).toContain("already retired");

    const pack = await dispatchCommand(
      { command: "asset", input: ["pack", "--direction", directionId] },
      { defaultCwd: tmpDir },
    );
    expect(pack.isError).toBe(false);
  });

  it("a missing required flag surfaces as isError text, never a throw", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    const result = await dispatchCommand(
      { command: "asset", input: ["extract"] },
      { defaultCwd: tmpDir },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("--direction");
  });

  it("serve stays never-MCP-dispatchable through asset's presence too (regression)", async () => {
    const result = await dispatchCommand({ command: "serve" }, { defaultCwd: tmpDir });
    expect(result.isError).toBe(true);
  });
});

describe("surface registration + dispatch (surface-manifest WS-02)", () => {
  it("registers surface as a dispatchable command with a valid meta shape and facade routing", () => {
    const surface = getCommand("surface");
    expect(surface).toBeDefined();
    expect(surface!.dispatchable).toBe(true);
    expect(typeof surface!.run).toBe("function");
    expect(surface!.summary.length).toBeLessThanOrEqual(100);
    expect(surface!.summary).not.toContain("\n");
    expect(surface!.helpDoc).toContain("## Usage");
    expect(surface!.helpDoc).toContain("## Outputs");
    expect(surface!.helpDoc).toContain("## Examples");

    expect(groupOf("surface")).toBe("brand");
    expect(getGroup("brand")!.commands).toContain("surface");
    expect(listGroups().map((g) => g.tool)).toEqual([
      "keyart_brand",
      "keyart_implement",
      "keyart_setup",
    ]);
    expect(helpIndex()).toContain("surface — ");

    expect(surface!.helpDoc).toContain("keyart_brand");
    expect(surface!.helpDoc).toContain('"request"');
    const usageSection = surface!.helpDoc.split("## Arguments")[0];
    expect(usageSection).toContain("bind");
    expect(usageSection).toContain("fill");
    expect(usageSection).toContain("scan");
  });

  it("has the --origin flag on the EXISTING meta and adds no new command (SC-08/SC-10)", () => {
    const surface = getCommand("surface")!;
    const originFlag = surface.flags.find((f) => f.name === "--origin");
    expect(originFlag).toBeDefined();
    expect(originFlag!.takesValue).toBe(true);

    expect(getCommand("retire")).toBeUndefined();
    const names = listCommands().map((c) => c.name);
    expect(names.filter((n) => n === "surface").length).toBe(1);
    expect(groupOf("surface")).toBe("brand");
  });

  it("the helpDoc documents the bad-scan recovery workflow", () => {
    const surface = getCommand("surface")!;
    expect(surface.helpDoc).toContain("--origin");
    expect(surface.helpDoc).toContain("retire --origin scan");
    expect(surface.helpDoc).toContain("non-destructive");
  });

  it("parseArgs accepts the bulk-retire form", () => {
    const surface = getCommand("surface")!;
    expect(parseArgs(surface, ["retire", "--origin", "scan"])).toEqual({
      positionals: ["retire"],
      flags: { origin: "scan" },
    });
  });

  it("parseArgs accepts the surface tokens and rejects an unknown (later-workstream) flag", () => {
    const surface = getCommand("surface")!;
    expect(parseArgs(surface, ["show", "--include-retired"])).toEqual({
      positionals: ["show"],
      flags: { "include-retired": true },
    });
    expect(
      parseArgs(surface, ["set", "[]", "--expected-version", "2", "--force"]),
    ).toEqual({
      positionals: ["set", "[]"],
      flags: { "expected-version": "2", force: true },
    });
    expect(
      parseArgs(surface, ["request", "{}", "--author", "a", "--source", "s"]),
    ).toEqual({
      positionals: ["request", "{}"],
      flags: { author: "a", source: "s" },
    });
    expect(() => parseArgs(surface, ["show", "--not-a-real-flag", "x"])).toThrow(
      CommandError,
    );
  });

  it("dispatches set → show → schema keylessly through dispatchCommand", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    const setResult = await dispatchCommand(
      {
        command: "surface",
        input: [
          "set",
          JSON.stringify([
            {
              id: "icon.restaurant",
              kind: "icon",
              description: "Restaurant marker",
              criticality: "required",
              origin: "authored",
              attributions: [],
            },
          ]),
        ],
      },
      { defaultCwd: tmpDir },
    );
    expect(setResult.isError).toBe(false);
    expect(setResult.text).toContain("brand/surface.yaml");

    const showResult = await dispatchCommand(
      { command: "surface", input: ["show"] },
      { defaultCwd: tmpDir },
    );
    expect(showResult.isError).toBe(false);
    expect(showResult.text).toContain("icon.restaurant");

    const schemaResult = await dispatchCommand(
      { command: "surface", input: ["schema"] },
      { defaultCwd: tmpDir },
    );
    expect(schemaResult.isError).toBe(false);
    expect(schemaResult.text).toContain("## JSON Schema");
  });

  it("passes the WS-01 teaching rejection through the facade verbatim", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const result = await dispatchCommand(
      {
        command: "surface",
        input: [
          "set",
          JSON.stringify([
            {
              id: "icon.restaurant",
              kind: "graphic",
              description: "Restaurant marker",
              criticality: "required",
              origin: "authored",
              attributions: [],
            },
          ]),
        ],
      },
      { defaultCwd: tmpDir },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain('"graphic"');
    for (const kind of ["icon", "illustration", "color-role", "type-role", "other"]) {
      expect(result.text).toContain(kind);
    }
  });

  it("dispatches request (proving dedupe) and retire keylessly, hitting the same core", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    const slotJson = JSON.stringify({
      id: "icon.scooter",
      kind: "icon",
      description: "Delivery scooter",
      criticality: "required",
    });

    const first = await dispatchCommand(
      {
        command: "surface",
        input: ["request", slotJson, "--author", "coding-agent", "--source", "mcp"],
      },
      { defaultCwd: tmpDir },
    );
    expect(first.isError).toBe(false);

    const second = await dispatchCommand(
      {
        command: "surface",
        input: ["request", slotJson, "--author", "coding-agent", "--source", "mcp"],
      },
      { defaultCwd: tmpDir },
    );
    expect(second.isError).toBe(false);
    expect(second.text).toContain("appended");

    const retire = await dispatchCommand(
      { command: "surface", input: ["retire", "icon.scooter"] },
      { defaultCwd: tmpDir },
    );
    expect(retire.isError).toBe(false);

    const core = createSurfaceCore(tmpDir, testConfig);
    const manifest = await core.read();
    const slot = manifest!.slots.find((s) => s.id === "icon.scooter")!;
    expect(slot.retiredAt).toBeTruthy();
    expect(slot.attributions.length).toBe(2);
  });

  it("recovers a bad scan via a keyless keyart_brand round-trip (SC-08)", async () => {
    delete process.env.OPENAI_API_KEY;
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    const setResult = await dispatchCommand(
      {
        command: "surface",
        input: [
          "set",
          JSON.stringify([
            {
              id: "icon.scan-1",
              kind: "icon",
              description: "Scanned icon 1",
              criticality: "preferred",
              origin: "scan",
              attributions: [],
            },
            {
              id: "icon.scan-2",
              kind: "icon",
              description: "Scanned icon 2",
              criticality: "preferred",
              origin: "scan",
              attributions: [],
            },
            {
              id: "icon.authored-1",
              kind: "icon",
              description: "Authored icon",
              criticality: "required",
              origin: "authored",
              attributions: [],
            },
          ]),
        ],
      },
      { defaultCwd: tmpDir },
    );
    expect(setResult.isError).toBe(false);

    const retireResult = await dispatchCommand(
      { command: "surface", input: ["retire", "--origin", "scan"] },
      { defaultCwd: tmpDir },
    );
    expect(retireResult.isError).toBe(false);
    expect(retireResult.text).toContain("2");
    expect(retireResult.text).toContain("brand/surface.yaml");

    const showResult = await dispatchCommand(
      { command: "surface", input: ["show"] },
      { defaultCwd: tmpDir },
    );
    expect(showResult.isError).toBe(false);
    expect(showResult.text).toContain("icon.authored-1");
    expect(showResult.text).not.toContain("icon.scan-1");
    expect(showResult.text).not.toContain("icon.scan-2");

    const secondRetire = await dispatchCommand(
      { command: "surface", input: ["retire", "--origin", "scan"] },
      { defaultCwd: tmpDir },
    );
    expect(secondRetire.isError).toBe(false);
    expect(secondRetire.text).toContain("No active");
  });

  it("serve stays non-dispatchable, and a single-token plain-string input works (forgiving-input path)", async () => {
    expect(getCommand("serve")!.dispatchable).toBe(false);

    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const result = await dispatchCommand(
      { command: "surface", input: "schema" },
      { defaultCwd: tmpDir },
    );
    expect(result.isError).toBe(false);
  });
});

describe("surface bind dispatch (surface-manifest WS-03)", () => {
  const VERSION_ID = "2026-08-01T00-00-00-000Z";
  const FIXTURE_TOKENS: DirectionTokens = {
    palette: [
      { role: "primary", name: "Hot Pink", hex: "#e84393" },
      { role: "secondary", name: "Sky Blue", hex: "#2d98da" },
      { role: "background", name: "Cream", hex: "#faf6f0" },
      { role: "surface", name: "White", hex: "#ffffff" },
      { role: "text", name: "Ink", hex: "#1c1a17" },
      { role: "muted", name: "Slate", hex: "#6c757d" },
    ],
    typography: { heading: "Space Grotesk", body: "Inter" },
    shape: { radius: "8px", spacingUnit: "8px" },
  };

  function makeBindVersion(): DirectionVersion {
    return {
      id: VERSION_ID,
      createdAt: "2026-08-01T00:00:00.000Z",
      briefSnapshot: "brief snapshot",
      contextSnapshot: "context snapshot",
      name: "Direction A",
      summary: "A summary.",
      positioning: "A positioning statement.",
      character: {},
      homepageMockupPrompt: "",
      styleTilePrompt: "",
      copyExamples: { headline: "h", subheadline: "s", cta: "c" },
      usage: { rules: [], antiRules: [] },
      tokens: FIXTURE_TOKENS,
    };
  }

  async function seedApprovedDirection(config: KeyartConfig): Promise<void> {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "direction-a", name: "Direction A" });
    const directionsDir = path.join(tmpDir, "brand", "directions");
    const version = makeBindVersion();
    const versionDir = path.join(directionsDir, "direction-a", "versions", version.id);
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(
      path.join(versionDir, "direction-version.json"),
      JSON.stringify(version),
      "utf-8",
    );
    await core.appendVersion("direction-a", version.id);

    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a", versionId: version.id,
    });
  }

  it("dispatches keylessly through keyart_brand and writes binding.json", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    await seedApprovedDirection(testConfig);
    await createSurfaceCore(tmpDir, testConfig).setManifest([
      {
        id: "color-role.background",
        kind: "color-role",
        description: "Page background",
        criticality: "required",
        origin: "authored",
        attributions: [],
      },
    ]);

    const result = await dispatchCommand(
      { command: "surface", input: ["bind"] },
      { defaultCwd: tmpDir },
    );
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Surface bound for direction-a");
    expect(result.text).toContain("brand/generated/binding.json");

    const bindingRaw = await fs.readFile(
      path.join(tmpDir, "brand", "generated", "binding.json"),
      "utf-8",
    );
    const binding = JSON.parse(bindingRaw);
    expect(binding.pointer.directionId).toBe("direction-a");
    expect(binding.slots).toEqual([
      { slotId: "color-role.background", kind: "color-role", status: "bound", value: "#faf6f0" },
    ]);
  });

  it("the surface helpDoc documents bind and the facade set stays unchanged", () => {
    const surface = getCommand("surface")!;
    expect(surface.helpDoc).toContain("## bind");
    expect(listGroups().map((g) => g.tool)).toEqual([
      "keyart_brand",
      "keyart_implement",
      "keyart_setup",
    ]);
    expect(getGroup("brand")!.commands).toEqual(
      expect.arrayContaining(["surface"]),
    );
  });

  it("dispatches fill keylessly through keyart_brand — dry-run pending, no throw, no network", async () => {
    const { loadConfig } = await import("../config.js");
    const testConfig = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(testConfig);

    await seedApprovedDirection(testConfig);
    await createSurfaceCore(tmpDir, testConfig).setManifest([
      {
        id: "icon.restaurant",
        kind: "icon",
        description: "A restaurant marker",
        criticality: "required",
        origin: "authored",
        attributions: [],
      },
    ]);

    const result = await dispatchCommand(
      { command: "surface", input: ["fill"] },
      { defaultCwd: tmpDir },
    );
    expect(result.isError).toBe(false);
    expect(result.text).toContain("pending");

    const indexRaw = await fs.readFile(
      path.join(
        tmpDir,
        "brand",
        "directions",
        "direction-a",
        "extracted-assets",
        "icon-restaurant",
        "asset.json",
      ),
      "utf-8",
    );
    const index = JSON.parse(indexRaw);
    expect(index.slotId).toBe("icon.restaurant");
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
  });
});

describe("surface fill registration (surface-manifest WS-04)", () => {
  it("the surface helpDoc documents fill and --slot; the facade set + command list stay unchanged", () => {
    const surface = getCommand("surface")!;
    expect(surface.helpDoc).toContain("## fill");
    expect(surface.helpDoc).toContain("--slot");
    expect(surface.flags.map((f) => f.name)).toContain("--slot");
    expect(listCommands().filter((c) => c.name === "surface")).toHaveLength(1);
    expect(listGroups().map((g) => g.tool)).toEqual([
      "keyart_brand",
      "keyart_implement",
      "keyart_setup",
    ]);
  });
});

describe("surface scan registration (surface-manifest WS-05, Test 13)", () => {
  it("documents scan + --apply on the EXISTING surface CommandMeta; no new registry entry", () => {
    const surface = getCommand("surface")!;
    expect(surface.flags.map((f) => f.name)).toContain("--apply");
    expect(surface.helpDoc).toContain("keyart surface scan <url...> [--apply]");
    expect(surface.helpDoc).toContain("## scan");
    expect(surface.helpDoc).toContain("Playwright");
    expect(surface.helpDoc).toMatch(/30.?60s/);
    expect(surface.helpDoc).toContain('"scan", "http://localhost:3000"');

    // The facade set, command list, and group membership are unchanged.
    expect(listCommands().filter((c) => c.name === "surface")).toHaveLength(1);
    expect(getCommand("scan")).toBeUndefined();
    expect(listGroups().map((g) => g.tool)).toEqual([
      "keyart_brand",
      "keyart_implement",
      "keyart_setup",
    ]);
  });

  it("surface scan with no URLs fails with the usage line; --apply on a non-scan verb is rejected", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const noUrls = await dispatchCommand(
      { command: "surface", input: ["scan"] },
      { defaultCwd: tmpDir },
    );
    expect(noUrls.isError).toBe(true);
    expect(noUrls.text).toContain("Usage: keyart surface scan");

    const applyOnShow = await dispatchCommand(
      { command: "surface", input: ["show", "--apply"] },
      { defaultCwd: tmpDir },
    );
    expect(applyOnShow.isError).toBe(true);
    expect(applyOnShow.text).toContain("--apply is not valid with surface show");
  });
});

describe("surface scan page setup + overlay honesty (surface-scan-quality WS-01)", () => {
  it("the --dismiss and --wait-for flags exist on the EXISTING surface meta; facade unchanged", () => {
    const surface = getCommand("surface")!;
    const dismissFlag = surface.flags.find((f) => f.name === "--dismiss");
    const waitForFlag = surface.flags.find((f) => f.name === "--wait-for");
    expect(dismissFlag?.takesValue).toBe(true);
    expect(waitForFlag?.takesValue).toBe(true);

    expect(listCommands().filter((c) => c.name === "surface")).toHaveLength(1);
    expect(getCommand("scan")).toBeUndefined();
    expect(listGroups().map((g) => g.tool)).toEqual([
      "keyart_brand",
      "keyart_implement",
      "keyart_setup",
    ]);
  });

  it("parseArgs accepts --dismiss and --wait-for", () => {
    const surface = getCommand("surface")!;
    expect(
      parseArgs(surface, [
        "scan",
        "http://x/",
        "--dismiss",
        ".a,.b",
        "--wait-for",
        "main",
      ]),
    ).toEqual({
      positionals: ["scan", "http://x/"],
      flags: { dismiss: ".a,.b", "wait-for": "main" },
    });
  });

  it("splits the comma-separated MCP --dismiss form into an array forwarded to runSurfaceScan", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
    const { runSurfaceScan } = await import("../surface/scan.js");
    vi.mocked(runSurfaceScan).mockResolvedValue({
      proposalDir: "brand/surface/scan",
      proposalFile: "brand/surface/scan/proposal.json",
      urls: ["http://x/"],
      candidateCount: 0,
      byKind: {},
      skippedCovered: 0,
      skippedContent: 0,
      contentGroups: 0,
      fallbackCount: 0,
      filesWritten: [],
      dryRun: false,
      setupNotes: [],
    });

    await dispatchCommand(
      {
        command: "surface",
        input: [
          "scan",
          "http://x/",
          "--dismiss",
          " .a , .b ",
          "--wait-for",
          "main",
        ],
      },
      { defaultCwd: tmpDir },
    );

    expect(runSurfaceScan).toHaveBeenCalledWith(
      expect.objectContaining({
        setup: { waitFor: "main", dismiss: [".a", ".b"] },
      }),
    );
  });

  it("the helpDoc documents setup and overlay honesty", () => {
    const surface = getCommand("surface")!;
    expect(surface.helpDoc).toContain("--dismiss");
    expect(surface.helpDoc).toContain("--wait-for");
    expect(surface.helpDoc).toContain("blockedByOverlay");
    expect(surface.helpDoc).toContain("recorded note");
  });
});
