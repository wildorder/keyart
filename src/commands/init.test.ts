import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { runInit } from "./init.js";
import { parseGlobalBrand } from "../brand/schema.js";

const yamlParse = (raw: string): unknown => YAML.parse(raw);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-init-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function exists(relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(tmpDir, relPath));
    return true;
  } catch {
    return false;
  }
}

async function readFile(relPath: string): Promise<string> {
  return fs.readFile(path.join(tmpDir, relPath), "utf-8");
}

describe("runInit", () => {
  it("creates full tree in a fresh directory", async () => {
    await runInit({ cwd: tmpDir });

    // Config file exists and contains correct model defaults
    expect(await exists("keyart.config.ts")).toBe(true);
    const config = await readFile("keyart.config.ts");
    expect(config).toContain('image: "gpt-image-2"');
    expect(config).toContain('text: "gpt-5.5"');
    expect(config).toContain("defineKeyartConfig");

    // Env example exists
    expect(await exists(".env.keyart.example")).toBe(true);

    // All brand directories exist
    expect(await exists("brand/input/references")).toBe(true);
    expect(await exists("brand/approved")).toBe(true);
    expect(await exists("brand/rejected")).toBe(true);
    expect(await exists("brand/guides")).toBe(true);
    expect(await exists("brand/generated/page-briefs")).toBe(true);
    expect(await exists("brand/audits")).toBe(true);

    // .gitkeep files
    expect(await exists("brand/rejected/.gitkeep")).toBe(true);
  });

  it("re-run skips existing config and brief (no overwrite)", async () => {
    await runInit({ cwd: tmpDir });

    // Modify config to detect overwrite
    const configPath = path.join(tmpDir, "keyart.config.ts");
    await fs.writeFile(configPath, "// user modified\n", "utf-8");

    await runInit({ cwd: tmpDir });

    // Should still be the user's version
    const config = await readFile("keyart.config.ts");
    expect(config).toBe("// user modified\n");
  });

  it("--force overwrites keyart.config.ts", async () => {
    await runInit({ cwd: tmpDir });

    // Modify config
    const configPath = path.join(tmpDir, "keyart.config.ts");
    await fs.writeFile(configPath, "// user modified\n", "utf-8");

    await runInit({ cwd: tmpDir, force: true });

    // Should be the template version again
    const config = await readFile("keyart.config.ts");
    expect(config).toContain("defineKeyartConfig");
  });

  it("merges npm scripts into package.json without overwriting existing keys", async () => {
    // Create a package.json with an existing keyart script
    const pkgPath = path.join(tmpDir, "package.json");
    await fs.writeFile(
      pkgPath,
      JSON.stringify(
        {
          name: "test-project",
          scripts: { keyart: "custom-command" },
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );

    await runInit({ cwd: tmpDir });

    const pkg = JSON.parse(await readFile("package.json"));
    // Existing script not overwritten
    expect(pkg.scripts.keyart).toBe("custom-command");
    // New scripts added
    expect(pkg.scripts["keyart:explore"]).toBe("keyart explore");
    expect(pkg.scripts["keyart:audit"]).toBe("keyart audit");
  });

  it("succeeds when no package.json exists", async () => {
    // Should not throw, and reports what it created.
    const result = await runInit({ cwd: tmpDir });
    expect(result.created).toContain("keyart.config.ts");
    expect(await exists("keyart.config.ts")).toBe(true);
  });

  it("scaffolds .cursor/mcp.json with the keyart server entry", async () => {
    const result = await runInit({ cwd: tmpDir });

    expect(await exists(".cursor/mcp.json")).toBe(true);
    const mcp = JSON.parse(await readFile(".cursor/mcp.json"));
    expect(mcp.mcpServers.keyart).toEqual({
      command: "npx",
      args: ["@wildorder/keyart", "mcp"],
    });
    expect(result.created).toContain(".cursor/mcp.json");
  });

  it("never clobbers a pre-existing custom .cursor/mcp.json", async () => {
    const mcpPath = path.join(tmpDir, ".cursor", "mcp.json");
    const original =
      JSON.stringify(
        {
          mcpServers: {
            other: { command: "x" },
            keyart: { command: "node", args: ["./my-fork.js"] },
          },
        },
        null,
        2,
      ) + "\n";
    await fs.mkdir(path.dirname(mcpPath), { recursive: true });
    await fs.writeFile(mcpPath, original, "utf-8");

    const result = await runInit({ cwd: tmpDir });

    // Byte-identical — untouched.
    expect(await readFile(".cursor/mcp.json")).toBe(original);
    expect(
      result.skipped.some(
        (s) => s.startsWith(".cursor/mcp.json") && s.includes("--force"),
      ),
    ).toBe(true);
  });

  it("re-run is quiet for an already-matching .cursor/mcp.json", async () => {
    await runInit({ cwd: tmpDir });
    const result = await runInit({ cwd: tmpDir });

    expect(result.created).not.toContain(".cursor/mcp.json");
    expect(
      result.skipped.some((s) => s.startsWith(".cursor/mcp.json")),
    ).toBe(false);
  });

  it("leaves an invalid .cursor/mcp.json untouched even with force", async () => {
    const mcpPath = path.join(tmpDir, ".cursor", "mcp.json");
    await fs.mkdir(path.dirname(mcpPath), { recursive: true });
    await fs.writeFile(mcpPath, "not json", "utf-8");

    const result = await runInit({ cwd: tmpDir, force: true });

    expect(await readFile(".cursor/mcp.json")).toBe("not json");
    expect(
      result.skipped.some((s) => s.startsWith(".cursor/mcp.json")),
    ).toBe(true);
  });

  it("scaffolds the default direction layout + empty brand.yaml", async () => {
    const result = await runInit({ cwd: tmpDir });

    // Direction record + memory + brief + versions dir.
    expect(await exists("brand/directions/default/direction.yaml")).toBe(true);
    expect(await exists("brand/directions/default/memory.yaml")).toBe(true);
    expect(await exists("brand/directions/default/brief.md")).toBe(true);
    // brief.md is a projection now: a fresh (empty) brief renders the stable
    // placeholder, not the freeform template.
    const directionBriefMd = await readFile("brand/directions/default/brief.md");
    expect(directionBriefMd.trim()).toBe(
      "_No brief yet. Describe this direction's audience, problem, tone, and aesthetic intent._",
    );

    // brand.yaml parses as a GlobalBrand with a null pointer + empty rules.
    expect(await exists("brand/brand.yaml")).toBe(true);
    const brand = parseGlobalBrand(yamlParse(await readFile("brand/brand.yaml")));
    expect(brand.approvedPointer).toBeNull();
    expect(brand.rules).toEqual([]);

    // The new entries are reported as created.
    expect(result.created).toContain("brand/directions/default/direction.yaml");
    expect(result.created).toContain("brand/directions/default/memory.yaml");
    expect(result.created).toContain("brand/directions/default/brief.md");
    expect(result.created).toContain("brand/brand.yaml");

  });

  it("never overwrites brand.yaml or clobbers the direction brief without --force", async () => {
    await runInit({ cwd: tmpDir });

    // User edits the direction brief; a plain re-run must preserve it.
    const directionBrief = path.join(tmpDir, "brand/directions/default/brief.md");
    await fs.writeFile(directionBrief, "// user direction brief\n", "utf-8");

    await runInit({ cwd: tmpDir });
    expect(await readFile("brand/directions/default/brief.md")).toBe(
      "// user direction brief\n",
    );

    // Simulate a user-authored brand.yaml carrying a rule. brand.yaml holds
    // lifecycle/authored data, so even `--force` must leave it untouched.
    const authored =
      "approvedPointer: null\n" +
      "rules:\n" +
      "  - id: rule-1\n" +
      "    severity: hard\n" +
      "    text: never use comic sans\n" +
      "    author: tim\n" +
      "    source: cli\n" +
      "    date: 2026-01-01T00:00:00.000Z\n" +
      "version: 1\n" +
      "createdAt: 2026-01-01T00:00:00.000Z\n" +
      "updatedAt: 2026-01-01T00:00:00.000Z\n";
    await fs.writeFile(path.join(tmpDir, "brand/brand.yaml"), authored, "utf-8");

    await runInit({ cwd: tmpDir, force: true });

    expect(await readFile("brand/brand.yaml")).toBe(authored);
    const brand = parseGlobalBrand(yamlParse(await readFile("brand/brand.yaml")));
    expect(brand.rules).toHaveLength(1);
  });

});
