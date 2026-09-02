import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { KeyartConfig } from "../types.js";
import { createDirectionCore } from "../direction/core.js";
import { createBrandCore } from "../brand/core.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

// Wrapped so ONE test (the memory-write-failure case) can swap in a core whose
// appendLearning rejects; everywhere else the real implementation runs.
vi.mock("../direction/core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../direction/core.js")>();
  return { ...actual, createDirectionCore: vi.fn(actual.createDirectionCore) };
});

// Mock the Playwright capture — write a placeholder file so the audit proceeds.
vi.mock("../audit/capture-screenshot.js", () => ({
  captureUrl: vi.fn(async (_url: string, outPath: string) => {
    await fs.writeFile(outPath, "fake-png", "utf-8");
  }),
}));

let tmpDir: string;

function mockConfig(): KeyartConfig {
  return {
    project: { name: "Audit Test", type: "prototype", framework: "next" },
    brand: {
      root: path.join(tmpDir, "brand"),
      references: path.join(tmpDir, "brand", "input", "references"),
      approved: path.join(tmpDir, "brand", "approved"),
      rejected: path.join(tmpDir, "brand", "rejected"),
    },
    models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
    outputs: {
      cursorRules: path.join(tmpDir, ".cursor", "rules", "keyart-brand.mdc"),
      cssVars: path.join(tmpDir, "brand", "generated", "brand.css"),
      implementationBrief: path.join(tmpDir, "brand", "generated", "implementation-brief.md"),
    },
    store: { driver: "file" },
  };
}

async function loadRunAudit() {
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockResolvedValue(mockConfig());
  const { runAudit } = await import("./audit.js");
  return runAudit;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-audit-cmd-"));
  delete process.env.OPENAI_API_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runAudit — direction roll-up", () => {
  it("rolls findings into the approved direction's memory (deterministic)", async () => {
    const config = mockConfig();
    // Seed an approved pointer directly at a direction (no concept layer anymore).
    await createDirectionCore(tmpDir, config).create({ id: "direction-a", name: "Direction A" });
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a",
      versionId: "version-1",
    });

    const runAudit = await loadRunAudit();
    const result = await runAudit({ cwd: tmpDir, url: "http://localhost:3000" });

    // Audit artifacts still written.
    expect(result.dryRun).toBe(true);
    expect(await exists(path.join(tmpDir, result.auditDir, "audit.json"))).toBe(true);
    expect(await exists(path.join(tmpDir, result.auditDir, "audit.md"))).toBe(true);

    // A learning entry attributed to audit was appended to the approved direction.
    const entries = await createDirectionCore(tmpDir, config).memoryEntries("direction-a");
    const learnings = entries.filter((e) => e.kind === "learning");
    expect(learnings).toHaveLength(1);
    expect(learnings[0].author).toBe("audit");
    expect(learnings[0].source).toBe("audit");
    expect(learnings[0].body).toContain("Audit of http://localhost:3000");

    // The memory file is reported in filesWritten.
    expect(result.filesWritten).toContain("brand/directions/direction-a/memory.yaml");
  });

  it("writes no direction memory and never throws when nothing is approved", async () => {
    const runAudit = await loadRunAudit();
    const result = await runAudit({ cwd: tmpDir, url: "http://localhost:3000" });

    // Audit succeeded + wrote artifacts.
    expect(result.dryRun).toBe(true);
    expect(await exists(path.join(tmpDir, result.auditDir, "audit.json"))).toBe(true);

    // No direction memory created/mutated (no directions at all).
    expect(await exists(path.join(tmpDir, "brand", "directions"))).toBe(false);
    expect(result.filesWritten.some((p) => p.includes("memory.yaml"))).toBe(false);
  });

  // WS-10 (SC-11): a memory-write failure never fails the audit. The rollup
  // branch is taken (a direction is approved), the write blows up, and the
  // audit still resolves with every artifact written.
  it("a memory-write failure never fails the audit (SC-11)", async () => {
    const config = mockConfig();
    const actualCore = await vi.importActual<typeof import("../direction/core.js")>(
      "../direction/core.js",
    );
    // Seed with the REAL core, then swap in a core whose appendLearning rejects.
    await actualCore
      .createDirectionCore(tmpDir, config)
      .create({ id: "direction-a", name: "Direction A" });
    await createBrandCore(tmpDir, config).setPointer({
      directionId: "direction-a",
      versionId: "version-1",
    });

    const { createDirectionCore: mockedFactory } = await import("../direction/core.js");
    const appendLearning = vi.fn().mockRejectedValue(new Error("disk full"));
    vi.mocked(mockedFactory).mockImplementation((cwd, cfg) => ({
      ...actualCore.createDirectionCore(cwd, cfg),
      appendLearning,
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const runAudit = await loadRunAudit();
    // Resolves — never rejects — despite the failed rollup write.
    const result = await runAudit({ cwd: tmpDir, url: "http://localhost:3000" });

    expect(appendLearning).toHaveBeenCalledTimes(1); // the rollup branch WAS taken
    expect(
      warnSpy.mock.calls.some((args) => args.join(" ").includes("disk full")),
    ).toBe(true);

    // Every audit artifact is still written and reported.
    expect(await exists(path.join(tmpDir, result.auditDir, "screenshot.png"))).toBe(true);
    expect(await exists(path.join(tmpDir, result.auditDir, "audit.json"))).toBe(true);
    expect(await exists(path.join(tmpDir, result.auditDir, "audit.md"))).toBe(true);
    expect(result.filesWritten.some((p) => p.endsWith("screenshot.png"))).toBe(true);
    expect(result.filesWritten.some((p) => p.endsWith("audit.json"))).toBe(true);
    expect(result.filesWritten.some((p) => p.endsWith("audit.md"))).toBe(true);

    // The FAILED write was not recorded as written.
    expect(result.filesWritten.some((p) => p.includes("memory.yaml"))).toBe(false);
  });
});
