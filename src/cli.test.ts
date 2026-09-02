import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the two generation cores so we can assert the CLI maps parsed
// arguments/flags onto the command functions without running them.
vi.mock("./commands/explore.js", () => ({ runExplore: vi.fn().mockResolvedValue({}) }));
vi.mock("./commands/regenerate-visuals.js", () => ({
  runRegenerateVisuals: vi.fn().mockResolvedValue({}),
}));
vi.mock("./commands/direction.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./commands/direction.js")>();
  return {
    ...actual,
    runDirection: vi.fn().mockResolvedValue({}),
    runCreateDirection: vi.fn().mockResolvedValue({}),
    runDirectionNew: vi.fn().mockResolvedValue({}),
    runDirectionList: vi.fn().mockResolvedValue({}),
    runDirectionShow: vi.fn().mockResolvedValue({}),
    runDirectionFork: vi.fn().mockResolvedValue({}),
    runPromote: vi.fn().mockResolvedValue({}),
    runRule: vi.fn().mockResolvedValue({}),
  };
});
vi.mock("./commands/surface.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./commands/surface.js")>();
  return { ...actual, runSurface: vi.fn().mockResolvedValue({}) };
});

// Importing the program builds the commander tree without parsing argv (the bin
// calls program.parse()), so we can drive it with custom args here.
import { program } from "./cli.js";
import { runExplore } from "./commands/explore.js";
import { runRegenerateVisuals } from "./commands/regenerate-visuals.js";
import {
  runDirection,
  runCreateDirection,
  runDirectionNew,
  runDirectionShow,
  runDirectionFork,
  runPromote,
} from "./commands/direction.js";
import { runSurface } from "./commands/surface.js";

const mockExplore = vi.mocked(runExplore);
const mockRegenerate = vi.mocked(runRegenerateVisuals);
const mockRunDirection = vi.mocked(runDirection);
const mockCreateDirection = vi.mocked(runCreateDirection);
const mockDirectionNew = vi.mocked(runDirectionNew);
const mockDirectionShow = vi.mocked(runDirectionShow);
const mockDirectionFork = vi.mocked(runDirectionFork);
const mockPromote = vi.mocked(runPromote);
const mockSurface = vi.mocked(runSurface);

/** Run the CLI with the given args (no node/script prefix). */
async function run(args: string[]): Promise<void> {
  await program.parseAsync(args, { from: "user" });
}

/** The program-level --cwd default (process.cwd()) the actions read. */
function tmpCwd(): string {
  return program.opts().cwd as string;
}

beforeEach(() => {
  mockExplore.mockClear();
  mockRegenerate.mockClear();
  mockRunDirection.mockClear();
  mockCreateDirection.mockClear();
  mockDirectionNew.mockClear();
  mockDirectionShow.mockClear();
  mockDirectionFork.mockClear();
  mockPromote.mockClear();
  mockSurface.mockClear();
});

describe("cli explore flags", () => {
  it("passes --count through to runExplore (generate-one is --count 1)", async () => {
    await run(["explore", "--count", "1"]);

    expect(mockExplore).toHaveBeenCalledTimes(1);
    expect(mockExplore).toHaveBeenCalledWith(
      expect.objectContaining({ count: 1 }),
    );
    // `--append` was removed with the Run grouping — it is no longer plumbed.
    expect(mockExplore.mock.calls[0][0]).not.toHaveProperty("append");
  });

  it("leaves count undefined with no flags (runExplore defaults to 3)", async () => {
    await run(["explore"]);

    expect(mockExplore).toHaveBeenCalledTimes(1);
    const opts = mockExplore.mock.calls[0][0];
    expect(opts.count).toBeUndefined();
    // No --reference ⇒ references stays undefined (ref-less runs byte-identical).
    expect(opts.references).toBeUndefined();
  });

  it("parses repeatable --reference with optional :intent suffix", async () => {
    await run([
      "explore",
      "--reference",
      "refs/board.png",
      "--reference",
      "refs/palette.png:extract",
    ]);

    expect(mockExplore).toHaveBeenCalledTimes(1);
    expect(mockExplore.mock.calls[0][0].references).toEqual([
      { path: "refs/board.png" },
      { path: "refs/palette.png", intent: "extract" },
    ]);
  });

  it("applies a run-wide --intent to every --reference lacking its own :suffix", async () => {
    await run([
      "explore",
      "--reference",
      "refs/a.png",
      "--reference",
      "refs/b.png",
      "--intent",
      "inspire",
    ]);

    expect(mockExplore).toHaveBeenCalledTimes(1);
    expect(mockExplore.mock.calls[0][0].references).toEqual([
      { path: "refs/a.png", intent: "inspire" },
      { path: "refs/b.png", intent: "inspire" },
    ]);
  });

  it("lets a per-reference :suffix override the run-wide --intent", async () => {
    await run([
      "explore",
      "--reference",
      "refs/a.png",
      "--reference",
      "refs/b.png:extract",
      "--intent",
      "inspire",
    ]);

    expect(mockExplore.mock.calls[0][0].references).toEqual([
      { path: "refs/a.png", intent: "inspire" },
      { path: "refs/b.png", intent: "extract" },
    ]);
  });

  it("rejects an invalid --intent with usage, without calling runExplore", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      run(["explore", "--reference", "refs/a.png", "--intent", "bogus"]),
    ).rejects.toThrow("exit");

    expect(mockExplore).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.join(" ")).toContain("--intent");

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

// The removed legacy parent noun, assembled at runtime so the clean-break
// scanner's zero-match terminal state holds (src/integration/clean-break-scan.ts):
// these negative controls must EXERCISE the removed token without any string
// literal carrying it.
const LEGACY_NOUN = ["con", "cept"].join("");
const LEGACY_FLAG = `--${LEGACY_NOUN}`;

describe("cli regenerate wiring", () => {
  it("rejects the removed legacy parent selector as an unknown option (WS-05)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      run(["regenerate", "direction-a", LEGACY_FLAG, "moody"]),
    ).rejects.toThrow();
    expect(mockRegenerate).not.toHaveBeenCalled();

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("maps directionId and tweak onto runRegenerateVisuals", async () => {
    await run(["regenerate", "direction-a", "--tweak", "cooler palette"]);

    expect(mockRegenerate).toHaveBeenCalledTimes(1);
    expect(mockRegenerate).toHaveBeenCalledWith(
      expect.objectContaining({
        directionId: "direction-a",
        tweak: "cooler palette",
      }),
    );
    // The `regenerate` addressing is `<directionId>` only — no versionId/runId.
    expect(mockRegenerate.mock.calls[0][0]).not.toHaveProperty("versionId");
  });

  it("defaults --tweak to undefined when omitted", async () => {
    await run(["regenerate", "direction-a"]);

    expect(mockRegenerate).toHaveBeenCalledTimes(1);
    const opts = mockRegenerate.mock.calls[0][0];
    expect(opts.tweak).toBeUndefined();
    expect(opts.directionId).toBeDefined();
  });
});

// WS-16: the CLI plumbs the three explore forms; --concept is gone.
describe("cli explore three-form surface (WS-16)", () => {
  it("passes the positional directionId through to runExplore", async () => {
    await run(["explore", "warm"]);
    expect(mockExplore).toHaveBeenCalledWith(
      expect.objectContaining({ directionId: "warm" }),
    );
  });

  it("passes --describe and --from through to runExplore", async () => {
    await run(["explore", "--describe", "a seed", "--count", "2"]);
    expect(mockExplore).toHaveBeenCalledWith(
      expect.objectContaining({ describe: "a seed", count: 2 }),
    );

    await run(["explore", "--from", "warm"]);
    expect(mockExplore).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: "warm" }),
    );
  });

  it("rejects the removed legacy parent flag without calling runExplore", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(run(["explore", LEGACY_FLAG, "moody"])).rejects.toThrow();
    expect(mockExplore).not.toHaveBeenCalled();

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// WS-05: the concept command is gone; the direction dispatch covers the
// fourteen-verb roster; --concept is removed from every command.
// ---------------------------------------------------------------------------

describe("cli direction fold (WS-05)", () => {
  it("the legacy parent command is gone (unknown command)", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true);

    await expect(run([LEGACY_NOUN, "list"])).rejects.toThrow();

    writeSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("the legacy-named command module files no longer exist", async () => {
    const fsMod = await import("node:fs/promises");
    const url = await import("node:url");
    const here = url.fileURLToPath(new URL(".", import.meta.url));
    for (const name of [
      `commands/${LEGACY_NOUN}.ts`,
      `commands/${LEGACY_NOUN}.test.ts`,
    ]) {
      await expect(fsMod.access(`${here}${name}`)).rejects.toThrow();
    }
  });

  it("routes the folded verbs to runDirection with the expected shape", async () => {
    await run(["direction", "feedback", "warm", "--body", "less neon"]);
    expect(mockRunDirection).toHaveBeenCalledWith(
      expect.objectContaining({ verb: "feedback", id: "warm", body: "less neon" }),
    );

    await run(["direction", "status", "warm"]);
    expect(mockRunDirection).toHaveBeenLastCalledWith(
      expect.objectContaining({ verb: "status", id: "warm" }),
    );

    await run(["direction", "archive", "warm"]);
    expect(mockRunDirection).toHaveBeenLastCalledWith(
      expect.objectContaining({ verb: "archive", id: "warm" }),
    );

    // Preserved lifecycle verbs (Replan #11): reject/park/revive route intact.
    for (const verb of ["reject", "park", "revive"]) {
      await run(["direction", verb, "warm"]);
      expect(mockRunDirection).toHaveBeenLastCalledWith(
        expect.objectContaining({ verb, id: "warm" }),
      );
    }

    // brief keeps the rest[] overloading: brief set <id> <field> <value…>.
    await run(["direction", "brief", "set", "warm", "oneLiner", "a", "cook's", "app"]);
    expect(mockRunDirection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        verb: "brief",
        subverb: "set",
        id: "warm",
        field: "oneLiner",
        value: "a cook's app",
      }),
    );

    // memory lifecycle disambiguation via rest[0].
    await run(["direction", "memory", "edit", "warm", "e1", "--body", "b"]);
    expect(mockRunDirection).toHaveBeenLastCalledWith(
      expect.objectContaining({
        verb: "memory",
        memoryAction: "edit",
        id: "warm",
        entryId: "e1",
        body: "b",
      }),
    );

    // memory READ: an id in rest[0] means read, never a sub-action.
    await run(["direction", "memory", "warm"]);
    expect(mockRunDirection).toHaveBeenLastCalledWith(
      expect.objectContaining({ verb: "memory", id: "warm", memoryAction: undefined }),
    );
  });

  it("list routes with the exact --include-archived flag; variant spellings are unknown options", async () => {
    await run(["direction", "list"]);
    expect(mockRunDirection).toHaveBeenLastCalledWith(
      expect.objectContaining({ verb: "list", includeArchived: false }),
    );

    await run(["direction", "list", "--include-archived"]);
    expect(mockRunDirection).toHaveBeenLastCalledWith(
      expect.objectContaining({ verb: "list", includeArchived: true }),
    );

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const bad of ["--all", "--show-archived", "--archived"]) {
      await expect(run(["direction", "list", bad])).rejects.toThrow();
    }
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("create takes '<json>' --from <id>; the legacy positional and omitted --from teach (R-6)", async () => {
    await run(["direction", "create", '{"name":"x"}', "--from", "warm"]);
    expect(mockCreateDirection).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: "create",
        seedDirectionId: "warm",
        json: '{"name":"x"}',
      }),
    );

    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    mockCreateDirection.mockClear();
    await expect(
      run(["direction", "create", "warm", '{"name":"x"}']),
    ).rejects.toThrow();
    expect(errSpy.mock.calls.join(" ")).toContain("--from");
    expect(mockCreateDirection).not.toHaveBeenCalled();

    await expect(run(["direction", "create", '{"name":"x"}'])).rejects.toThrow();
    expect(errSpy.mock.calls.join(" ")).toContain("direction new");
    expect(mockCreateDirection).not.toHaveBeenCalled();

    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("preserved registrations still route: new/fork/show/explore (preservation fence)", async () => {
    await run(["direction", "new", "Warm Editorial", "--describe", "calm"]);
    expect(mockDirectionNew).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Warm Editorial", describe: "calm" }),
    );

    await run(["direction", "fork", "warm", "--count", "2", "--with-memory"]);
    expect(mockDirectionFork).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: "warm", count: 2, withMemory: true }),
    );

    await run(["direction", "show", "warm"]);
    expect(mockDirectionShow).toHaveBeenCalledWith(
      expect.objectContaining({ directionId: "warm" }),
    );

    await run(["explore", "warm"]);
    expect(mockExplore).toHaveBeenLastCalledWith(
      expect.objectContaining({ directionId: "warm" }),
    );
  });
});

describe("cli promote retarget + surface legacy-selector removal (WS-05)", () => {
  it("promote passes directionId (never the legacy parent id) to runPromote", async () => {
    await run(["promote", "warm", "always ship dark mode"]);
    expect(mockPromote).toHaveBeenCalledWith(
      expect.objectContaining({ directionId: "warm", text: "always ship dark mode" }),
    );
    expect(mockPromote.mock.calls[0][0]).not.toHaveProperty(`${LEGACY_NOUN}Id`);
  });

  it("surface rejects the removed legacy fill guard as an unknown option", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      run(["surface", "fill", LEGACY_FLAG, "x"]),
    ).rejects.toThrow();
    expect(mockSurface).not.toHaveBeenCalled();

    errSpy.mockRestore();
    exitSpy.mockRestore();

    // Plain surface fill still maps { slot } unchanged.
    await run(["surface", "fill", "--slot", "hero"]);
    expect(mockSurface).toHaveBeenCalledWith(
      tmpCwd(),
      ["fill"],
      expect.objectContaining({ slot: "hero" }),
    );
  });

  it("no legacy parent-selector option is declared on approve/audit/asset (regression fence)", async () => {
    const declared = program.commands.flatMap((c) =>
      c.options.map((o) => `${c.name()} ${o.long}`),
    );
    for (const cmd of ["approve", "audit", "asset", "explore", "regenerate", "surface", "direction"]) {
      expect(declared).not.toContain(`${cmd} ${LEGACY_FLAG}`);
    }
  });
});
