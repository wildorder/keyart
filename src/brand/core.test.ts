import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createBrandCore } from "./core.js";
import { parseGlobalBrand, type GlobalBrand } from "./schema.js";
import { assembleContext } from "./assemble-context.js";
import { createSingleDocStore } from "../store/create-store.js";
import { VersionConflictError } from "../store/versioned-store.js";
import { CommandError } from "../errors.js";
import type { KeyartConfig } from "../types.js";

let tmpDir: string;
let config: KeyartConfig;

function makeConfig(): KeyartConfig {
  return {
    project: { name: "test", type: "web", framework: "react" },
    brand: {
      root: "brand",
      references: "brand/references",
      approved: "brand/approved",
      rejected: "brand/rejected",
      // global defaults to "<brand.root>/brand.yaml"
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

function brandFile(): string {
  return path.join(tmpDir, "brand", "brand.yaml");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-brand-"));
  config = makeConfig();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("read scaffolds in-memory, never writes", () => {
  it("returns an empty brand and writes nothing to disk", async () => {
    const core = createBrandCore(tmpDir, config);
    const brand = await core.read();

    expect(brand.approvedPointer).toBeNull();
    expect(brand.rules).toEqual([]);
    expect(brand.version).toBe(0);
    expect(brand.createdAt).toMatch(ISO_RE);

    expect(await exists(brandFile())).toBe(false);
  });
});

describe("addRule persists + versions", () => {
  it("appends rules and bumps the version on each deliberate write", async () => {
    const core = createBrandCore(tmpDir, config);

    const v1 = await core.addRule({
      severity: "hard",
      text: "Never use pure black",
      author: "tim",
      source: "cli",
    });
    expect(v1.rules).toHaveLength(1);
    expect(v1.version).toBe(1);
    expect(v1.rules[0].severity).toBe("hard");
    expect(v1.rules[0].date).toMatch(ISO_RE);
    expect(await exists(brandFile())).toBe(true);

    const v2 = await core.addRule({
      severity: "guideline",
      text: "Prefer generous whitespace",
      author: "tim",
      source: "cli",
    });
    expect(v2.rules).toHaveLength(2);
    expect(v2.version).toBe(2);
    expect(new Set(v2.rules.map((r) => r.id)).size).toBe(2);
  });
});

describe("setPointer persists + preserves rules", () => {
  it("sets the approved pointer while keeping rules across repoints", async () => {
    const core = createBrandCore(tmpDir, config);

    await core.addRule({
      severity: "hard",
      text: "Never use pure black",
      author: "tim",
      source: "cli",
    });

    const pointed = await core.setPointer({
      directionId: "direction-a",
      versionId: "v1",
    });
    expect(pointed.approvedPointer).not.toBeNull();
    expect(pointed.approvedPointer?.directionId).toBe("direction-a");
    expect(pointed.approvedPointer?.approvedAt).toMatch(ISO_RE);
    // rebrand-keeps-rules guarantee
    expect(pointed.rules).toHaveLength(1);

    const repointed = await core.setPointer({
      directionId: "direction-b",
      versionId: "v2",
    });
    expect(repointed.approvedPointer?.directionId).toBe("direction-b");
    // rules still present after the repoint
    expect(repointed.rules).toHaveLength(1);
    expect(repointed.rules[0].text).toBe("Never use pure black");
  });
});

describe("promoteLearning records source attribution", () => {
  it("defaults to guideline severity and records promote:<directionId>", async () => {
    const core = createBrandCore(tmpDir, config);

    const result = await core.promoteLearning({
      fromDirectionId: "moody",
      text: "Editorial serif headlines test well",
      author: "tim",
    });

    const rule = result.rules[result.rules.length - 1];
    expect(rule.severity).toBe("guideline");
    expect(rule.source).toBe("promote:moody");
    expect(rule.text).toBe("Editorial serif headlines test well");
    expect(rule.author).toBe("tim");

    const explicit = await core.promoteLearning({
      fromDirectionId: "brutal",
      text: "Hard constraint learned",
      severity: "hard",
      author: "agent",
    });
    const hardRule = explicit.rules[explicit.rules.length - 1];
    expect(hardRule.severity).toBe("hard");
    expect(hardRule.source).toBe("promote:brutal");
  });
});

describe("no automatic writes", () => {
  it("brand.yaml appears only after a deliberate write", async () => {
    const core = createBrandCore(tmpDir, config);

    await core.read();
    await core.read();
    await core.read();
    expect(await exists(brandFile())).toBe(false);

    await core.addRule({
      severity: "hard",
      text: "x",
      author: "tim",
      source: "cli",
    });
    expect(await exists(brandFile())).toBe(true);
  });
});

describe("promoteLearning honors expectedVersion (WS-05)", () => {
  it("succeeds at current global version, fails on stale, and force bypasses it", async () => {
    const core = createBrandCore(tmpDir, config);

    // Establish an initial version.
    await core.addRule({ severity: "guideline", text: "Use warm tones", author: "tim", source: "cli" });
    const current = await core.read();
    const currentVersion = current.version; // should be 1

    // promoteLearning at the current version succeeds.
    const result = await core.promoteLearning(
      { fromDirectionId: "moody", text: "Editorial serifs work well", author: "tim" },
      { expectedVersion: currentVersion },
    );
    expect(result.version).toBe(currentVersion + 1);
    expect(result.rules.some((r) => r.text === "Editorial serifs work well")).toBe(true);

    // promoteLearning at a stale version throws VersionConflictError.
    await expect(
      core.promoteLearning(
        { fromDirectionId: "moody", text: "Another rule", author: "tim" },
        { expectedVersion: currentVersion }, // stale — doc is now at currentVersion + 1
      ),
    ).rejects.toBeInstanceOf(VersionConflictError);

    // force bypasses the version check.
    const forced = await core.promoteLearning(
      { fromDirectionId: "moody", text: "Forced rule", author: "tim" },
      { force: true },
    );
    expect(forced.rules.some((r) => r.text === "Forced rule")).toBe(true);
  });
});

describe("optimistic conflict", () => {
  it("rejects a stale guarded write and overrides with force", async () => {
    const core = createBrandCore(tmpDir, config);

    // Deliberate write through the core establishes v1 on disk.
    await core.addRule({
      severity: "hard",
      text: "Never use pure black",
      author: "tim",
      source: "cli",
    });

    // A second handle on the SAME file — the brand doc participates in the
    // WS-01 optimistic-concurrency contract.
    const raw = createSingleDocStore<GlobalBrand>({
      driver: "file",
      filePath: brandFile(),
      parse: parseGlobalBrand,
    });

    const v1 = await raw.read();
    expect(v1?.version).toBe(1);

    // Advance the on-disk version out from under the v1 handle.
    await raw.write({ ...(v1 as GlobalBrand) }, { expectedVersion: 1 });

    // A guarded write that still believes the doc is at v1 conflicts.
    await expect(
      raw.write({ ...(v1 as GlobalBrand) }, { expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    // force overrides the optimistic check, and the core's force path works too.
    const forced = await core.addRule(
      { severity: "guideline", text: "forced", author: "tim", source: "cli" },
      { force: true },
    );
    expect(forced.rules.some((r) => r.text === "forced")).toBe(true);
  });
});

describe("promoteLearning carries channel/polarity onto the rule", () => {
  it("stamps channel/polarity when provided, and omits both keys when absent", async () => {
    const core = createBrandCore(tmpDir, config);

    const withDirectives = await core.promoteLearning({
      fromDirectionId: "moody",
      text: "Never use pure black backgrounds",
      author: "tim",
      channel: "visual",
      polarity: "avoid",
    });
    const rule = withDirectives.rules[withDirectives.rules.length - 1];
    expect(rule.channel).toBe("visual");
    expect(rule.polarity).toBe("avoid");

    const withoutDirectives = await core.promoteLearning({
      fromDirectionId: "moody",
      text: "Editorial serifs work well",
      author: "tim",
    });
    const bareRule = withoutDirectives.rules[withoutDirectives.rules.length - 1];
    expect(bareRule.channel).toBeUndefined();
    expect(bareRule.polarity).toBeUndefined();
    expect("channel" in bareRule).toBe(false);
    expect("polarity" in bareRule).toBe(false);
  });
});

describe("removeRule retires a rule (non-destructive, excluded from both lanes)", () => {
  it("marks retiredAt without physically removing the rule; assembleContext drops it", async () => {
    const core = createBrandCore(tmpDir, config);

    const added = await core.addRule({
      severity: "guideline",
      text: "Prefer generous whitespace",
      author: "tim",
      source: "cli",
      channel: "visual",
      polarity: "prefer",
    });
    const ruleId = added.rules[0].id;

    const removed = await core.removeRule(ruleId);
    expect(removed.version).toBe(added.version + 1);
    // append-only: the rule still exists, now carrying retiredAt.
    const rule = removed.rules.find((r) => r.id === ruleId)!;
    expect(rule).toBeDefined();
    expect(rule.retiredAt).toMatch(ISO_RE);
    expect(rule.text).toBe("Prefer generous whitespace"); // untouched

    // Excluded from both the text lane (guidelines) and the image lane (visualDirectives).
    const ctx = assembleContext({
      brief: "A test brief",
      global: removed,
      memory: [],
    });
    expect(ctx.guidelines.some((r) => r.id === ruleId)).toBe(false);
    expect(ctx.hardRules.some((r) => r.id === ruleId)).toBe(false);
    expect(ctx.visualDirectives.prefer).not.toContain("Prefer generous whitespace");
    expect(ctx.visualDirectives.must).not.toContain("Prefer generous whitespace");
    expect(ctx.visualDirectives.avoid).not.toContain("Prefer generous whitespace");
  });

  it("requires force to remove a HARD rule (hard-rules-win)", async () => {
    const core = createBrandCore(tmpDir, config);

    const added = await core.addRule({
      severity: "hard",
      text: "Never use pure black",
      author: "tim",
      source: "cli",
    });
    const ruleId = added.rules[0].id;

    await expect(core.removeRule(ruleId)).rejects.toBeInstanceOf(CommandError);
    const unchanged = await core.read();
    expect(unchanged.version).toBe(added.version); // nothing written
    expect(unchanged.rules[0].retiredAt).toBeUndefined();

    const removed = await core.removeRule(ruleId, { force: true });
    expect(removed.rules[0].retiredAt).toMatch(ISO_RE);
  });

  it("is idempotent when already retired, and rejects an unknown id", async () => {
    const core = createBrandCore(tmpDir, config);

    const added = await core.addRule({
      severity: "guideline",
      text: "Use warm tones",
      author: "tim",
      source: "cli",
    });
    const ruleId = added.rules[0].id;

    const removed = await core.removeRule(ruleId);
    expect(removed.version).toBe(added.version + 1);

    // Retiring an already-retired rule is a no-op: no second write, version unchanged.
    const again = await core.removeRule(ruleId);
    expect(again.version).toBe(removed.version);
    expect(again).toEqual(removed);

    await expect(core.removeRule("nope")).rejects.toBeInstanceOf(CommandError);
    const stillUnchanged = await core.read();
    expect(stillUnchanged.version).toBe(removed.version);
  });
});

describe("editRule amends non-destructively (retire-and-replace)", () => {
  it("retires the old rule (unchanged text) and appends a replacement carrying the edit", async () => {
    const core = createBrandCore(tmpDir, config);

    const added = await core.addRule({
      severity: "guideline",
      text: "Use warm tones",
      author: "tim",
      source: "cli",
      channel: "visual",
      polarity: "prefer",
    });
    const oldId = added.rules[0].id;

    const edited = await core.editRule(oldId, { text: "Use cool tones" });
    expect(edited.version).toBe(added.version + 1);

    const oldRule = edited.rules.find((r) => r.id === oldId)!;
    expect(oldRule.retiredAt).toMatch(ISO_RE);
    expect(oldRule.text).toBe("Use warm tones"); // never mutated in place

    const newRule = edited.rules[edited.rules.length - 1];
    expect(newRule.id).not.toBe(oldId);
    expect(newRule.text).toBe("Use cool tones");
    expect(newRule.severity).toBe("guideline");
    expect(newRule.author).toBe("tim");
    expect(newRule.channel).toBe("visual");
    expect(newRule.polarity).toBe("prefer");
    expect(newRule.source).toBe(`edit:${oldId}`);
    expect(newRule.retiredAt).toBeUndefined();

    // both old (retired) and new (live) are present — edit=supersede.
    expect(edited.rules).toHaveLength(2);
  });

  it("requires force to edit a HARD rule, and to escalate a guideline to hard", async () => {
    const core = createBrandCore(tmpDir, config);

    const hard = await core.addRule({
      severity: "hard",
      text: "Never use pure black",
      author: "tim",
      source: "cli",
    });
    const hardId = hard.rules[0].id;

    await expect(core.editRule(hardId, { text: "Never use pure white" })).rejects.toBeInstanceOf(
      CommandError,
    );
    const unchanged = await core.read();
    expect(unchanged.version).toBe(hard.version); // nothing written

    const editedHard = await core.editRule(
      hardId,
      { text: "Never use pure white" },
      { force: true },
    );
    expect(editedHard.rules.find((r) => r.id === hardId)?.retiredAt).toMatch(ISO_RE);
    expect(editedHard.rules[editedHard.rules.length - 1].text).toBe("Never use pure white");

    const guideline = await core.addRule({
      severity: "guideline",
      text: "Prefer generous whitespace",
      author: "tim",
      source: "cli",
    });
    const guidelineId = guideline.rules.find((r) => r.text === "Prefer generous whitespace")!.id;

    await expect(
      core.editRule(guidelineId, { severity: "hard" }),
    ).rejects.toBeInstanceOf(CommandError);
    const stillGuideline = await core.read();
    expect(stillGuideline.version).toBe(guideline.version); // nothing written

    const escalated = await core.editRule(guidelineId, { severity: "hard" }, { force: true });
    const replacement = escalated.rules[escalated.rules.length - 1];
    expect(replacement.severity).toBe("hard");
  });

  it("rejects an unknown id or an already-retired rule", async () => {
    const core = createBrandCore(tmpDir, config);

    await expect(core.editRule("nope", { text: "x" })).rejects.toBeInstanceOf(CommandError);

    const added = await core.addRule({
      severity: "guideline",
      text: "Use warm tones",
      author: "tim",
      source: "cli",
    });
    const ruleId = added.rules[0].id;
    await core.removeRule(ruleId);

    await expect(core.editRule(ruleId, { text: "Use cool tones" })).rejects.toBeInstanceOf(
      CommandError,
    );
  });
});
