import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadDashboardData } from "./api.js";
import { loadConfig, globalBrandPath, directionsRoot } from "../config.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import {
  memoryEntryAffordances,
  assetAffordances,
  ruleAffordances,
} from "../direction/affordances.js";
import type { KeyartConfig, DirectionVersion } from "../types.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn() };
});

let tmpDir: string;

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Test Project", type: "prototype", framework: "next" },
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
      implementationBrief: path.join(cwd, "brand", "generated", "implementation-brief.md"),
    },
  };
}

/** A minimal on-disk `DirectionVersion` (identity + frozen provenance + content). */
function makeVersion(id: string, over: Partial<DirectionVersion> = {}): DirectionVersion {
  return {
    id,
    name: `Version ${id}`,
    summary: "a summary",
    positioning: "premium",
    character: { mood: "bold" },
    homepageMockupPrompt: "hp",
    styleTilePrompt: "st",
    copyExamples: { headline: "H", subheadline: "S", cta: "C" },
    usage: { rules: ["r1", "r2", "r3"], antiRules: ["a1", "a2"] },
    createdAt: "2026-01-01T00:00:00.000Z",
    briefSnapshot: "brief",
    contextSnapshot: "ctx",
    ...over,
  };
}

/**
 * Writes each version straight into the on-disk direction store:
 * `directionsRoot/<directionId>/versions/<verId>/direction-version.json`, then
 * registers it on the ALREADY-CREATED direction via `core.appendVersion` (the
 * head advances to each version in turn — Direction is the aggregate root now,
 * there is no separate index file). `imagesFor` optionally names artifact
 * files to drop inside a version folder. Assumes the caller already created
 * the direction (`core.create`) — this only ever appends versions to it.
 */
async function writeVersions(
  config: KeyartConfig,
  directionId: string,
  versions: DirectionVersion[],
  imagesFor?: (v: DirectionVersion) => string[],
): Promise<void> {
  const core = createDirectionCore(tmpDir, config);
  const root = directionsRoot(tmpDir, config);
  for (const v of versions) {
    const vdir = path.join(root, directionId, "versions", v.id);
    await fs.mkdir(vdir, { recursive: true });
    await fs.writeFile(
      path.join(vdir, "direction-version.json"),
      JSON.stringify(v),
    );
    for (const file of imagesFor?.(v) ?? []) {
      await fs.writeFile(path.join(vdir, file), Buffer.from([0x89, 0x50]));
    }
    await core.appendVersion(directionId, v.id);
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-test-"));
  // Default: no config. Direction tests override per-test.
  vi.mocked(loadConfig).mockRejectedValue(new Error("config not found"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("loadDashboardData", () => {
  it("returns empty sections and no throw on empty brand dir", async () => {
    const data = await loadDashboardData(tmpDir);

    expect(data.projectName).toBe("Keyart Project");
    expect(data.directions).toEqual([]);
    expect(data.approved).toBeNull();
    expect(data.guides.visualStyle).toBeNull();
    expect(data.guides.brand).toBeNull();
    expect(data.latestAudit).toBeNull();
    expect(data.errors.length).toBeGreaterThan(0); // config missing error
    // No legacy run/silo surface remains on the payload.
    expect(JSON.stringify(data)).not.toContain('"runs"');
    expect(JSON.stringify(data)).not.toContain('"silos"');
    expect(JSON.stringify(data)).not.toContain('"latestRun"');
  });

  it("loads latest audit with markdown", async () => {
    const auditDir = path.join(tmpDir, "brand", "audits", "2024-03-01T00-00-00");
    await fs.mkdir(auditDir, { recursive: true });
    await fs.writeFile(path.join(auditDir, "audit.md"), "# Audit\nAll good.");

    const data = await loadDashboardData(tmpDir);

    expect(data.latestAudit).not.toBeNull();
    expect(data.latestAudit!.id).toBe("2024-03-01T00-00-00");
    expect(data.latestAudit!.markdown).toBe("# Audit\nAll good.");
  });

  it("serves the audit screenshot as an opaque handle, never an absolute path", async () => {
    const auditDir = path.join(tmpDir, "brand", "audits", "2024-03-01T00-00-00");
    await fs.mkdir(auditDir, { recursive: true });
    await fs.writeFile(path.join(auditDir, "screenshot.png"), Buffer.from([0x89, 0x50]));

    const data = await loadDashboardData(tmpDir);

    expect(data.latestAudit!.screenshotPath).toBe(
      "brand/audits/2024-03-01T00-00-00/screenshot.png",
    );
    expect(path.isAbsolute(data.latestAudit!.screenshotPath!)).toBe(false);
  });

  it("passes approved provenance through untouched (versionId-shaped)", async () => {
    const approvedDir = path.join(tmpDir, "brand", "approved");
    await fs.mkdir(approvedDir, { recursive: true });

    // WS-01 `direction-aggregate-root`: provenance is { directionId, versionId,
    // approvedAt } — nothing else.
    const provenance = {
      directionId: "bold",
      versionId: "2026-06-01T00-00-00",
      approvedAt: "2026-06-01T12:00:00.000Z",
    };
    await fs.writeFile(
      path.join(approvedDir, "current-direction.json"),
      JSON.stringify({ ...makeVersion("2026-06-01T00-00-00"), provenance }),
    );

    const data = await loadDashboardData(tmpDir);

    expect(data.approved).not.toBeNull();
    expect(data.approved!.id).toBe("2026-06-01T00-00-00");
    expect(data.approved!.provenance).toEqual(provenance);
  });

  it("old approvals without provenance still load", async () => {
    const approvedDir = path.join(tmpDir, "brand", "approved");
    await fs.mkdir(approvedDir, { recursive: true });
    await fs.writeFile(
      path.join(approvedDir, "current-direction.json"),
      JSON.stringify(makeVersion("v-old")),
    );

    const data = await loadDashboardData(tmpDir);
    expect(data.approved).not.toBeNull();
    expect(data.approved!.provenance).toBeUndefined();
  });

  it("reads guides from brand/guides/", async () => {
    const guidesDir = path.join(tmpDir, "brand", "guides");
    await fs.mkdir(guidesDir, { recursive: true });
    await fs.writeFile(path.join(guidesDir, "visual-style-guide.md"), "Visual guide");
    await fs.writeFile(path.join(guidesDir, "brand-guide.md"), "Brand guide");

    const data = await loadDashboardData(tmpDir);

    expect(data.guides.visualStyle).toBe("Visual guide");
    expect(data.guides.brand).toBe("Brand guide");
  });

  it("surfaces a direction with a head + ordered (ascending) versions", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);

    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody", status: "rejected" });
    await core.appendFeedback("moody", {
      body: "Too dark for the audience",
      author: "tim",
      source: "cli",
    });
    await core.setBriefFields("moody", { oneLiner: "Moody brief" });

    // Two versions on THIS direction; only the head (v2) has a style tile on disk.
    await writeVersions(
      config,
      "moody",
      [makeVersion("v1"), makeVersion("v2")],
      (v) => (v.id === "v2" ? ["style-tile.png"] : []),
    );

    const data = await loadDashboardData(tmpDir);

    // Direction is the aggregate root now — the payload is a flat top-level
    // `directions[]`; the record IS the entry (no wrapper level).
    const moody = data.directions.find((d) => d.id === "moody")!;
    expect(moody.status).toBe("rejected");
    expect(moody.brief.oneLiner).toBe("Moody brief");
    expect(moody.renderedBrief).toContain("Moody brief");

    expect(moody.head).toBe("v2");
    // Canonical ASCENDING order — versions[last] === head.
    expect(moody.versions.map((v) => v.versionId)).toEqual(["v1", "v2"]);
    expect(moody.versions[moody.versions.length - 1].versionId).toBe(moody.head);

    // Per-version images: the head carries the tile (+ extraction flag); v1 none.
    expect(moody.versions[1].images!.styleTile).toBe(
      "brand/directions/moody/versions/v2/style-tile.png",
    );
    expect(moody.versions[1].images!.tokensExtracted).toBe(true);
    expect(moody.versions[0].images).toBeUndefined();

    expect(moody.memory).toHaveLength(1);
    expect(moody.memory[0].kind).toBe("feedback");
    expect(moody.memory[0].body).toBe("Too dark for the audience");
  });

  it("serves a flat top-level directions[] — no wrapper key remains on the payload", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);

    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.setBriefFields("moody", { oneLiner: "Moody brief" });
    await core.appendFeedback("moody", {
      body: "warmer palette",
      author: "tim",
      source: "cli",
    });
    await writeVersions(config, "moody", [makeVersion("v1")]);

    const data = await loadDashboardData(tmpDir);

    // WS-18: the flattened read contract — no two-level wrapper anywhere.
    // The legacy wrapper key is assembled at runtime (clean-break: no literal).
    expect(data).not.toHaveProperty(["con", "cepts"].join(""));

    expect(data.directions).toHaveLength(1);
    const moody = data.directions[0];
    expect(moody.id).toBe("moody");
    expect(moody.status).toBe("active");
    expect(moody.head).toBe("v1");
    // Ascending versions; last === head.
    expect(moody.versions.map((v) => v.versionId)).toEqual(["v1"]);
    expect(moody.versions[moody.versions.length - 1].versionId).toBe(moody.head);
    // Brief, moodboard assets, and memory ride the SAME flat entry.
    expect(moody.brief.oneLiner).toBe("Moody brief");
    expect(moody.assets).toEqual([]);
    expect(moody.memory.map((e) => e.body)).toEqual(["warmer palette"]);
    expect(moody.isDraft).toBe(false);
  });

  it("tolerates a corrupt version (skips it, records an error); the direction and a sibling still load", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);

    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "ok", name: "Ok" });
    await writeVersions(config, "ok", [makeVersion("v1")]);

    // A direction whose version file is unparseable → that version is skipped
    // with an error; the direction itself still loads (with the bad version
    // simply missing from its versions[]).
    await core.create({ id: "broken", name: "Broken" });
    const root = directionsRoot(tmpDir, config);
    const vdir = path.join(root, "broken", "versions", "v1");
    await fs.mkdir(vdir, { recursive: true });
    await fs.writeFile(path.join(vdir, "direction-version.json"), "{ not valid json");
    await core.appendVersion("broken", "v1");

    const data = await loadDashboardData(tmpDir);

    const ok = data.directions.find((d) => d.id === "ok")!;
    expect(ok.versions.map((v) => v.versionId)).toEqual(["v1"]);

    const broken = data.directions.find((d) => d.id === "broken")!;
    expect(broken.versions).toEqual([]);
    expect(data.errors.some((e) => /broken/.test(e) && /v1/.test(e))).toBe(true);
  });

  it("surfaces the global brand (rules + approvedPointer) and writes nothing", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);

    const brand = createBrandCore(tmpDir, config);
    await brand.addRule({
      severity: "hard",
      text: "Never use comic sans",
      author: "tim",
      source: "cli",
    });
    // WS-01: setPointer takes { directionId, versionId } — nothing else.
    await brand.setPointer({
      versionId: "2026-06-01T00-00-00",
      directionId: "m1",
    });

    const brandFile = globalBrandPath(tmpDir, config);
    const before = await fs.stat(brandFile);

    const data = await loadDashboardData(tmpDir);

    expect(data.global).not.toBeNull();
    expect(data.global!.rules).toHaveLength(1);
    expect(data.global!.rules[0].severity).toBe("hard");
    expect(data.global!.approvedPointer).not.toBeNull();
    expect(data.global!.approvedPointer!.directionId).toBe("m1");
    expect(data.global!.approvedPointer!.versionId).toBe("2026-06-01T00-00-00");

    // Read-only invariant: brand.yaml is untouched.
    const after = await fs.stat(brandFile);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const reread = await createBrandCore(tmpDir, config).read();
    expect(reread.version).toBe(2); // addRule (1) + setPointer (2); no UI write
  });

  it("upholds per-direction memory isolation in the read path (no cross-direction merge)", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);

    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.create({ id: "brutal", name: "Brutal" });
    await core.appendFeedback("moody", {
      body: "moody-only entry",
      author: "tim",
      source: "cli",
    });
    await core.appendLearning("brutal", {
      body: "brutal-only entry",
      author: "tim",
      source: "cli",
    });

    const data = await loadDashboardData(tmpDir);

    const moody = data.directions.find((d) => d.id === "moody")!;
    const brutal = data.directions.find((d) => d.id === "brutal")!;

    expect(moody.memory.map((e) => e.body)).toEqual(["moody-only entry"]);
    expect(brutal.memory.map((e) => e.body)).toEqual(["brutal-only entry"]);
    expect(moody.memory.some((e) => e.body === "brutal-only entry")).toBe(false);
    expect(brutal.memory.some((e) => e.body === "moody-only entry")).toBe(false);
  });

  it("surfaces a direction's registered assets", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);

    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.addAsset("moody", {
      kind: "image",
      path: "brand/directions/moody/assets/board.png",
      note: "moodboard",
    });

    const data = await loadDashboardData(tmpDir);
    const moody = data.directions.find((d) => d.id === "moody")!;
    expect(moody.assets).toContainEqual({
      kind: "image",
      path: "brand/directions/moody/assets/board.png",
      note: "moodboard",
      removable: true,
    });
  });

  it("a freshly created direction (no versions) reads as a draft — null head, empty versions, isDraft true", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);

    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });

    const data = await loadDashboardData(tmpDir);
    const moody = data.directions.find((d) => d.id === "moody")!;
    expect(moody.head).toBeNull();
    expect(moody.versions).toEqual([]);
    expect(moody.isDraft).toBe(true);
  });

  it("legacy project (no directions/brand.yaml) still renders empty, writes nothing", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);

    const data = await loadDashboardData(tmpDir);

    expect(data.directions).toEqual([]);
    // No directions and no brand.yaml written → global is the empty scaffold.
    expect(data.global?.approvedPointer ?? null).toBeNull();
    expect(data.global?.rules ?? []).toEqual([]);

    // The read path must not have created brand.yaml on disk.
    await expect(fs.access(globalBrandPath(tmpDir, config))).rejects.toThrow();
  });

  // ---------------------------------------------------------------------------
  // WS-06 — classification + retired state carried through the read model
  // ---------------------------------------------------------------------------

  it("entry classification is carried through the read model", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);

    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    // Append a decision with channel + polarity via core.
    await core.appendDecision("moody", {
      body: "always a bold icon",
      author: "tim",
      source: "cli",
      channel: "visual",
      polarity: "avoid",
    });

    const data = await loadDashboardData(tmpDir);
    const moody = data.directions.find((d) => d.id === "moody")!;
    expect(moody.memory).toHaveLength(1);
    expect(moody.memory[0].channel).toBe("visual");
    expect(moody.memory[0].polarity).toBe("avoid");
  });

  it("retired state is carried through the read model; non-retired sibling omits it", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);

    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.appendFeedback("moody", { body: "keep this", author: "tim", source: "cli" });
    await core.appendDecision("moody", {
      body: "stale decision",
      author: "tim",
      source: "cli",
    });

    // Retire the decision via core.
    const entries = await core.memoryEntries("moody");
    const decision = entries.find((e) => e.kind === "decision")!;
    await core.retireMemoryEntry("moody", {
      entryId: decision.id,
      author: "tim",
      source: "cli",
    });

    const data = await loadDashboardData(tmpDir);
    const moody = data.directions.find((d) => d.id === "moody")!;
    // Retired entries are excluded from the ACTIVE `memory` array — reachable
    // instead via `retiredMemory` (history).
    expect(moody.memory.some((e) => e.id === decision.id)).toBe(false);
    const retiredEntry = moody.retiredMemory?.find((e) => e.id === decision.id)!;
    const liveEntry = moody.memory.find((e) => e.kind === "feedback")!;
    expect(retiredEntry.retiredAt).toBeTruthy();
    expect(liveEntry.retiredAt).toBeUndefined();
  });

  it("rule classification is carried through the read model", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);

    const brand = createBrandCore(tmpDir, config);
    await brand.addRule({
      severity: "hard",
      text: "no stock-photo hands",
      author: "tim",
      source: "cli",
      channel: "visual",
      polarity: "avoid",
    });

    const data = await loadDashboardData(tmpDir);
    expect(data.global!.rules).toHaveLength(1);
    expect(data.global!.rules[0].channel).toBe("visual");
    expect(data.global!.rules[0].polarity).toBe("avoid");
  });

  it("back-compat: a legacy entry/rule with no channel projects with the field absent", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);

    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.appendFeedback("moody", { body: "warm tones", author: "tim", source: "cli" });

    const brand = createBrandCore(tmpDir, config);
    await brand.addRule({ severity: "guideline", text: "use whitespace", author: "tim", source: "cli" });

    const data = await loadDashboardData(tmpDir);
    const moody = data.directions.find((d) => d.id === "moody")!;
    expect(moody.memory[0].channel).toBeUndefined();
    expect(data.global!.rules[0].channel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// WS-05: lifecycle read delta — active/retired split + derived affordances
// ---------------------------------------------------------------------------

describe("lifecycle read delta", () => {
  /** One direction with an active + retired memory entry, an active + retired
   * kept-crop asset, and (global) an active + retired rule. */
  async function seedLifecycleFixture(
    cwd: string,
    config: KeyartConfig,
  ): Promise<{ retiredEntryId: string; retiredRuleId: string }> {
    const core = createDirectionCore(cwd, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.appendLearning("moody", {
      body: "active learning",
      author: "tim",
      source: "cli",
    });
    const withRetired = await core.appendLearning("moody", {
      body: "stale learning",
      author: "tim",
      source: "cli",
    });
    const toRetire = withRetired.entries.find((e) => e.body === "stale learning")!;
    await core.retireMemoryEntry("moody", {
      entryId: toRetire.id,
      author: "tim",
      source: "cli",
    });

    await core.addAsset("moody", {
      kind: "image",
      path: "brand/directions/moody/assets/active.png",
    });
    await core.addAsset("moody", {
      kind: "image",
      path: "brand/directions/moody/assets/retired.png",
    });
    await core.retireAsset("moody", {
      path: "brand/directions/moody/assets/retired.png",
      author: "tim",
      source: "cli",
    });

    const brand = createBrandCore(cwd, config);
    await brand.addRule({
      severity: "guideline",
      text: "active rule",
      author: "tim",
      source: "cli",
    });
    const brandWithRetired = await brand.addRule({
      severity: "guideline",
      text: "stale rule",
      author: "tim",
      source: "cli",
    });
    const ruleToRetire = brandWithRetired.rules.find((r) => r.text === "stale rule")!;
    await brand.removeRule(ruleToRetire.id);

    return { retiredEntryId: toRetire.id, retiredRuleId: ruleToRetire.id };
  }

  it("hides retired signals from the active memory/assets/global.rules arrays", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);
    await seedLifecycleFixture(tmpDir, config);

    const data = await loadDashboardData(tmpDir);
    const moody = data.directions.find((d) => d.id === "moody")!;

    // The retire actions each append their OWN attributed audit `learning`
    // entry (active — an audit trail, not the retired signal itself), so
    // assert containment/exclusion rather than an exact array.
    const bodies = moody.memory.map((e) => e.body);
    expect(bodies).toContain("active learning");
    expect(bodies).not.toContain("stale learning");
    expect(moody.assets.map((a) => a.path)).toEqual([
      "brand/directions/moody/assets/active.png",
    ]);
    const ruleTexts = data.global!.rules.map((r) => r.text);
    expect(ruleTexts).toContain("active rule");
    expect(ruleTexts).not.toContain("stale rule");
  });

  it("exposes reachable history via retiredMemory/retiredAssets/retiredRules", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);
    const { retiredEntryId, retiredRuleId } = await seedLifecycleFixture(tmpDir, config);

    const data = await loadDashboardData(tmpDir);
    const moody = data.directions.find((d) => d.id === "moody")!;

    expect(moody.retiredMemory?.map((e) => e.id)).toEqual([retiredEntryId]);
    expect(moody.retiredMemory?.[0].retiredAt).toBeTruthy();
    expect(moody.retiredAssets?.map((a) => a.path)).toEqual([
      "brand/directions/moody/assets/retired.png",
    ]);
    expect(data.global!.retiredRules?.map((r) => r.id)).toEqual([retiredRuleId]);
  });

  it("carries derived, pure action affordances on active signals; sibling directions stay isolated", async () => {
    const config = buildTestConfig(tmpDir);
    vi.mocked(loadConfig).mockResolvedValue(config);

    const core = createDirectionCore(tmpDir, config);
    await core.create({ id: "moody", name: "Moody" });
    await core.appendLearning("moody", {
      body: "moody-only",
      author: "tim",
      source: "cli",
    });
    await core.addAsset("moody", {
      kind: "image",
      path: "brand/directions/moody/assets/kept.png",
    });

    // A sibling direction (Direction is the aggregate root — there is no more
    // two-level scope split, just per-direction isolation).
    await core.create({ id: "dir-1", name: "Dir 1" });
    await core.appendLearning("dir-1", {
      body: "dir-1-only",
      author: "tim",
      source: "cli",
    });

    const brand = createBrandCore(tmpDir, config);
    await brand.addRule({
      severity: "hard",
      text: "always an 8px grid",
      author: "tim",
      source: "cli",
    });

    const data = await loadDashboardData(tmpDir);
    const moody = data.directions.find((d) => d.id === "moody")!;
    const dir1 = data.directions.find((d) => d.id === "dir-1")!;

    // Promote is up-only + single-destination now that scope is location — a
    // direction entry may only be lifted straight to global.
    const moodyEntry = moody.memory.find((e) => e.body === "moody-only")!;
    expect(moodyEntry).toMatchObject({ editable: true, deletable: true, promotableTo: ["global"] });
    expect(moody.memory.some((e) => e.body === "dir-1-only")).toBe(false);

    const dir1Entry = dir1.memory.find((e) => e.body === "dir-1-only")!;
    expect(dir1Entry).toMatchObject({ editable: true, deletable: true, promotableTo: ["global"] });
    expect(dir1.memory.some((e) => e.body === "moody-only")).toBe(false);

    const keptCrop = moody.assets.find((a) => a.path.endsWith("kept.png"))!;
    expect(keptCrop).toMatchObject({ removable: true });
    expect(keptCrop).not.toHaveProperty("promotableTo");

    const hardRule = data.global!.rules.find((r) => r.severity === "hard")!;
    expect(hardRule).toMatchObject({ editable: true, removable: true });

    // Direct assertions against the pure helpers.
    expect(memoryEntryAffordances({}).promotableTo).toEqual(["global"]);
    expect(assetAffordances({})).toEqual({ removable: true });
    expect(ruleAffordances({ severity: "hard" })).toEqual({
      editable: true,
      removable: true,
    });
  });
});
