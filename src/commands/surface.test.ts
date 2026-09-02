import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";
import { CommandError } from "../errors.js";
import { VersionConflictError } from "../store/versioned-store.js";
import { runSurface } from "./surface.js";
import { createSurfaceCore } from "../surface/store.js";
import type { SlotKind, SurfaceSlot } from "../surface/schema.js";
import type { SurfaceScanResult } from "../surface/scan.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

vi.mock("../surface/scan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../surface/scan.js")>();
  return { ...actual, runSurfaceScan: vi.fn() };
});

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Surface Test", type: "prototype", framework: "next" },
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
    store: { driver: "file" },
  };
}

function makeSlot(
  id: string,
  kind: SlotKind,
  overrides?: Partial<SurfaceSlot>,
): SurfaceSlot {
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

let tmpDir: string;
let config: KeyartConfig;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-surface-cmd-"));
  delete process.env.OPENAI_API_KEY;
  config = buildTestConfig(tmpDir);
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(config);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function pathExists(relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(tmpDir, relPath));
    return true;
  } catch {
    return false;
  }
}

// 1. Unknown verb.
describe("runSurface unknown verb", () => {
  it("rejects an unknown verb naming the supported verbs", async () => {
    await expect(runSurface(tmpDir, ["explode"], {})).rejects.toThrow(CommandError);
    await expect(runSurface(tmpDir, ["explode"], {})).rejects.toThrow(
      /schema, show, set, patch, request, retire/,
    );
  });
});

// 2. schema, keyless, with and without a manifest.
describe("runSurface schema", () => {
  it("prints the contract, keyless, with and without a manifest", async () => {
    const noManifest = await runSurface(tmpDir, ["schema"], {});
    if (noManifest.verb !== "schema") throw new Error("expected schema result");
    expect(noManifest.brief).toContain("## JSON Schema");
    for (const kind of ["icon", "illustration", "color-role", "type-role", "other"]) {
      expect(noManifest.brief).toContain(kind);
    }
    expect(noManifest.brief).toContain("No manifest exists yet.");
    expect(noManifest.filesWritten).toEqual([]);

    await runSurface(
      tmpDir,
      ["set", JSON.stringify([makeSlot("icon.restaurant", "icon")])],
      {},
    );

    const withManifest = await runSurface(tmpDir, ["schema"], {});
    if (withManifest.verb !== "schema") throw new Error("expected schema result");
    expect(withManifest.brief).toContain("## Current manifest");
    expect(withManifest.brief).toContain("icon.restaurant");
    expect(withManifest.filesWritten).toEqual([]);
  });
});

// 3. set writes brand/surface.yaml through the core.
describe("runSurface set", () => {
  it("writes brand/surface.yaml through the core", async () => {
    const slots = [
      makeSlot("icon.restaurant", "icon"),
      makeSlot("illustration.empty-cart", "illustration"),
    ];
    const result = await runSurface(tmpDir, ["set", JSON.stringify(slots)], {});
    if (result.verb !== "set") throw new Error("expected set result");
    expect(result.manifest.version).toBe(1);
    expect(result.manifest.slots.map((s) => s.id).sort()).toEqual(
      ["icon.restaurant", "illustration.empty-cart"].sort(),
    );
    expect(result.filesWritten).toEqual(["brand/surface.yaml"]);
    expect(await pathExists("brand/surface.yaml")).toBe(true);

    const core = createSurfaceCore(tmpDir, config);
    const reread = await core.read();
    expect(reread!.slots.length).toBe(2);
  });

  // 4. Unknown kind => teaching rejection verbatim.
  it("rejects an unknown kind with the teaching message verbatim, writing nothing", async () => {
    const badSlot = { ...makeSlot("icon.bad", "icon"), kind: "graphic" };
    await expect(
      runSurface(tmpDir, ["set", JSON.stringify([badSlot])], {}),
    ).rejects.toThrow(CommandError);
    await expect(
      runSurface(tmpDir, ["set", JSON.stringify([badSlot])], {}),
    ).rejects.toThrow(/"graphic"/);
    await expect(
      runSurface(tmpDir, ["set", JSON.stringify([badSlot])], {}),
    ).rejects.toThrow(/icon, illustration, color-role, type-role, other/);
    expect(await pathExists("brand/surface.yaml")).toBe(false);
  });

  // 11. Optimistic concurrency.
  it("rejects a stale expectedVersion with VersionConflictError; force bypasses it", async () => {
    await runSurface(tmpDir, ["set", JSON.stringify([makeSlot("icon.a", "icon")])], {});
    await runSurface(
      tmpDir,
      ["set", JSON.stringify([makeSlot("icon.a", "icon"), makeSlot("icon.b", "icon")])],
      {},
    );

    await expect(
      runSurface(tmpDir, ["set", JSON.stringify([makeSlot("icon.c", "icon")])], {
        expectedVersion: 1,
      }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    const forced = await runSurface(
      tmpDir,
      ["set", JSON.stringify([makeSlot("icon.c", "icon")])],
      { expectedVersion: 1, force: true },
    );
    if (forced.verb !== "set") throw new Error("expected set result");
    expect(forced.manifest.slots.map((s) => s.id)).toEqual(["icon.c"]);
  });
});

// 5. Malformed payloads are helpful.
describe("runSurface malformed payloads", () => {
  it("(a) non-JSON payload for set gives Invalid JSON + usage", async () => {
    await expect(runSurface(tmpDir, ["set", "{not json"], {})).rejects.toThrow(
      /Invalid JSON/,
    );
    await expect(runSurface(tmpDir, ["set", "{not json"], {})).rejects.toThrow(
      /Usage:/,
    );
  });

  it("(b) a JSON object for set explains an array is expected", async () => {
    await expect(
      runSurface(
        tmpDir,
        ["set", JSON.stringify(makeSlot("icon.a", "icon"))],
        {},
      ),
    ).rejects.toThrow(/array/);
  });

  it("(c) a JSON array for request explains request takes one slot", async () => {
    await expect(
      runSurface(
        tmpDir,
        ["request", JSON.stringify([makeSlot("icon.a", "icon")])],
        {},
      ),
    ).rejects.toThrow(/one slot/);
  });

  it("(d) a missing payload for set gives a usage error", async () => {
    await expect(runSurface(tmpDir, ["set"], {})).rejects.toThrow(CommandError);
  });
});

// 6. patch upserts by id.
describe("runSurface patch", () => {
  it("upserts by id, preserving order and bumping version", async () => {
    await runSurface(
      tmpDir,
      [
        "set",
        JSON.stringify([
          makeSlot("icon.restaurant", "icon", { description: "v1" }),
          makeSlot("illustration.empty-cart", "illustration"),
        ]),
      ],
      {},
    );

    const patched = await runSurface(
      tmpDir,
      [
        "patch",
        JSON.stringify([
          makeSlot("icon.restaurant", "icon", { description: "v2" }),
          makeSlot("color-role.chart-accent", "color-role"),
        ]),
      ],
      {},
    );
    if (patched.verb !== "patch") throw new Error("expected patch result");
    expect(patched.manifest.slots.length).toBe(3);
    expect(patched.manifest.slots.map((s) => s.id)).toEqual([
      "icon.restaurant",
      "illustration.empty-cart",
      "color-role.chart-accent",
    ]);
    expect(patched.manifest.slots[0].description).toBe("v2");
    expect(patched.manifest.version).toBe(2);
  });
});

// 7 & 8. request lands attributed; dedupe; default attribution.
describe("runSurface request", () => {
  it("lands attributed and a re-request dedupes into an appended attribution", async () => {
    const slot = {
      id: "icon.scooter",
      kind: "icon",
      description: "Delivery scooter",
      criticality: "required",
    };
    const first = await runSurface(tmpDir, ["request", JSON.stringify(slot)], {
      author: "coding-agent",
      source: "mcp",
    });
    if (first.verb !== "request") throw new Error("expected request result");
    expect(first.deduped).toBe(false);
    const stored = first.manifest.slots.find((s) => s.id === "icon.scooter")!;
    expect(stored.origin).toBe("request");
    expect(stored.attributions.length).toBe(1);
    expect(stored.attributions[0]).toMatchObject({
      author: "coding-agent",
      source: "mcp",
    });
    expect(new Date(stored.attributions[0].date).toISOString()).toBe(
      stored.attributions[0].date,
    );

    const second = await runSurface(tmpDir, ["request", JSON.stringify(slot)], {
      author: "another-agent",
      source: "cli",
    });
    if (second.verb !== "request") throw new Error("expected request result");
    expect(second.deduped).toBe(true);
    expect(second.manifest.slots.length).toBe(1);
    const restored = second.manifest.slots.find((s) => s.id === "icon.scooter")!;
    expect(restored.attributions.length).toBe(2);
    expect(restored.attributions.map((a) => a.author)).toEqual([
      "coding-agent",
      "another-agent",
    ]);
  });

  it("defaults attribution to author=agent, source=cli", async () => {
    const slot = {
      id: "icon.scooter",
      kind: "icon",
      description: "Delivery scooter",
      criticality: "required",
    };
    const result = await runSurface(tmpDir, ["request", JSON.stringify(slot)], {});
    if (result.verb !== "request") throw new Error("expected request result");
    const stored = result.manifest.slots.find((s) => s.id === "icon.scooter")!;
    expect(stored.attributions[0]).toMatchObject({ author: "agent", source: "cli" });
  });
});

// 9. retire is non-destructive and idempotent.
describe("runSurface retire", () => {
  it("is non-destructive and idempotent at the command layer; unknown id rejects", async () => {
    await runSurface(
      tmpDir,
      ["set", JSON.stringify([makeSlot("icon.restaurant", "icon")])],
      {},
    );

    const first = await runSurface(tmpDir, ["retire", "icon.restaurant"], {});
    if (first.verb !== "retire" || "mode" in first) {
      throw new Error("expected single-slot retire result");
    }
    expect(first.alreadyRetired).toBe(false);
    expect(first.retiredAt).toBeTruthy();
    expect(first.filesWritten).toEqual(["brand/surface.yaml"]);

    const second = await runSurface(tmpDir, ["retire", "icon.restaurant"], {});
    if (second.verb !== "retire" || "mode" in second) {
      throw new Error("expected single-slot retire result");
    }
    expect(second.alreadyRetired).toBe(true);
    expect(second.retiredAt).toBe(first.retiredAt);
    expect(second.filesWritten).toEqual([]);

    await expect(
      runSurface(tmpDir, ["retire", "does-not-exist"], {}),
    ).rejects.toThrow(/Slot not found/);
  });
});

describe("runSurface retire --origin (manifest-recovery WS-06)", () => {
  async function seedOriginManifest(): Promise<void> {
    await runSurface(
      tmpDir,
      [
        "set",
        JSON.stringify([
          makeSlot("icon.scan-1", "icon", { origin: "scan" }),
          makeSlot("icon.scan-2", "icon", { origin: "scan" }),
          makeSlot("icon.authored-1", "icon", { origin: "authored" }),
        ]),
      ],
      {},
    );
  }

  it("bulk-retires through the core (SC-08)", async () => {
    await seedOriginManifest();

    const result = await runSurface(tmpDir, ["retire"], { origin: "scan" });
    if (result.verb !== "retire" || !("mode" in result)) {
      throw new Error("expected bulk retire result");
    }
    expect(result.mode).toBe("origin");
    expect(result.origin).toBe("scan");
    expect(result.retiredIds).toEqual(["icon.scan-1", "icon.scan-2"]);
    expect(result.filesWritten).toEqual(["brand/surface.yaml"]);

    const core = createSurfaceCore(tmpDir, config);
    const manifest = await core.read();
    const scan1 = manifest!.slots.find((s) => s.id === "icon.scan-1")!;
    const scan2 = manifest!.slots.find((s) => s.id === "icon.scan-2")!;
    const authored = manifest!.slots.find((s) => s.id === "icon.authored-1")!;
    expect(scan1.retiredAt).toBeTruthy();
    expect(scan2.retiredAt).toBeTruthy();
    expect(authored.retiredAt).toBeUndefined();
  });

  it("rejects BOTH a slotId and --origin as a teaching error, writing nothing", async () => {
    await seedOriginManifest();
    const before = await createSurfaceCore(tmpDir, config).read();

    await expect(
      runSurface(tmpDir, ["retire", "icon.scan-1"], { origin: "scan" }),
    ).rejects.toThrow(
      /surface retire takes EITHER a slotId OR --origin <origin>, not both\./,
    );

    const after = await createSurfaceCore(tmpDir, config).read();
    expect(after!.version).toBe(before!.version);
  });

  it("rejects NEITHER a slotId nor --origin as a teaching error", async () => {
    await seedOriginManifest();

    await expect(runSurface(tmpDir, ["retire"], {})).rejects.toThrow(
      /surface retire requires a slotId or --origin <origin>\./,
    );
  });

  it("rejects an unknown origin, naming the valid list inline, writing nothing", async () => {
    await seedOriginManifest();
    const before = await createSurfaceCore(tmpDir, config).read();

    await expect(
      runSurface(tmpDir, ["retire"], { origin: "scanned" }),
    ).rejects.toThrow(/Unknown origin "scanned" — valid origins: authored, scan, request\./);

    const after = await createSurfaceCore(tmpDir, config).read();
    expect(after!.version).toBe(before!.version);
  });

  it("a no-op bulk retire reports no file written", async () => {
    await seedOriginManifest();
    const first = await runSurface(tmpDir, ["retire"], { origin: "scan" });
    if (first.verb !== "retire" || !("mode" in first)) {
      throw new Error("expected bulk retire result");
    }

    const second = await runSurface(tmpDir, ["retire"], { origin: "scan" });
    if (second.verb !== "retire" || !("mode" in second)) {
      throw new Error("expected bulk retire result");
    }
    expect(second.retiredIds).toEqual([]);
    expect(second.alreadyRetiredCount).toBe(first.retiredIds.length);
    expect(second.filesWritten).toEqual([]);
  });

  it("rejects --origin on the wrong verb", async () => {
    await expect(runSurface(tmpDir, ["show"], { origin: "scan" })).rejects.toThrow(
      /--origin is not valid with surface show/,
    );
    await expect(
      runSurface(tmpDir, ["scan", "http://x/"], { origin: "scan" }),
    ).rejects.toThrow(/--origin is not valid with surface scan/);
  });
});

// 10. show filters retired by default; never throws with no manifest.
describe("runSurface show", () => {
  it("resolves without throwing when no manifest exists", async () => {
    const result = await runSurface(tmpDir, ["show"], {});
    if (result.verb !== "show") throw new Error("expected show result");
    expect(result.manifest).toBeNull();
    expect(result.rows).toEqual([]);
  });

  it("filters retired slots by default and includes them with includeRetired", async () => {
    await runSurface(
      tmpDir,
      [
        "set",
        JSON.stringify([
          makeSlot("icon.restaurant", "icon"),
          makeSlot("illustration.empty-cart", "illustration"),
        ]),
      ],
      {},
    );
    await runSurface(tmpDir, ["retire", "icon.restaurant"], {});

    const liveOnly = await runSurface(tmpDir, ["show"], {});
    if (liveOnly.verb !== "show") throw new Error("expected show result");
    expect(liveOnly.rows.length).toBe(1);
    expect(liveOnly.rows[0].retired).toBe(false);
    expect(liveOnly.rows[0].id).toBe("illustration.empty-cart");

    const withRetired = await runSurface(tmpDir, ["show"], { includeRetired: true });
    if (withRetired.verb !== "show") throw new Error("expected show result");
    expect(withRetired.rows.length).toBe(2);
    const retiredRow = withRetired.rows.find((r) => r.id === "icon.restaurant")!;
    expect(retiredRow.retired).toBe(true);
    expect(retiredRow.attributionCount).toBe(0);
  });
});

// 12. Wrong-verb flag coupling.
describe("runSurface wrong-verb flag coupling", () => {
  it("rejects flags not valid for the given verb; unset booleans do not trip the guard", async () => {
    await expect(runSurface(tmpDir, ["show"], { force: true })).rejects.toThrow(
      /--force is not valid with surface show/,
    );
    await expect(
      runSurface(tmpDir, ["set", JSON.stringify([makeSlot("icon.b", "icon")])], {
        includeRetired: true,
      }),
    ).rejects.toThrow(/--include-retired is not valid with surface set/);
    await expect(
      runSurface(tmpDir, ["schema"], { author: "x" }),
    ).rejects.toThrow(/--author is not valid with surface schema/);

    // unset booleans (force: false) do NOT trip the guard.
    await expect(runSurface(tmpDir, ["show"], { force: false })).resolves.toBeDefined();
  });
});

// 19a. `bind` verb parsing — extra flags/args rejected with the usage line;
// full resolution behavior is covered by src/surface/bind.test.ts.
describe("runSurface bind — parsing", () => {
  it("rejects a flag with the usage line", async () => {
    await expect(runSurface(tmpDir, ["bind"], { force: true })).rejects.toThrow(
      /--force is not valid with surface bind/,
    );
    await expect(runSurface(tmpDir, ["bind"], { force: true })).rejects.toThrow(
      /Usage: keyart surface bind/,
    );
  });

  it("rejects a stray positional", async () => {
    await expect(runSurface(tmpDir, ["bind", "extra"], {})).rejects.toThrow(
      /Too many arguments for surface bind/,
    );
  });

  it("surfaces the no-manifest CommandError, unwrapped, when nothing is authored yet", async () => {
    await expect(runSurface(tmpDir, ["bind"], {})).rejects.toThrow(CommandError);
    await expect(runSurface(tmpDir, ["bind"], {})).rejects.toThrow(
      /surface schema/,
    );
  });
});

// 19b. `fill` verb parsing — extra flags/args rejected with the usage line;
// --slot is accepted; full resolution behavior is covered by src/surface/fill.test.ts.
describe("runSurface fill — parsing", () => {
  it("rejects a flag not in the fill flag bag with the usage line", async () => {
    await expect(
      runSurface(tmpDir, ["fill"], { includeRetired: true }),
    ).rejects.toThrow(/--include-retired is not valid with surface fill/);
    await expect(
      runSurface(tmpDir, ["fill"], { includeRetired: true }),
    ).rejects.toThrow(/Usage: keyart surface fill/);
  });

  it("rejects a stray positional", async () => {
    await expect(runSurface(tmpDir, ["fill", "extra"], {})).rejects.toThrow(
      /Too many arguments for surface fill/,
    );
  });

  it("accepts --slot without tripping the flag guard", async () => {
    await expect(runSurface(tmpDir, ["fill"], { slot: "icon.a" })).rejects.toThrow(
      CommandError,
    );
    await expect(runSurface(tmpDir, ["fill"], { slot: "icon.a" })).rejects.not.toThrow(
      /is not valid with surface fill/,
    );
  });

  it("surfaces the no-manifest CommandError, unwrapped, when nothing is authored yet", async () => {
    await expect(runSurface(tmpDir, ["fill"], {})).rejects.toThrow(CommandError);
    await expect(runSurface(tmpDir, ["fill"], {})).rejects.toThrow(/surface schema/);
  });
});

// 21-25. scan page-setup flag forwarding (surface-scan-quality WS-01).
describe("runSurface scan — page-setup flag forwarding (surface-scan-quality WS-01)", () => {
  const fakeResult: SurfaceScanResult = {
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
  };

  it("forwards --dismiss and --wait-for into runSurfaceScan's setup", async () => {
    const { runSurfaceScan } = await import("../surface/scan.js");
    vi.mocked(runSurfaceScan).mockResolvedValue(fakeResult);

    await runSurface(tmpDir, ["scan", "http://x/"], {
      dismiss: ["#a", "#b"],
      waitFor: "main",
    });

    expect(runSurfaceScan).toHaveBeenCalledWith({
      cwd: tmpDir,
      urls: ["http://x/"],
      apply: false,
      noRefine: false,
      setup: { waitFor: "main", dismiss: ["#a", "#b"] },
    });
  });

  it("omits the setup key entirely when no setup flags are given", async () => {
    const { runSurfaceScan } = await import("../surface/scan.js");
    vi.mocked(runSurfaceScan).mockResolvedValue(fakeResult);

    await runSurface(tmpDir, ["scan", "http://x/"], {});

    const callArg = vi.mocked(runSurfaceScan).mock.calls[0][0];
    expect("setup" in callArg).toBe(false);
  });

  it("rejects --dismiss/--wait-for on a non-scan verb", async () => {
    await expect(
      runSurface(tmpDir, ["show"], { dismiss: ["#a"] }),
    ).rejects.toThrow(/--dismiss is not valid with surface show/);
    await expect(
      runSurface(tmpDir, ["retire", "icon.a"], { waitFor: "main" }),
    ).rejects.toThrow(/--wait-for is not valid with surface retire/);
  });

  it("treats an empty --dismiss array as not given", async () => {
    await expect(runSurface(tmpDir, ["show"], { dismiss: [] })).resolves.toBeDefined();
  });

  it("--refine-only cannot combine with --dismiss/--wait-for", async () => {
    await expect(
      runSurface(tmpDir, ["scan"], { refineOnly: true, dismiss: ["#a"] }),
    ).rejects.toThrow(/--dismiss/);
    await expect(
      runSurface(tmpDir, ["scan"], { refineOnly: true, dismiss: ["#a"] }),
    ).rejects.toThrow(/Usage: keyart surface scan/);
  });
});
