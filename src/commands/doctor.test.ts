import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runInit } from "./init.js";
import { runDoctor, type DoctorCheck } from "./doctor.js";
import type { KeyartConfig } from "../types.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

let tmpDir: string;

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "Doctor Test", type: "prototype", framework: "next" },
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

function checkByName(checks: DoctorCheck[], name: string): DoctorCheck {
  const check = checks.find((c) => c.name === name);
  if (!check) throw new Error(`No "${name}" check found`);
  return check;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-doctor-"));
  delete process.env.OPENAI_API_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runDoctor", () => {
  it("reports all-fail on an empty dir (config fail, brand-scaffold skipped-warn)", async () => {
    const result = await runDoctor({ cwd: tmpDir });

    expect(result.ok).toBe(false);
    expect(checkByName(result.checks, "config").status).toBe("fail");
    // Config failed, so brand-scaffold is a skipped warning (never double-fail).
    expect(checkByName(result.checks, "brand-scaffold").status).toBe("warn");
    expect(checkByName(result.checks, "openai-key").status).toBe("warn");
  });

  it("reports a healthy-ish scaffolded project as ready", async () => {
    await runInit({ cwd: tmpDir });

    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const result = await runDoctor({ cwd: tmpDir });

    expect(checkByName(result.checks, "config").status).toBe("ok");
    expect(checkByName(result.checks, "brand-scaffold").status).toBe("ok");
    expect(checkByName(result.checks, "openai-key").status).toBe("warn");
    // Playwright is never a hard fail; with no fail, the project is ready.
    expect(checkByName(result.checks, "playwright").status).not.toBe("fail");
    expect(result.ok).toBe(true);
  });

  it("detects an OPENAI_API_KEY from .env.local (loadEnvFiles runs first)", async () => {
    await fs.writeFile(
      path.join(tmpDir, ".env.local"),
      "OPENAI_API_KEY=k\n",
      "utf-8",
    );

    const result = await runDoctor({ cwd: tmpDir });

    expect(checkByName(result.checks, "openai-key").status).toBe("ok");
  });

  it("fails hard (without throwing) when the config is invalid", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockRejectedValue(
      new Error("Invalid keyart.config.ts"),
    );

    const result = await runDoctor({ cwd: tmpDir });

    expect(checkByName(result.checks, "config").status).toBe("fail");
    expect(result.ok).toBe(false);
  });

  it("treats the Playwright probe as a warning, never a throw or fail", async () => {
    const result = await runDoctor({ cwd: tmpDir });

    const playwright = checkByName(result.checks, "playwright");
    expect(["ok", "warn"]).toContain(playwright.status);
    expect(playwright.status).not.toBe("fail");
  });

  it("prints a report whose summary reflects readiness", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    // Empty dir → not ready.
    await runDoctor({ cwd: tmpDir });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Keyart is NOT ready");
    expect(output).not.toContain("Keyart is ready.");
  });

  it("prints a ready summary when all hard prerequisites pass", async () => {
    await runInit({ cwd: tmpDir });
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runDoctor({ cwd: tmpDir });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Keyart is ready.");
  });
});
