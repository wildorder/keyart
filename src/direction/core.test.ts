import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDirectionCore } from "./core.js";
import { parseDirectionMemory, parseDirectionRecord } from "./schema.js";
import { CommandError } from "../errors.js";
import { VersionConflictError } from "../store/versioned-store.js";
import { selectNegatives, assembleContext } from "../brand/assemble-context.js";
import { promoteEntryToGlobal } from "../brand/promote-to-global.js";
import { createBrandCore } from "../brand/core.js";
import type { ContradictionDeps } from "../brand/conflict-guard.js";
import type { KeyartConfig } from "../types.js";

let tmpDir: string;
let config: KeyartConfig;

function makeConfig(directionsDir: string): KeyartConfig {
  return {
    project: { name: "test", type: "web", framework: "react" },
    brand: {
      root: "brand",
      references: "brand/references",
      approved: "brand/approved",
      rejected: "brand/rejected",
      directions: directionsDir,
    },
    models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
    outputs: {
      cursorRules: ".cursor/rules",
      cssVars: "brand/vars.css",
      implementationBrief: "brand/impl.md",
    },
    store: { driver: "file" },
  };
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-direction-"));
  config = makeConfig(path.join(tmpDir, "brand", "directions"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function directionDir(id: string): string {
  return path.join(tmpDir, "brand", "directions", id);
}

describe("create + get round-trip", () => {
  it("creates a direction with direction.yaml and memory.yaml on disk, a draft (no versions/head)", async () => {
    const core = createDirectionCore(tmpDir, config);
    const record = await core.create({ id: "moody", name: "Moody" });

    expect(record.status).toBe("active");
    expect(record.version).toBe(1);
    expect(record.versions).toEqual([]);
    expect(record.head).toBeNull();
    expect(record.createdAt).toMatch(ISO_RE);
    expect(record.updatedAt).toMatch(ISO_RE);

    expect(await fs.stat(path.join(directionDir("moody"), "direction.yaml"))).toBeTruthy();
    expect(await fs.stat(path.join(directionDir("moody"), "memory.yaml"))).toBeTruthy();

    expect(await core.get("moody")).toEqual(record);

    const mem = await core.readMemory("moody");
    expect(mem.directionId).toBe("moody");
    expect(mem.entries).toEqual([]);
    expect(mem.version).toBe(1);
  });
});

describe("duplicate + invalid id", () => {
  it("rejects a duplicate id with 'already exists'", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await expect(
      core.create({ id: "moody", name: "Moody Again" }),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects an invalid id with 'kebab-case' and creates no dir", async () => {
    const core = createDirectionCore(tmpDir, config);
    await expect(core.create({ id: "Bad Id", name: "x" })).rejects.toThrow(/kebab-case/);
    await expect(fs.stat(directionDir("Bad Id"))).rejects.toThrow();
  });
});

describe("get missing throws", () => {
  it("rejects with CommandError naming the direction", async () => {
    const core = createDirectionCore(tmpDir, config);
    await expect(core.get("ghost")).rejects.toThrow(/Direction not found: ghost/);
    await expect(core.get("ghost")).rejects.toBeInstanceOf(CommandError);
  });
});

describe("update bumps version + optimistic guard", () => {
  it("bumps version, rejects stale writes, and forces through", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const v2 = await core.update("moody", (c) => ({ ...c, name: "Moody 2" }));
    expect(v2.version).toBe(2);
    expect(v2.name).toBe("Moody 2");
    expect(v2.updatedAt >= v2.createdAt).toBe(true);

    await expect(
      core.update("moody", (c) => ({ ...c, name: "Moody 3" }), { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    const forced = await core.update(
      "moody",
      (c) => ({ ...c, name: "Moody Forced" }),
      { force: true },
    );
    expect(forced.name).toBe("Moody Forced");
  });
});

describe("transition rules", () => {
  it("follows the same lifecycle as before", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    expect((await core.transition("moody", "park")).status).toBe("parked");
    expect((await core.transition("moody", "revive")).status).toBe("active");
    expect((await core.transition("moody", "reject")).status).toBe("rejected");
    expect((await core.transition("moody", "revive")).status).toBe("active");

    await expect(core.transition("moody", "revive")).rejects.toBeInstanceOf(CommandError);

    await core.transition("moody", "approve");
    await expect(core.transition("moody", "park")).rejects.toBeInstanceOf(CommandError);
  });

  it("archive transitions from every state, throws when already archived, revives to active (WS-05)", async () => {
    const core = createDirectionCore(tmpDir, config);
    for (const [id, prep] of [
      ["arch-active", []],
      ["arch-parked", ["park"]],
      ["arch-rejected", ["reject"]],
      ["arch-approved", ["approve"]],
    ] as const) {
      await core.create({ id, name: id });
      for (const verb of prep) await core.transition(id, verb);
      expect((await core.transition(id, "archive")).status).toBe("archived");
    }

    // Idempotence guard: a second archive teaches, never a silent second write.
    await expect(
      core.transition("arch-active", "archive"),
    ).rejects.toThrow(/already archived/);

    // Reversible: revive restores an archived direction to active.
    expect((await core.transition("arch-active", "revive")).status).toBe(
      "active",
    );
  });
});

describe("appendFeedback/Learning/Decision attribute + accumulate", () => {
  it("attributes entries and accumulates", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const afterFeedback = await core.appendFeedback("moody", {
      body: "too cold",
      author: "tim",
      source: "cli",
    });
    expect(afterFeedback.entries).toHaveLength(1);
    expect(afterFeedback.version).toBe(2); // memory was v1 from create

    const entry = afterFeedback.entries[0];
    expect(entry.kind).toBe("feedback");
    expect(entry.author).toBe("tim");
    expect(entry.source).toBe("cli");
    expect(entry.date).toMatch(ISO_RE);
    expect(entry.id.length).toBeGreaterThan(0);

    const afterLearning = await core.appendLearning("moody", {
      body: "users like serif",
      author: "agent",
      source: "audit",
    });
    expect(afterLearning.version).toBe(3);

    const afterDecision = await core.appendDecision("moody", {
      body: "go editorial",
      author: "tim",
      source: "cli",
    });
    expect(afterDecision.version).toBe(4);
    expect(afterDecision.entries).toHaveLength(3);

    const ids = afterDecision.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("append against missing direction throws (isolation)", () => {
  it("rejects and writes nothing under the ghost dir", async () => {
    const core = createDirectionCore(tmpDir, config);
    await expect(
      core.appendFeedback("ghost", { body: "x", author: "tim", source: "cli" }),
    ).rejects.toThrow(/Direction not found/);
    await expect(fs.stat(directionDir("ghost"))).rejects.toThrow();
  });
});

describe("Test 7: memory is direction-isolated by location", () => {
  it("keeps each direction's memory entirely separate; a's memory.yaml carries directionId anchor", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "a", name: "A" });
    await core.create({ id: "b", name: "B" });

    await core.appendDecision("a", { body: "A_DECISION_TEXT", author: "tim", source: "cli" });
    await core.appendFeedback("b", { body: "B_FEEDBACK_TEXT", author: "tim", source: "cli" });

    const aEntries = await core.memoryEntries("a");
    const bEntries = await core.memoryEntries("b");

    expect(aEntries).toHaveLength(1);
    expect(aEntries[0].body).toBe("A_DECISION_TEXT");
    expect(bEntries).toHaveLength(1);
    expect(bEntries[0].body).toBe("B_FEEDBACK_TEXT");

    const aRaw = await fs.readFile(path.join(directionDir("a"), "memory.yaml"), "utf-8");
    const bRaw = await fs.readFile(path.join(directionDir("b"), "memory.yaml"), "utf-8");
    expect(aRaw).toContain("A_DECISION_TEXT");
    expect(aRaw).not.toContain("B_FEEDBACK_TEXT");
    expect(aRaw).toContain("directionId: a");
    expect(bRaw).toContain("B_FEEDBACK_TEXT");
    expect(bRaw).not.toContain("A_DECISION_TEXT");
  });
});

describe("addAsset registers refs version-safely", () => {
  it("is idempotent by path and version-bumps once per new asset", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const v2 = await core.addAsset("moody", { kind: "image", path: "assets/a.png" });
    expect(v2.version).toBe(2);
    expect(v2.assets).toHaveLength(1);

    // Re-registering the same path is a content no-op (assets[] unchanged),
    // though the write itself still bumps the version counter.
    const again = await core.addAsset("moody", { kind: "image", path: "assets/a.png" });
    expect(again.assets).toHaveLength(1);

    const v3 = await core.addAsset("moody", { kind: "image", path: "assets/b.png" });
    expect(v3.assets).toHaveLength(2);
  });
});

describe("imageAssetPaths filters to image assets, no scope filter", () => {
  it("returns only image-kind, non-retired assets with intent defaulted to inspire", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.addAsset("moody", { kind: "image", path: "assets/hero.png", note: "hero" });
    await core.addAsset("moody", { kind: "font", path: "assets/font.woff2" });
    await core.addAsset("moody", { kind: "image", path: "assets/extract.png", intent: "extract" });

    const images = await core.imageAssetPaths("moody");
    expect(images).toEqual([
      { path: "assets/hero.png", note: "hero", intent: "inspire" },
      { path: "assets/extract.png", intent: "extract" },
    ]);
  });
});

describe("recordReferenceNote records attributed learning", () => {
  it("appends a learning entry naming the path and optional note", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const mem = await core.recordReferenceNote("moody", {
      path: "assets/hero.png",
      author: "tim",
      source: "cli",
      note: "the hero shot",
    });
    expect(mem.entries).toHaveLength(1);
    expect(mem.entries[0].kind).toBe("learning");
    expect(mem.entries[0].body).toContain("assets/hero.png");
    expect(mem.entries[0].body).toContain("the hero shot");
  });
});

describe("recordColorLock writes an attributed decision", () => {
  it("body carries the exact hex and optional label", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const mem = await core.recordColorLock("moody", {
      hex: "#336699",
      author: "tim",
      source: "cli",
      note: "brand blue",
    });
    expect(mem.entries[0].kind).toBe("decision");
    expect(mem.entries[0].body).toBe("Color locked: #336699 (brand blue)");
  });
});

describe("brief: versioned patch + projection chokepoint", () => {
  it("setBriefFields shallow-merges, rewrites brief.md, and getRenderedBrief is the projection", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    await core.setBriefFields("moody", { oneLiner: "A warm brand.", tone: ["warm"] });
    const brief = await core.getBrief("moody");
    expect(brief.oneLiner).toBe("A warm brand.");
    expect(brief.tone).toEqual(["warm"]);

    const briefMd = await fs.readFile(path.join(directionDir("moody"), "brief.md"), "utf-8");
    expect(briefMd).toContain("A warm brand.");

    const rendered = await core.getRenderedBrief("moody");
    expect(rendered).toBe(briefMd);

    // patchBrief is the semantic alias — shallow merge, arrays replaced wholesale.
    await core.patchBrief("moody", { tone: ["warm", "confident"] });
    expect((await core.getBrief("moody")).tone).toEqual(["warm", "confident"]);
    expect((await core.getBrief("moody")).oneLiner).toBe("A warm brand."); // untouched key survives
  });
});

describe("Test 8: retire semantics survive the move", () => {
  it("deleteMemoryEntry retires non-destructively, excluded by default, included with includeRetired", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const mem1 = await core.appendFeedback("moody", { body: "will retire", author: "tim", source: "cli" });
    const target = mem1.entries[0];
    await core.appendFeedback("moody", { body: "stays live", author: "tim", source: "cli" });

    const afterDelete = await core.deleteMemoryEntry("moody", {
      entryId: target.id,
      author: "tim",
      source: "cli",
    });
    const retired = afterDelete.entries.find((e) => e.id === target.id)!;
    expect(retired.retiredAt).toMatch(ISO_RE);
    expect(retired.body).toBe("will retire"); // body unchanged

    const defaultView = await core.memoryEntries("moody");
    expect(defaultView.some((e) => e.id === target.id)).toBe(false);
    const withRetired = await core.memoryEntries("moody", { includeRetired: true });
    expect(withRetired.some((e) => e.id === target.id)).toBe(true);
  });

  it("editMemoryEntry appends a corrected entry, marks the original retiredAt+supersededBy, carries the source's kind", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const mem1 = await core.appendDecision("moody", { body: "old body", author: "tim", source: "cli" });
    const source = mem1.entries[0];

    const after = await core.editMemoryEntry("moody", {
      entryId: source.id,
      body: "corrected body",
      author: "tim",
      source: "cli",
    });

    const original = after.entries.find((e) => e.id === source.id)!;
    expect(original.body).toBe("old body");
    expect(original.retiredAt).toMatch(ISO_RE);
    expect(original.supersededBy).toBeDefined();

    const corrected = after.entries.find((e) => e.id === original.supersededBy)!;
    expect(corrected.body).toBe("corrected body");
    expect(corrected.kind).toBe("decision");

    const live = await core.memoryEntries("moody");
    expect(live.some((e) => e.id === source.id)).toBe(false);
    expect(live.some((e) => e.id === corrected.id)).toBe(true);
  });
});

describe("retired entry skipped by selectNegatives", () => {
  it("a retired discard is excluded from the negatives list", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const mem = await core.appendFeedback("moody", {
      body: "garish neon",
      author: "tim",
      source: "cli",
      asset: "assets/discard.png",
    });
    const target = mem.entries[0];
    await core.retireMemoryEntry("moody", { entryId: target.id, author: "tim", source: "cli" });

    const withRetired = await core.memoryEntries("moody", { includeRetired: true });
    expect(selectNegatives(withRetired)).not.toContain("garish neon");
  });
});

describe("Test 15: promoteMemoryEntry is gone; promoteEntryToGlobal is the only promote path", () => {
  it("DirectionCore exposes no promoteMemoryEntry", async () => {
    const core = createDirectionCore(tmpDir, config);
    expect(core).not.toHaveProperty("promoteMemoryEntry");
  });

  it("promoteEntryToGlobal creates exactly one GlobalRule and retires the source", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    const mem = await core.appendDecision("moody", {
      body: "use bold serif headlines",
      author: "tim",
      source: "cli",
      channel: "visual",
      polarity: "prefer",
    });
    const entry = mem.entries[0];

    const brandCore = createBrandCore(tmpDir, config);
    const before = await brandCore.read();
    expect(before.rules).toHaveLength(0);

    const result = await promoteEntryToGlobal(
      { brandCore, directionCore: core },
      {
        directionId: "moody",
        entry: { id: entry.id, body: entry.body, channel: entry.channel, polarity: entry.polarity },
        author: "tim",
        source: "cli",
      },
    );

    const after = await brandCore.read();
    expect(after.rules).toHaveLength(1);
    expect(after.rules[0].text).toBe("use bold serif headlines");
    expect(result.ruleId).toBe(after.rules[0].id);

    const memAfter = await core.memoryEntries("moody", { includeRetired: true });
    const retired = memAfter.find((e) => e.id === entry.id)!;
    expect(retired.retiredAt).toBeDefined();
  });
});

describe("listContradictions: per-direction isolation + semantic adapter", () => {
  it("returns a report with the deterministic floor; never reads a sibling direction", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "a", name: "A" });
    await core.create({ id: "b", name: "B" });
    await core.appendDecision("a", { body: "use bold typography", author: "tim", source: "cli" });
    await core.appendDecision("b", { body: "SIBLING_TEXT_SHOULD_NOT_LEAK", author: "tim", source: "cli" });

    const deps: ContradictionDeps | undefined = undefined;
    const report = await core.listContradictions("a", deps, { id: "live-1", text: "avoid bold typography" });
    expect(JSON.stringify(report)).not.toContain("SIBLING_TEXT_SHOULD_NOT_LEAK");
  });
});

describe("Test 9: retireAsset writes both stores and is idempotent", () => {
  it("retires a kept crop by path, appends exactly one attributed learning, and drops it from imageAssetPaths", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const assetPath = "assets/keep/a.png";
    await core.addAsset("moody", { kind: "image", path: assetPath, note: "hero crop", intent: "inspire" });
    const versionBefore = (await core.get("moody")).version;

    const updated = await core.retireAsset("moody", {
      path: assetPath,
      author: "tim",
      source: "cli",
      reason: "no longer relevant",
    });
    expect(updated.version).toBe(versionBefore + 1);

    const retiredAsset = updated.assets.find((a) => a.path === assetPath)!;
    expect(retiredAsset.retiredAt).toMatch(ISO_RE);

    const learnings = (await core.memoryEntries("moody")).filter((e) => e.kind === "learning");
    expect(learnings).toHaveLength(1);
    expect(learnings[0].body).toContain("no longer relevant");

    expect(() => parseDirectionRecord(updated)).not.toThrow();
    const memAfterRetire = await core.readMemory("moody");
    expect(() => parseDirectionMemory(memAfterRetire)).not.toThrow();

    const images = await core.imageAssetPaths("moody");
    expect(images.some((r) => r.path === assetPath)).toBe(false);

    // Idempotent: second call is a no-op — no version bump, no second audit.
    const again = await core.retireAsset("moody", { path: assetPath, author: "tim", source: "cli" });
    expect(again.version).toBe(updated.version);
    const learningsAfter = (await core.memoryEntries("moody")).filter((e) => e.kind === "learning");
    expect(learningsAfter).toHaveLength(1);
  });

  it("throws CommandError for a missing direction / missing asset, writing nothing", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    await expect(
      core.retireAsset("nope", { path: "x.png", author: "tim", source: "cli" }),
    ).rejects.toBeInstanceOf(CommandError);

    const before = await core.get("moody");
    await expect(
      core.retireAsset("moody", { path: "does/not/exist.png", author: "tim", source: "cli" }),
    ).rejects.toBeInstanceOf(CommandError);

    const after = await core.get("moody");
    expect(after.version).toBe(before.version);
  });
});

describe("assembleContext consumes DirectionCore.memoryEntries directly (no filter)", () => {
  it("passes memory straight through as the only memory source", async () => {
    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.appendDecision("moody", { body: "go bold", author: "tim", source: "cli", channel: "visual", polarity: "prefer" });

    const memory = await core.memoryEntries("moody");
    const assembled = assembleContext({
      brief: "brief text",
      global: { approvedPointer: null, rules: [], version: 0, createdAt: "", updatedAt: "" },
      memory,
    });
    expect(assembled.memory).toEqual(memory);
  });
});
