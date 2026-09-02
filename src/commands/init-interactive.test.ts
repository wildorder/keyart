import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runInitInteractive } from "./init.js";
import type { WizardIO } from "../init/prompts.js";
import type { KeyartConfig } from "../types.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

const TEST_KEY = "sk-test-abcdefgood-key";

let tmpDir: string;
let logSpy: ReturnType<typeof vi.spyOn>;

/**
 * Fake WizardIO that returns `answers` in order and records every prompt string
 * it was asked (so tests can assert what defaults were shown and whether the
 * overwrite question was reached). Extra questions resolve to "" (→ defaults).
 */
function fakeIO(answers: string[]): { io: WizardIO; prompts: string[] } {
  const prompts: string[] = [];
  let i = 0;
  const io: WizardIO = {
    question(prompt: string): Promise<string> {
      prompts.push(prompt);
      return Promise.resolve(answers[i++] ?? "");
    },
    close(): void {},
  };
  return { io, prompts };
}

async function mockLoadConfigReject(): Promise<void> {
  const { loadConfig } = await import("../config.js");
  vi.mocked(loadConfig).mockRejectedValue(new Error("no config"));
}

async function exists(relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(tmpDir, relPath));
    return true;
  } catch {
    return false;
  }
}

async function read(relPath: string): Promise<string> {
  return fs.readFile(path.join(tmpDir, relPath), "utf-8");
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-init-"));
  delete process.env.OPENAI_API_KEY;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("runInitInteractive", () => {
  it("renders a populated config and scaffolds the brand tree", async () => {
    await mockLoadConfigReject();
    const { io } = fakeIO(["Acme", "prototype", "2", TEST_KEY]);

    await runInitInteractive({ cwd: tmpDir, io });

    expect(await exists("keyart.config.ts")).toBe(true);
    const config = await read("keyart.config.ts");
    expect(config).toContain('name: "Acme"');
    // Framework choice "2" = the second FRAMEWORK_CHOICES entry ("vite").
    expect(config).toContain('framework: "vite"');
    expect(await exists("brand/directions/default/brief.md")).toBe(true);
  });

  it("persists the key to .env.local, masked, and never into the config", async () => {
    await mockLoadConfigReject();
    const { io } = fakeIO(["Acme", "prototype", "2", TEST_KEY]);

    const result = await runInitInteractive({ cwd: tmpDir, io });

    expect(await exists(".env.local")).toBe(true);
    const env = await read(".env.local");
    expect(env).toContain(`OPENAI_API_KEY=${TEST_KEY}`);

    const config = await read("keyart.config.ts");
    expect(config).not.toContain(TEST_KEY);

    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/sk-…/);
    expect(result.keyPersisted).toBe(true);
  });

  it("warns when .env.local is not gitignored, and stays quiet when it is", async () => {
    await mockLoadConfigReject();
    const { io } = fakeIO(["Acme", "prototype", "1", TEST_KEY]);
    await runInitInteractive({ cwd: tmpDir, io });
    let logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain(".gitignore");

    // Now with a .gitignore that ignores .env.local → no warning.
    logSpy.mockClear();
    const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-init-gi-"));
    try {
      await fs.writeFile(path.join(dir2, ".gitignore"), ".env.*\n", "utf-8");
      const { io: io2 } = fakeIO(["Acme", "prototype", "1", TEST_KEY]);
      await runInitInteractive({ cwd: dir2, io: io2 });
      logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).not.toContain("NOT gitignored");
    } finally {
      await fs.rm(dir2, { recursive: true, force: true });
    }
  });

  it("skips persistence when the key is blank", async () => {
    await mockLoadConfigReject();
    const { io } = fakeIO(["Acme", "prototype", "1", ""]);

    const result = await runInitInteractive({ cwd: tmpDir, io });

    expect(await exists(".env.local")).toBe(false);
    expect(result.keyPersisted).toBe(false);
  });

  it("only prompts to overwrite when a config pre-exists, and honors the answer", async () => {
    await mockLoadConfigReject();

    // No pre-existing config → no overwrite question.
    const { io: freshIO, prompts: freshPrompts } = fakeIO([
      "Acme",
      "prototype",
      "1",
      "",
    ]);
    await runInitInteractive({ cwd: tmpDir, io: freshIO });
    expect(freshPrompts.some((p) => p.includes("overwrite"))).toBe(false);

    // Pre-write a sentinel config, answer "n" → preserved.
    const sentinel = "// original config\n";
    await fs.writeFile(
      path.join(tmpDir, "keyart.config.ts"),
      sentinel,
      "utf-8",
    );
    const { io: keepIO, prompts: keepPrompts } = fakeIO([
      "Acme",
      "prototype",
      "1",
      "",
      "n",
    ]);
    await runInitInteractive({ cwd: tmpDir, io: keepIO });
    expect(keepPrompts.some((p) => p.includes("overwrite"))).toBe(true);
    expect(await read("keyart.config.ts")).toBe(sentinel);

    // Answer "y" → replaced with the rendered config.
    const { io: replaceIO } = fakeIO([
      "Acme",
      "prototype",
      "1",
      "",
      "y",
    ]);
    await runInitInteractive({ cwd: tmpDir, io: replaceIO });
    const replaced = await read("keyart.config.ts");
    expect(replaced).not.toBe(sentinel);
    expect(replaced).toContain("defineKeyartConfig");
  });

  it("seeds prompt defaults from an existing config", async () => {
    const { loadConfig } = await import("../config.js");
    const existing: KeyartConfig = {
      project: { name: "Existing", type: "prototype", framework: "next" },
      brand: {
        root: "./brand",
        references: "./brand/input/references",
        approved: "./brand/approved",
        rejected: "./brand/rejected",
      },
      models: { text: "gpt-5.5", vision: "gpt-5.5", image: "gpt-image-2" },
      outputs: {
        cursorRules: ".cursor/rules/keyart-brand.mdc",
        cssVars: "brand/generated/brand.css",
        implementationBrief: "brand/generated/implementation-brief.md",
      },
    };
    vi.mocked(loadConfig).mockResolvedValue(existing);

    const { io, prompts } = fakeIO(["", "", "1", ""]);
    await runInitInteractive({ cwd: tmpDir, io });

    const namePrompt = prompts.find((p) => p.includes("Project name"));
    expect(namePrompt).toBeDefined();
    expect(namePrompt).toContain("Existing");
  });
});
