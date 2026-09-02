import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "./server.js";
import type { KeyartConfig } from "../types.js";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, loadConfig: vi.fn(actual.loadConfig) };
});

let tmpDir: string;

function buildTestConfig(cwd: string): KeyartConfig {
  return {
    project: { name: "MCP Test", type: "prototype", framework: "next" },
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

async function connectClient(defaultCwd: string): Promise<Client> {
  const server = buildServer({ defaultCwd });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

interface TextContent {
  type: string;
  text: string;
}

function firstText(result: unknown): string {
  const content = (result as { content: TextContent[] }).content;
  return content[0].text;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "keyart-mcp-"));
  delete process.env.OPENAI_API_KEY;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("MCP server", () => {
  it("tools/list is exactly the four facades — no keyart_run", async () => {
    const client = await connectClient(tmpDir);
    const { tools } = await client.listTools();

    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "keyart_brand",
      "keyart_help",
      "keyart_implement",
      "keyart_setup",
    ]);
    expect(names).not.toContain("keyart_run");
    for (const tool of tools) {
      expect(tool.description && tool.description.length).toBeGreaterThan(0);
      expect((tool.description ?? "").length).toBeLessThan(800);
    }
  });

  it("facade descriptions carry their group's command catalog", async () => {
    const client = await connectClient(tmpDir);
    const { tools } = await client.listTools();
    const desc = (name: string): string =>
      tools.find((t) => t.name === name)?.description ?? "";

    for (const cmd of ["direction", "explore", "regenerate", "approve", "rule", "promote"]) {
      expect(desc("keyart_brand")).toContain(cmd);
    }
    expect(desc("keyart_brand")).not.toContain("refine");
    expect(desc("keyart_brand")).not.toContain(["con", "cept"].join(""));
    for (const cmd of ["brief", "audit"]) {
      expect(desc("keyart_implement")).toContain(cmd);
    }
    for (const cmd of ["init", "doctor"]) {
      expect(desc("keyart_setup")).toContain(cmd);
    }
  });

  it("keyart_help with no arg returns the grouped index", async () => {
    const client = await connectClient(tmpDir);
    const result = await client.callTool({ name: "keyart_help", arguments: {} });
    const text = firstText(result);

    for (const tool of [
      "keyart_brand",
      "keyart_implement",
      "keyart_setup",
    ]) {
      expect(text).toContain(tool);
    }
    for (const cmd of ["explore", "approve", "brief", "audit", "init", "doctor"]) {
      expect(text).toContain(cmd);
    }
    expect(text).toContain("serve");
    expect(text).toContain("CLI-only");
    expect(text).toContain(`"command"`);
    expect(text).toContain(`"group"`);
    expect(text).toContain(`"workflow"`);
  });

  it("keyart_help { command } returns the full doc; bogus is an error", async () => {
    const client = await connectClient(tmpDir);

    const ok = await client.callTool({
      name: "keyart_help",
      arguments: { command: "explore" },
    });
    const text = firstText(ok);
    expect(text).toContain("## Usage");
    expect(text).toContain("## Outputs");
    expect(text).toContain("## Examples");

    const bad = await client.callTool({
      name: "keyart_help",
      arguments: { command: "bogus" },
    });
    expect(bad.isError).toBe(true);
    expect(firstText(bad)).toContain(
      "init, explore, approve, brief, audit, serve",
    );
  });

  it("keyart_help { group } scopes to that group; unknown is an error", async () => {
    const client = await connectClient(tmpDir);

    const ok = await client.callTool({
      name: "keyart_help",
      arguments: { group: "brand" },
    });
    const text = firstText(ok);
    expect(text).toContain("explore");
    expect(text).toContain("approve");

    const bad = await client.callTool({
      name: "keyart_help",
      arguments: { group: "nope" },
    });
    expect(bad.isError).toBe(true);
    const badText = firstText(bad);
    expect(badText).toContain("brand");
    expect(badText).toContain("implement");
    expect(badText).toContain("setup");
  });

  it("keyart_help { workflow: true } returns the lifecycle narrative", async () => {
    const client = await connectClient(tmpDir);
    const result = await client.callTool({
      name: "keyart_help",
      arguments: { workflow: true },
    });
    const text = firstText(result);
    expect(text.split("\n").length).toBeGreaterThan(1);
    expect(text).toContain("explore");
    expect(text).toContain("approve");
    expect(text).toContain("audit");
  });

  it("dispatches init then explore through facades with object input (dry-run)", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const client = await connectClient(tmpDir);

    const initResult = await client.callTool({
      name: "keyart_setup",
      arguments: { command: "init", cwd: tmpDir },
    });
    expect(initResult.isError).toBeFalsy();
    const initText = firstText(initResult);
    expect(initText).toContain("Files written");
    expect(initText).toContain(".cursor/mcp.json");

    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const exploreResult = await client.callTool({
      name: "keyart_brand",
      // Positional mode: generate v1 into the init-scaffolded "default" draft.
      arguments: { command: "explore", input: ["default"], cwd: tmpDir },
    });
    expect(exploreResult.isError).toBeFalsy();
    const text = firstText(exploreResult);
    expect(text).toContain("Files written");
    expect(text).toMatch(/brand\/directions\//);

    // The reported direction-version.json must exist on disk under tmpDir.
    const match = text.match(
      /(brand\/directions\/[^\s]*direction-version\.json)/,
    );
    expect(match).toBeTruthy();
    const versionPath = path.join(tmpDir, match![1]);
    await expect(fs.access(versionPath)).resolves.toBeUndefined();

    // Test 11: no command log line leaked to the REAL stdout during dispatch.
    const wroteLog = stdoutSpy.mock.calls.some((call) =>
      String(call[0]).includes("Explore complete"),
    );
    expect(wroteLog).toBe(false);
  });

  it("accepts string input (whitespace-split) through a facade", async () => {
    const { loadConfig } = await import("../config.js");
    vi.mocked(loadConfig).mockResolvedValue(buildTestConfig(tmpDir));

    const client = await connectClient(tmpDir);
    const result = await client.callTool({
      name: "keyart_brand",
      arguments: { command: "direction", input: "list", cwd: tmpDir },
    });
    expect(result.isError).toBeFalsy();
  });

  it("rejects serve via a facade but keeps the server alive", async () => {
    const client = await connectClient(tmpDir);
    const result = await client.callTool({
      name: "keyart_setup",
      arguments: { command: "serve" },
    });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("npx keyart serve");

    const followUp = await client.callTool({
      name: "keyart_help",
      arguments: {},
    });
    expect(followUp.isError).toBeFalsy();
  });

  it("errors on an unknown command and bad args, staying responsive", async () => {
    const client = await connectClient(tmpDir);

    const unknown = await client.callTool({
      name: "keyart_brand",
      arguments: { command: "wat" },
    });
    expect(unknown.isError).toBe(true);
    expect(firstText(unknown)).toContain(
      "init, explore, approve, brief, audit, serve",
    );

    const badArgs = await client.callTool({
      name: "keyart_brand",
      arguments: { command: "approve", input: [], cwd: tmpDir },
    });
    expect(badArgs.isError).toBe(true);
    expect(firstText(badArgs)).toContain("Usage:");

    // Server still responds to a follow-up call.
    const followUp = await client.callTool({
      name: "keyart_help",
      arguments: {},
    });
    expect(followUp.isError).toBeFalsy();
  });
});
