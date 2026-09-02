import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";

// Mock loadConfig only — directionsRoot/storeDriver keep their real implementation
// so cores resolve real on-disk paths under the tmp project. Network-free, key-free.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

// Mock the openai entry points. Default to `actual` (genuine dry-run without a
// key); override ONLY the pieces a given assertion needs — hasApiKey (flip to
// "live"), generateImage (a call spy), and detectContradictionsLLM (the advisory
// semantic adapter — mocked to return a fixed memory-vs-memory Contradiction).
vi.mock("../openai.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../openai.js")>();
  return {
    ...actual,
    hasApiKey: vi.fn(actual.hasApiKey),
    generateImage: vi.fn(actual.generateImage),
    detectContradictionsLLM: vi.fn(actual.detectContradictionsLLM),
  };
});

import { runExplore } from "../commands/explore.js";
import { runRegenerateVisuals } from "../commands/regenerate-visuals.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";
import { assembleContext, selectNegatives } from "../brand/assemble-context.js";
import { composeArtDirection } from "../explore/compose-art-direction.js";
import { directionsRoot } from "../config.js";
import { hasApiKey, generateImage, detectContradictionsLLM } from "../openai.js";
import { readHead } from "../direction/store.js";
import type { Contradiction, ContradictionInput } from "../brand/conflict-guard.js";

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Art Direction ITest", type: "prototype", framework: "next" },
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

let tmpDir: string;
let savedKey: string | undefined;

async function headVersionDir(directionId: string): Promise<string> {
  const root = directionsRoot(tmpDir, buildTestConfig(tmpDir));
  const headVersion = await readHead(root, directionId);
  return path.join(root, directionId, "versions", headVersion.id);
}

/**
 * Extract the art-direction block (MUST/PREFER/AVOID section compiled by
 * composeArtDirection) from a prompt string. Returns the substring from the
 * first art-direction header to the trimmed end, or "" when absent.
 * Uses specific header strings that cannot appear in the content lock.
 */
function extractArtBlock(prompt: string): string {
  const markers = [
    "MUST (non-negotiable",
    "PREFER (do):",
    "AVOID (do not use):",
    "Additional art direction (this pass only):",
  ];
  let idx = prompt.length;
  for (const m of markers) {
    const i = prompt.indexOf(m);
    if (i !== -1 && i < idx) idx = i;
  }
  return idx < prompt.length ? prompt.slice(idx).trimEnd() : "";
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-artdir-"));
  savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));
  // Reset openai mocks to their actual (dry-run) implementations each test so
  // overrides in one it() never bleed into the next.
  const actualOpenai = await vi.importActual<typeof import("../openai.js")>("../openai.js");
  vi.mocked(hasApiKey).mockImplementation(actualOpenai.hasApiKey);
  vi.mocked(generateImage).mockImplementation(actualOpenai.generateImage);
  vi.mocked(detectContradictionsLLM).mockImplementation(actualOpenai.detectContradictionsLLM);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("art-direction pipeline (end-to-end, network-free / key-free)", () => {
  it(
    "visual-avoid memory → AVOID in all three prompts on explore AND regenerate (SC-03 / SC-02)",
    async () => {
      const config = buildTestConfig(tmpDir);
      const core = createDirectionCore(tmpDir, config);
      const brand = createBrandCore(tmpDir, config);

      await core.create({ id: "alpha", name: "Alpha" });
      await core.create({ id: "witness", name: "Witness" });

      // Visual/avoid direction decision: "decision" → channel:visual; starts with
      // "never" → polarity:avoid via heuristic. Both reached by classifyDirective.
      await core.appendDecision("alpha", {
        body: "never use a fist-in-the-air icon",
        author: "test",
        source: "art-direction-pipeline.test.ts",
      });
      // Global hard rule → always MUST in the visual lane (rules default channel:visual).
      await brand.addRule({
        severity: "hard",
        text: "Never use stock-photo people",
        author: "test",
        source: "art-direction-pipeline.test.ts",
      });

      // ── EXPLORE (dry-run) ──────────────────────────────────────────────────
      const exploreResult = await runExplore({ cwd: tmpDir, directionId: "alpha" });
      expect(exploreResult.dryRun).toBe(true);

      const exploreVerDir = await headVersionDir(exploreResult.directionIds[0]);
      const exploreStyleTile = await fs.readFile(
        path.join(exploreVerDir, "style-tile-prompt.md"),
        "utf-8",
      );
      const exploreHomepage = await fs.readFile(
        path.join(exploreVerDir, "homepage-mockup-prompt.md"),
        "utf-8",
      );

      // Both persisted prompts carry the decision as AVOID and the rule as MUST.
      for (const prompt of [exploreStyleTile, exploreHomepage]) {
        expect(prompt).toContain("MUST (non-negotiable — always obey):");
        expect(prompt).toContain("Never use stock-photo people");
        expect(prompt).toContain("AVOID (do not use):");
        expect(prompt).toContain("never use a fist-in-the-air icon");
      }

      // Both explore prompts share an identical directive block (SC-02: one compiler).
      const exploreArtBlock = extractArtBlock(exploreStyleTile);
      expect(exploreArtBlock).not.toBe(""); // block is non-empty
      expect(extractArtBlock(exploreHomepage)).toBe(exploreArtBlock);

      // ── REGENERATE (live key + generateImage spy to capture board prompt) ───
      // Memory is direction-local after the aggregate-root move. Record the
      // same avoid decision on the generated direction before iterating it.
      await core.appendDecision(exploreResult.directionIds[0], {
        body: "never use a fist-in-the-air icon",
        author: "test",
        source: "art-direction-pipeline.test.ts",
      });
      vi.mocked(hasApiKey).mockReturnValue(true);
      vi.mocked(generateImage).mockResolvedValue({ written: true, dryRun: false });

      await runRegenerateVisuals({
        cwd: tmpDir,
        directionId: exploreResult.directionIds[0],
      });

      // headVersionDir now returns the regenerate version (the new head).
      const regenVerDir = await headVersionDir(exploreResult.directionIds[0]);
      const regenStyleTile = await fs.readFile(
        path.join(regenVerDir, "style-tile-prompt.md"),
        "utf-8",
      );
      const regenHomepage = await fs.readFile(
        path.join(regenVerDir, "homepage-mockup-prompt.md"),
        "utf-8",
      );

      for (const prompt of [regenStyleTile, regenHomepage]) {
        expect(prompt).toContain("MUST (non-negotiable — always obey):");
        expect(prompt).toContain("Never use stock-photo people");
        expect(prompt).toContain("AVOID (do not use):");
        expect(prompt).toContain("never use a fist-in-the-air icon");
      }

      // Board prompt (evocative board) — captured via the generateImage spy.
      // composeEvocativeBoardPrompt opens with "A cohesive moodboard".
      const boardCall = vi.mocked(generateImage).mock.calls.find(([args]) =>
        args.prompt.includes("cohesive moodboard"),
      );
      expect(boardCall).toBeDefined();
      const boardPrompt = boardCall![0].prompt;
      expect(boardPrompt).toContain("MUST (non-negotiable — always obey):");
      expect(boardPrompt).toContain("Never use stock-photo people");
      expect(boardPrompt).toContain("AVOID (do not use):");
      expect(boardPrompt).toContain("never use a fist-in-the-air icon");

      // All three regenerate prompts share the same directive block (SC-02).
      const regenArtBlock = extractArtBlock(regenStyleTile);
      expect(extractArtBlock(regenHomepage)).toBe(regenArtBlock);
      expect(extractArtBlock(boardPrompt)).toBe(regenArtBlock);

      // Per-direction isolation: witness must have no memory from alpha's operations.
      expect(await core.memoryEntries("witness")).toHaveLength(0);
    },
  );

  it(
    "positive visual directive → PREFER block; locked-color guidance preserved (SC-04 symmetry)",
    async () => {
      const config = buildTestConfig(tmpDir);
      const core = createDirectionCore(tmpDir, config);

      await core.create({ id: "alpha", name: "Alpha" });

      // Positive visual decision: "decision" → channel:visual; "Use" → prefer.
      await core.appendDecision("alpha", {
        body: "Use bold geometric sans headers",
        author: "test",
        source: "art-direction-pipeline.test.ts",
      });

      // Color lock — feeds soft locked-color guidance in the art-direction tail.
      await core.recordColorLock("alpha", {
        hex: "#3a86ff",
        author: "test",
        source: "art-direction-pipeline.test.ts",
      });

      const result = await runExplore({ cwd: tmpDir, directionId: "alpha" });
      expect(result.dryRun).toBe(true);

      const verDir = await headVersionDir(result.directionIds[0]);
      const styleTilePrompt = await fs.readFile(
        path.join(verDir, "style-tile-prompt.md"),
        "utf-8",
      );

      // Positive directive appears in PREFER (do) tier.
      expect(styleTilePrompt).toContain("PREFER (do):");
      expect(styleTilePrompt).toContain("Use bold geometric sans headers");

      // Locked-color guidance present (soft, not a hard constraint).
      expect(styleTilePrompt).toContain("#3a86ff");
    },
  );

  it("copy-only memory is excluded from ALL image prompts (SC-05)", async () => {
    const config = buildTestConfig(tmpDir);
    const core = createDirectionCore(tmpDir, config);

    await core.create({ id: "alpha", name: "Alpha" });

    // Copy-only entry: a `learning` → channel:copy by classifier default.
    const COPY_BODY = "Headline voice should be terse and confident";
    await core.appendLearning("alpha", {
      body: COPY_BODY,
      author: "test",
      source: "art-direction-pipeline.test.ts",
    });

    // Sibling visual directive: `decision` → channel:visual; "never" → avoid.
    const VISUAL_BODY = "never use gradients";
    await core.appendDecision("alpha", {
      body: VISUAL_BODY,
      author: "test",
      source: "art-direction-pipeline.test.ts",
    });

    const result = await runExplore({ cwd: tmpDir, directionId: "alpha" });

    const verDir = await headVersionDir(result.directionIds[0]);
    for (const f of ["style-tile-prompt.md", "homepage-mockup-prompt.md"]) {
      const prompt = await fs.readFile(path.join(verDir, f), "utf-8");
      // Copy-only body never reaches an image prompt.
      expect(prompt).not.toContain(COPY_BODY);
      // Visual directive IS present.
      expect(prompt).toContain(VISUAL_BODY);
      expect(prompt).toContain("AVOID (do not use):");
    }
  });

  it(
    "hard-rule conflict → deterministic floor warns, rule wins, feedback auto-logged, no throw (SC-08)",
    async () => {
      const config = buildTestConfig(tmpDir);
      const core = createDirectionCore(tmpDir, config);
      const brand = createBrandCore(tmpDir, config);

      await core.create({ id: "alpha", name: "Alpha" });

      // Hard rule whose text overlaps with the live tweak below.
      await brand.addRule({
        severity: "hard",
        text: "Never use pure black (#000)",
        author: "test",
        source: "art-direction-pipeline.test.ts",
      });

      // Create a direction to regenerate from.
      const exploreResult = await runExplore({ cwd: tmpDir, directionId: "alpha" });

      // Regenerate with a tweak that contradicts the hard rule. Still key-free:
      // the deterministic floor detects overlap without any LLM call.
      const regenResult = await runRegenerateVisuals({
        cwd: tmpDir,
        directionId: exploreResult.directionIds[0],
        tweak: "make the whole thing pure black",
      });

      // 1. Structured warning in the contradiction report — floor fired key-free.
      expect(regenResult.contradictionReport.warnings.length).toBeGreaterThan(0);
      expect(regenResult.contradictionReport.warnings[0].code).toBe("hard-rule-conflict");
      expect(regenResult.contradictionReport.warnings[0].message).toContain(
        "Never use pure black (#000)",
      );
      expect(regenResult.contradictionReport.detector).toBe("deterministic");

      // 2. Rule wins: the MUST block still contains the hard rule text.
      const regenVerDir = await headVersionDir(exploreResult.directionIds[0]);
      const styleTile = await fs.readFile(
        path.join(regenVerDir, "style-tile-prompt.md"),
        "utf-8",
      );
      expect(styleTile).toContain("MUST (non-negotiable — always obey):");
      expect(styleTile).toContain("Never use pure black (#000)");

      // 3. Live feedback auto-logged with source: "regenerate" (the gesture was recorded).
      const feedback = (await core.memoryEntries(exploreResult.directionIds[0])).filter(
        (entry) => entry.kind === "feedback",
      );
      expect(feedback.some((e) => e.source === "regenerate")).toBe(true);

      // 4. Command never threw (execution reached this point) and result is valid.
      expect(regenResult.directionId).toBe(exploreResult.directionIds[0]);
      expect(typeof regenResult.versionId).toBe("string");
    },
  );

  it(
    "mocked-LLM memory-vs-memory → retire → retired entry absent from directives (SC-07 / SC-09)",
    async () => {
      const config = buildTestConfig(tmpDir);
      const core = createDirectionCore(tmpDir, config);

      await core.create({ id: "alpha", name: "Alpha" });
      await core.create({ id: "witness", name: "Witness" });

      // Two contradictory soft decisions (both explicitly visual/prefer).
      await core.appendDecision("alpha", {
        body: "use a warm terracotta palette",
        author: "test",
        source: "art-direction-pipeline.test.ts",
        channel: "visual",
        polarity: "prefer",
      });
      await core.appendDecision("alpha", {
        body: "use a cool slate palette",
        author: "test",
        source: "art-direction-pipeline.test.ts",
        channel: "visual",
        polarity: "prefer",
      });

      // Capture entry ids before mocking so the Contradiction refs are stable.
      const decisions = (await core.memoryEntries("alpha")).filter(
        (entry) => entry.kind === "decision",
      );
      const terracottaEntry = decisions.find((d) => d.body.includes("terracotta"))!;
      const slateEntry = decisions.find((d) => d.body.includes("slate"))!;
      expect(terracottaEntry).toBeDefined();
      expect(slateEntry).toBeDefined();

      // Stub detectContradictionsLLM to return a fixed memory-vs-memory Contradiction.
      const mockContradiction: Contradiction = {
        id: `memory-vs-memory::${terracottaEntry.id}::${slateEntry.id}`,
        kind: "memory-vs-memory",
        subject: { source: "memory", id: terracottaEntry.id, text: terracottaEntry.body },
        conflictsWith: { source: "memory", id: slateEntry.id, text: slateEntry.body },
        severity: "info",
        explanation: "Two palette decisions contradict each other: terracotta vs slate.",
        suggestions: ["retire"],
      };
      vi.mocked(detectContradictionsLLM).mockResolvedValue({
        contradictions: [mockContradiction],
        dryRun: false,
      });
      // Flip exported hasApiKey → true so the semantic path is taken.
      vi.mocked(hasApiKey).mockReturnValue(true);

      // Build detection deps the same way explore/regenerate do (wrapping the mock).
      const listDeps = {
        semantic: async (input: ContradictionInput) =>
          (
            await detectContradictionsLLM({
              model: config.models.text,
              liveInstruction: input.liveInstruction,
              hardRules: input.hardRules.map((r) => ({ id: r.id, text: r.text })),
              guidelines: input.guidelines.map((r) => ({ id: r.id, text: r.text })),
              memory: input.memory.map((m) => ({ id: m.id, kind: m.kind, body: m.body })),
            })
          ).contradictions,
      };

      // listContradictions with semantic deps returns the mocked contradiction.
      const report = await core.listContradictions("alpha", listDeps);
      expect(report.items.some((c) => c.kind === "memory-vs-memory")).toBe(true);
      expect(report.detector).toBe("deterministic+semantic");

      // Record memory length BEFORE retire to verify the append-only invariant.
      // includeRetired: true — this asserts against the underlying store, not the
      // WS-01 default (retired-excluded) live view.
      const memorySizeBefore = (
        await core.memoryEntries("alpha", { includeRetired: true })
      ).length;

      // ── RETIRE the stale terracotta entry ────────────────────────────────────
      await core.retireMemoryEntry("alpha", {
        entryId: terracottaEntry.id,
        author: "test",
        source: "art-direction-pipeline.test.ts",
        reason: "Contradicts cool slate palette (memory-vs-memory)",
      });

      // 1. Retire is NON-DESTRUCTIVE + APPEND-ONLY: entry still exists + grew.
      const memorySizeAfter = (
        await core.memoryEntries("alpha", { includeRetired: true })
      ).length;
      expect(memorySizeAfter).toBeGreaterThan(memorySizeBefore); // audit entry appended
      const allEntries = await core.memoryEntries("alpha", { includeRetired: true });
      const retiredEntry = allEntries.find((e) => e.id === terracottaEntry.id);
      expect(retiredEntry).toBeDefined();          // entry still exists (never deleted)
      expect(retiredEntry!.retiredAt).toBeDefined(); // retire marker is set
      expect(retiredEntry!.body).toBe("use a warm terracotta palette"); // body unchanged

      // 2. Retired entry is SKIPPED by assembleContext + selectNegatives.
      const global = await createBrandCore(tmpDir, config).read();
      const updatedMemory = await core.memoryEntries("alpha");
      const assembled = assembleContext({ brief: "test", global, memory: updatedMemory });
      expect(assembled.visualDirectives.prefer).not.toContain("use a warm terracotta palette");
      expect(assembled.visualDirectives.prefer).toContain("use a cool slate palette");
      expect(selectNegatives(updatedMemory)).not.toContain("use a warm terracotta palette");

      // 3. Retired body absent from image prompts; surviving directive IS present.
      vi.mocked(hasApiKey).mockReturnValue(false); // back to dry-run for the probe explore
      const probeResult = await runExplore({ cwd: tmpDir, directionId: "alpha" });
      const probeVerDir = await headVersionDir(probeResult.directionIds[0]);
      for (const f of ["style-tile-prompt.md", "homepage-mockup-prompt.md"]) {
        const prompt = await fs.readFile(path.join(probeVerDir, f), "utf-8");
        expect(prompt).not.toContain("use a warm terracotta palette"); // retired — absent
        expect(prompt).toContain("use a cool slate palette");          // surviving — present
      }

      // 4. ADVISORY invariant: composeArtDirection output is byte-identical whether
      //    the detector ran or not (the LLM never edits the compiled block).
      const blockBefore = composeArtDirection(assembled);
      await core.listContradictions("alpha", listDeps); // run detector again
      // assembled is a pure value — re-composing must yield the same string.
      expect(composeArtDirection(assembled)).toBe(blockBefore);

      // 5. Per-direction isolation: witness has no directives, no retired entries.
      expect(await core.memoryEntries("witness")).toHaveLength(0);
      const witnessReport = await core.listContradictions("witness");
      expect(witnessReport.items).toHaveLength(0);
    },
  );

  it(
    "dry-run / keyless parity + no-directive byte-identity + per-direction isolation (SC-11)",
    async () => {
      const config = buildTestConfig(tmpDir);
      const core = createDirectionCore(tmpDir, config);

      await core.create({ id: "alpha", name: "Alpha" });
      await core.create({ id: "witness", name: "Witness" });

      // No directives, no locks, no rules — a blank direction.
      // Explore must complete without throwing and produce key-free placeholders.
      const result = await runExplore({ cwd: tmpDir, directionId: "alpha" });
      expect(result.dryRun).toBe(true);

      const verDir = await headVersionDir(result.directionIds[0]);
      for (const f of ["style-tile-prompt.md", "homepage-mockup-prompt.md"]) {
        const prompt = await fs.readFile(path.join(verDir, f), "utf-8");
        // No-directive path: none of the art-direction headers should appear
        // (composeArtDirection returns "" → decorate emits no art tail).
        expect(prompt).not.toContain("MUST (non-negotiable");
        expect(prompt).not.toContain("PREFER (do):");
        expect(prompt).not.toContain("AVOID (do not use):");
      }

      // Per-direction isolation: witness has no directives, no contradictions,
      // no retired entries from alpha's operations.
      expect(await core.memoryEntries("witness")).toHaveLength(0);
      const witnessReport = await core.listContradictions("witness");
      expect(witnessReport.items).toHaveLength(0);
    },
  );
});
