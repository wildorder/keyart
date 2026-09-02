import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSurfaceCore } from "./store.js";
import { VersionConflictError } from "../store/versioned-store.js";
import { CommandError } from "../errors.js";
import type { KeyartConfig } from "../types.js";
import { isSlotRetired, slotById, type SurfaceSlot } from "./schema.js";

function buildTestConfig(cwd: string, surface?: string): KeyartConfig {
  return {
    project: { name: "Surface Test", type: "prototype", framework: "next" },
    brand: {
      root: path.join(cwd, "brand"),
      references: path.join(cwd, "brand", "input", "references"),
      approved: path.join(cwd, "brand", "approved"),
      rejected: path.join(cwd, "brand", "rejected"),
      ...(surface ? { surface } : {}),
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

function slotA(overrides: Partial<SurfaceSlot> = {}): SurfaceSlot {
  return {
    id: "icon.a",
    kind: "icon",
    description: "Slot A.",
    criticality: "required",
    origin: "authored",
    attributions: [],
    ...overrides,
  };
}

function slotB(overrides: Partial<SurfaceSlot> = {}): SurfaceSlot {
  return {
    id: "icon.b",
    kind: "icon",
    description: "Slot B.",
    criticality: "required",
    origin: "authored",
    attributions: [],
    ...overrides,
  };
}

let tmpDir: string;

beforeEach(async () => {
  delete process.env.OPENAI_API_KEY;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-surface-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("createSurfaceCore", () => {
  it("read() is null on absence and never writes", async () => {
    const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
    expect(await core.read()).toBeNull();
    await expect(
      fs.access(path.join(tmpDir, "brand", "surface.yaml")),
    ).rejects.toThrow();
  });

  it("setManifest creates v1 and round-trips through the port", async () => {
    const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
    const written = await core.setManifest([slotA()]);
    expect(written.version).toBe(1);
    expect(written.slots).toEqual([slotA()]);
    expect(typeof written.updatedAt).toBe("string");

    const fresh = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
    expect(await fresh.read()).toEqual(written);
  });

  it("stale expectedVersion throws VersionConflictError; force overrides", async () => {
    const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
    await core.setManifest([slotA()]); // v1
    await core.setManifest([slotA(), slotB()]); // v2

    await expect(
      core.setManifest([slotA()], { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await expect(
      core.setManifest([slotA()], { expectedVersion: 1 }),
    ).rejects.toMatchObject({ expectedVersion: 1, actualVersion: 2 });

    const forced = await core.setManifest([slotA()], {
      expectedVersion: 1,
      force: true,
    });
    expect(forced.version).toBe(3);
  });

  it("omitting expectedVersion uses the current version (sequential calls succeed)", async () => {
    const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
    await core.setManifest([slotA()]);
    const second = await core.setManifest([slotA(), slotB()]);
    expect(second.version).toBe(2);
  });

  it("patchSlots upserts by id, preserving manifest order", async () => {
    const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
    await core.setManifest([slotA(), slotB()]);
    const bPrime = slotB({ description: "Slot B, revised." });
    const c = { ...slotA(), id: "icon.c", description: "Slot C." };

    const result = await core.patchSlots([bPrime, c]);
    expect(result.slots.map((s) => s.id)).toEqual(["icon.a", "icon.b", "icon.c"]);
    expect(result.slots[1]).toEqual(bPrime);
  });

  it("requestSlot on a new id appends an attributed origin:request slot", async () => {
    const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
    const attribution = { author: "tim", source: "cli", date: "2026-01-01T00:00:00.000Z" };
    const requested = { ...slotA(), attributions: [] };
    const { manifest, slotId, deduped } = await core.requestSlot(
      requested,
      attribution,
    );
    expect(deduped).toBe(false);
    expect(slotId).toBe("icon.a");
    const slot = manifest.slots.find((s) => s.id === "icon.a")!;
    expect(slot.origin).toBe("request");
    expect(slot.attributions).toEqual([attribution]);
  });

  it("a re-request appends an attribution, never a duplicate slot", async () => {
    const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
    const attr1 = { author: "tim", source: "cli", date: "2026-01-01T00:00:00.000Z" };
    const attr2 = { author: "agent", source: "mcp", date: "2026-01-02T00:00:00.000Z" };
    await core.requestSlot(slotA(), attr1);
    const second = await core.requestSlot(slotA(), attr2);

    expect(second.deduped).toBe(true);
    expect(second.manifest.slots.length).toBe(1);
    const slot = second.manifest.slots[0];
    expect(slot.attributions).toEqual([attr1, attr2]);
    expect(slot.origin).toBe("request");
  });

  it("retireSlot sets the marker; idempotent no-op on repeat", async () => {
    const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
    await core.setManifest([slotA()]); // v1

    const first = await core.retireSlot("icon.a");
    expect(first.alreadyRetired).toBe(false);
    expect(typeof first.retiredAt).toBe("string");
    expect(first.manifest.version).toBe(2);
    const stillThere = first.manifest.slots.find((s) => s.id === "icon.a");
    expect(stillThere).toBeDefined();
    expect(stillThere?.retiredAt).toBe(first.retiredAt);

    const second = await core.retireSlot("icon.a");
    expect(second.alreadyRetired).toBe(true);
    expect(second.retiredAt).toBe(first.retiredAt);
    expect(second.manifest.version).toBe(2);
  });

  it("retireSlot on an unknown id throws CommandError", async () => {
    const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
    await core.setManifest([slotA()]);
    await expect(core.retireSlot("icon.unknown")).rejects.toBeInstanceOf(
      CommandError,
    );
  });

  describe("retireSlotsByOrigin", () => {
    function seedFourOriginManifest(): SurfaceSlot[] {
      return [
        slotA({ id: "icon.scan-1", origin: "scan" }),
        slotB({ id: "icon.scan-2", origin: "scan" }),
        slotA({ id: "icon.authored-1", origin: "authored" }),
        slotB({ id: "icon.request-1", origin: "request" }),
      ];
    }

    it("bulk retires every active slot of one origin in ONE versioned write (SC-08)", async () => {
      const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
      const seeded = await core.setManifest(seedFourOriginManifest()); // v1
      expect(seeded.version).toBe(1);

      const result = await core.retireSlotsByOrigin("scan");
      expect(result.retiredIds).toEqual(["icon.scan-1", "icon.scan-2"]);
      expect(result.alreadyRetiredCount).toBe(0);
      expect(result.manifest.version).toBe(2); // ONE write, not N

      const scan1 = slotById(result.manifest, "icon.scan-1")!;
      const scan2 = slotById(result.manifest, "icon.scan-2")!;
      expect(scan1.retiredAt).toBeTruthy();
      expect(scan1.retiredAt).toBe(scan2.retiredAt); // one shared timestamp
    });

    it("is idempotent — a second run writes nothing and does not bump the version (SC-08)", async () => {
      const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
      await core.setManifest(seedFourOriginManifest());
      const first = await core.retireSlotsByOrigin("scan");

      const second = await core.retireSlotsByOrigin("scan");
      expect(second.retiredIds).toEqual([]);
      expect(second.alreadyRetiredCount).toBe(2);
      expect(second.manifest.version).toBe(first.manifest.version);
      expect(second.manifest.updatedAt).toBe(first.manifest.updatedAt);
    });

    it("is strictly origin-scoped — authored and request slots are untouched (SC-08)", async () => {
      const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
      const seededSlots = seedFourOriginManifest();
      await core.setManifest(seededSlots);
      const result = await core.retireSlotsByOrigin("scan");

      const authored = slotById(result.manifest, "icon.authored-1")!;
      const requested = slotById(result.manifest, "icon.request-1")!;
      expect(isSlotRetired(authored)).toBe(false);
      expect(isSlotRetired(requested)).toBe(false);
      expect(authored).toEqual(seededSlots.find((s) => s.id === "icon.authored-1"));
      expect(requested).toEqual(seededSlots.find((s) => s.id === "icon.request-1"));
    });

    it("is non-destructive — nothing is removed from the manifest", async () => {
      const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
      await core.setManifest(seedFourOriginManifest());
      const result = await core.retireSlotsByOrigin("scan");

      expect(result.manifest.slots.length).toBe(4);
      const scan1 = slotById(result.manifest, "icon.scan-1")!;
      expect(scan1).toBeDefined();
      expect(scan1.attributions).toEqual([]);
    });

    it("is a no-op, not an error, when zero active slots match the origin", async () => {
      const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
      const seeded = await core.setManifest([slotA({ origin: "authored" })]); // v1

      const result = await core.retireSlotsByOrigin("scan");
      expect(result.retiredIds).toEqual([]);
      expect(result.alreadyRetiredCount).toBe(0);
      expect(result.manifest.version).toBe(seeded.version);
    });

    it("fails loudly, writing nothing, when no manifest exists at all", async () => {
      const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
      await expect(core.retireSlotsByOrigin("scan")).rejects.toBeInstanceOf(
        CommandError,
      );
      await expect(core.retireSlotsByOrigin("scan")).rejects.toThrow(
        /brand\/surface\.yaml/,
      );
      await expect(
        fs.access(path.join(tmpDir, "brand", "surface.yaml")),
      ).rejects.toThrow();
    });

    it("passes expectedVersion/force through to writeSlots unchanged", async () => {
      const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
      await core.setManifest(seedFourOriginManifest()); // v1
      await core.setManifest(seedFourOriginManifest()); // v2

      await expect(
        core.retireSlotsByOrigin("scan", { expectedVersion: 1 }),
      ).rejects.toBeInstanceOf(VersionConflictError);

      const forced = await core.retireSlotsByOrigin("scan", {
        expectedVersion: 1,
        force: true,
      });
      expect(forced.retiredIds).toEqual(["icon.scan-1", "icon.scan-2"]);
    });

    it("retires each origin independently without re-stamping an already-retired slot", async () => {
      const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
      await core.setManifest(seedFourOriginManifest());
      const scanResult = await core.retireSlotsByOrigin("scan");
      const scan1Before = slotById(scanResult.manifest, "icon.scan-1")!.retiredAt;

      const requestResult = await core.retireSlotsByOrigin("request");
      expect(requestResult.retiredIds).toEqual(["icon.request-1"]);
      const scan1After = slotById(requestResult.manifest, "icon.scan-1")!.retiredAt;
      expect(scan1After).toBe(scan1Before);
    });
  });

  it("editSlot merges the patch, validated", async () => {
    const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
    await core.setManifest([slotA()]);

    const edited = await core.editSlot("icon.a", {
      criticality: "preferred",
      context: { tone: "playful" },
    });
    expect(edited.version).toBe(2);
    const slot = edited.slots.find((s) => s.id === "icon.a")!;
    expect(slot.criticality).toBe("preferred");
    expect(slot.context).toEqual({ tone: "playful" });

    await expect(
      core.editSlot("icon.unknown", { criticality: "preferred" }),
    ).rejects.toThrow(/Slot not found/);

    const beforeBadEdit = await core.read();
    await expect(
      core.editSlot("icon.a", { kind: "graphic" as never }),
    ).rejects.toThrow(/icon, illustration, color-role, type-role, other/);
    const afterBadEdit = await core.read();
    expect(afterBadEdit).toEqual(beforeBadEdit);

    await core.retireSlot("icon.a");
    await expect(
      core.editSlot("icon.a", { criticality: "required" }),
    ).rejects.toThrow(/retired/);
  });

  it("teaching rejections pass through setManifest/patchSlots as CommandError", async () => {
    const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
    const badSlot = slotA({ kind: "graphic" as never });

    let err: unknown;
    try {
      await core.setManifest([badSlot]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommandError);
    expect((err as Error).message).toContain(
      "icon, illustration, color-role, type-role, other",
    );
    await expect(
      fs.access(path.join(tmpDir, "brand", "surface.yaml")),
    ).rejects.toThrow();

    await core.setManifest([slotA()]);
    await expect(core.patchSlots([badSlot])).rejects.toBeInstanceOf(CommandError);
  });

  it("requestSlot on a retired slot records demand without reviving", async () => {
    const core = createSurfaceCore(tmpDir, buildTestConfig(tmpDir));
    await core.setManifest([slotA()]);
    await core.retireSlot("icon.a");

    const attribution = { author: "tim", source: "cli", date: "2026-01-03T00:00:00.000Z" };
    const { manifest, deduped } = await core.requestSlot(slotA(), attribution);
    expect(deduped).toBe(true);
    const slot = manifest.slots.find((s) => s.id === "icon.a")!;
    expect(slot.retiredAt).toBeDefined();
    expect(slot.attributions.at(-1)).toEqual(attribution);
  });

  it("honors a custom brand.surface config path", async () => {
    const config = buildTestConfig(tmpDir, path.join(tmpDir, "custom", "demand.yaml"));
    const core = createSurfaceCore(tmpDir, config);
    await core.setManifest([slotA()]);

    await expect(
      fs.access(path.join(tmpDir, "custom", "demand.yaml")),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(tmpDir, "brand", "surface.yaml")),
    ).rejects.toThrow();
  });
});
