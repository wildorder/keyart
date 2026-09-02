import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createBrandCore, type BrandCore, type PromoteLearningInput } from "./core.js";
import { createDirectionCore } from "../direction/core.js";
import { promoteEntryToGlobal, PromotePartialError } from "./promote-to-global.js";
import { VersionConflictError } from "../store/versioned-store.js";
import type { KeyartConfig } from "../types.js";
import type { GlobalBrand } from "./schema.js";

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-promote-global-"));
  config = makeConfig(path.join(tmpDir, "brand", "directions"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("promoteEntryToGlobal", () => {
  it("promotes the source entry into a global rule and retires the source — no double-count", async () => {
    const brandCore = createBrandCore(tmpDir, config);
    const directionCore = createDirectionCore(tmpDir, config);
    await directionCore.create({ id: "moody", name: "Moody" });
    const memoryBefore = await directionCore.appendLearning("moody", {
      body: "Editorial serif headlines test well",
      author: "tim",
      source: "cli",
    });
    const entry = memoryBefore.entries[0];

    const result = await promoteEntryToGlobal(
      { brandCore, directionCore },
      {
        directionId: "moody",
        entry: { id: entry.id, body: entry.body, channel: "visual", polarity: "prefer" },
        author: "tim",
        source: "cli",
        expectedGlobalVersion: (await brandCore.read()).version,
        expectedMemoryVersion: memoryBefore.version,
      },
    );

    expect(result.ruleId).toMatch(/^rule-/);

    const brand = await brandCore.read();
    const rule = brand.rules.find((r) => r.id === result.ruleId)!;
    expect(rule).toBeDefined();
    expect(rule.source).toBe("promote:moody");
    expect(rule.channel).toBe("visual");
    expect(rule.polarity).toBe("prefer");
    expect(rule.retiredAt).toBeUndefined();
    expect(brand.version).toBe(result.globalVersion);

    const memory = await directionCore.readMemory("moody");
    const sourceEntry = memory.entries.find((e) => e.id === entry.id)!;
    expect(sourceEntry.retiredAt).toMatch(ISO_RE);
    // an attributed audit `learning` entry was appended.
    expect(
      memory.entries.some(
        (e) => e.kind === "learning" && e.body.includes(`Promoted to global rule ${result.ruleId}`),
      ),
    ).toBe(true);
    expect(memory.version).toBe(result.memoryVersion);
  });

  it("preflights BOTH versions and rejects a stale expected version before writing either store", async () => {
    const brandCore = createBrandCore(tmpDir, config);
    const directionCore = createDirectionCore(tmpDir, config);
    await directionCore.create({ id: "moody", name: "Moody" });
    const memoryBefore = await directionCore.appendLearning("moody", {
      body: "Warm palettes read as inviting",
      author: "tim",
      source: "cli",
    });
    const entry = memoryBefore.entries[0];
    const globalBefore = await brandCore.read();

    await expect(
      promoteEntryToGlobal(
        { brandCore, directionCore },
        {
          directionId: "moody",
          entry: { id: entry.id, body: entry.body },
          author: "tim",
          source: "cli",
          expectedGlobalVersion: globalBefore.version + 5, // stale
          expectedMemoryVersion: memoryBefore.version,
        },
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);

    // Neither store was touched.
    const globalAfter = await brandCore.read();
    expect(globalAfter.version).toBe(globalBefore.version);
    expect(globalAfter.rules).toHaveLength(0);
    const memoryAfter = await directionCore.readMemory("moody");
    expect(memoryAfter.version).toBe(memoryBefore.version);
    expect(memoryAfter.entries.find((e) => e.id === entry.id)?.retiredAt).toBeUndefined();

    await expect(
      promoteEntryToGlobal(
        { brandCore, directionCore },
        {
          directionId: "moody",
          entry: { id: entry.id, body: entry.body },
          author: "tim",
          source: "cli",
          expectedGlobalVersion: globalBefore.version,
          expectedMemoryVersion: memoryBefore.version + 5, // stale
        },
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect((await brandCore.read()).rules).toHaveLength(0);

    // force bypasses the preflight entirely.
    const forced = await promoteEntryToGlobal(
      { brandCore, directionCore },
      {
        directionId: "moody",
        entry: { id: entry.id, body: entry.body },
        author: "tim",
        source: "cli",
        expectedGlobalVersion: globalBefore.version + 5,
        expectedMemoryVersion: memoryBefore.version + 5,
        force: true,
      },
    );
    expect(forced.ruleId).toMatch(/^rule-/);
  });

  it("surfaces an explicit partial (no rollback claim) on a residual second-write race", async () => {
    const brandCore = createBrandCore(tmpDir, config);
    const directionCore = createDirectionCore(tmpDir, config);
    await directionCore.create({ id: "moody", name: "Moody" });
    const memoryBefore = await directionCore.appendLearning("moody", {
      body: "Never mix warm and cool neutrals",
      author: "tim",
      source: "cli",
    });
    const entry = memoryBefore.entries[0];
    const globalBefore = await brandCore.read();

    // A brandCore wrapper whose promoteLearning, as a side effect, simulates a
    // SECOND handle advancing the memory doc during the global-write window —
    // the residual race the seam has no cross-store transaction to prevent.
    const racyBrandCore: BrandCore = {
      ...brandCore,
      async promoteLearning(input: PromoteLearningInput, opts) {
        const result = await brandCore.promoteLearning(input, opts);
        await directionCore.appendLearning("moody", {
          body: "Concurrent unrelated note",
          author: "other",
          source: "other",
        });
        return result;
      },
    };

    let caught: unknown;
    try {
      await promoteEntryToGlobal(
        { brandCore: racyBrandCore, directionCore },
        {
          directionId: "moody",
          entry: { id: entry.id, body: entry.body },
          author: "tim",
          source: "cli",
          expectedGlobalVersion: globalBefore.version,
          expectedMemoryVersion: memoryBefore.version,
        },
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PromotePartialError);
    const partial = caught as PromotePartialError;
    expect(partial.committed).toBe("global");
    expect(partial.ruleId).toMatch(/^rule-/);
    expect(partial.retryable).toBe(true);
    expect(partial.expectedMemoryVersion).toBe(memoryBefore.version);
    expect(partial.actualMemoryVersion).toBe(memoryBefore.version + 1);

    // The global rule IS present (not rolled back) — the partial is honest.
    const brand: GlobalBrand = await brandCore.read();
    const rule = brand.rules.find((r) => r.id === partial.ruleId);
    expect(rule).toBeDefined();

    // The source entry is NOT retired.
    const memory = await directionCore.readMemory("moody");
    expect(memory.entries.find((e) => e.id === entry.id)?.retiredAt).toBeUndefined();
  });
});
