import { describe, it, expect } from "vitest";
import { mergeMcpConfig, KEYART_MCP_SERVER } from "./mcp-config.js";

describe("mergeMcpConfig", () => {
  it("creates a fresh config when the file does not exist", () => {
    const result = mergeMcpConfig(null);
    expect(result.action).toBe("created");
    expect(result.content).toBeDefined();
    expect(result.content!.endsWith("\n")).toBe(true);
    expect(JSON.parse(result.content!)).toEqual({
      mcpServers: {
        keyart: { command: "npx", args: ["@wildorder/keyart", "mcp"] },
      },
    });
  });

  it("merges in the keyart entry while preserving siblings and unknown keys", () => {
    const raw = JSON.stringify({
      mcpServers: { other: { command: "x" } },
      customTopLevel: true,
    });
    const result = mergeMcpConfig(raw);
    expect(result.action).toBe("merged");
    const parsed = JSON.parse(result.content!);
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
    expect(parsed.customTopLevel).toBe(true);
    expect(parsed.mcpServers.keyart).toEqual(KEYART_MCP_SERVER);
  });

  it("creates the mcpServers object if absent", () => {
    const raw = JSON.stringify({ customTopLevel: true });
    const result = mergeMcpConfig(raw);
    expect(result.action).toBe("merged");
    const parsed = JSON.parse(result.content!);
    expect(parsed.customTopLevel).toBe(true);
    expect(parsed.mcpServers.keyart).toEqual(KEYART_MCP_SERVER);
  });

  it("is idempotent when the keyart entry already matches", () => {
    const raw = JSON.stringify({
      mcpServers: { keyart: { command: "npx", args: ["@wildorder/keyart", "mcp"] } },
    });
    const result = mergeMcpConfig(raw);
    expect(result.action).toBe("unchanged");
    expect(result.content).toBeUndefined();
  });

  it("respects an existing custom keyart entry without force", () => {
    const raw = JSON.stringify({
      mcpServers: {
        other: { command: "x" },
        keyart: { command: "node", args: ["./my-fork.js"] },
      },
    });
    const result = mergeMcpConfig(raw);
    expect(result.action).toBe("skipped-exists");
    expect(result.content).toBeUndefined();
    expect(result.reason).toContain("--force");
  });

  it("overwrites a custom keyart entry with force, leaving siblings intact", () => {
    const raw = JSON.stringify({
      mcpServers: {
        other: { command: "x" },
        keyart: { command: "node", args: ["./my-fork.js"] },
      },
    });
    const result = mergeMcpConfig(raw, { force: true });
    expect(result.action).toBe("merged");
    const parsed = JSON.parse(result.content!);
    expect(parsed.mcpServers.keyart).toEqual(KEYART_MCP_SERVER);
    expect(parsed.mcpServers.other).toEqual({ command: "x" });
  });

  it("never writes over invalid JSON", () => {
    const result = mergeMcpConfig("{ not json");
    expect(result.action).toBe("skipped-invalid");
    expect(result.content).toBeUndefined();
    expect(result.reason).toContain("not valid JSON");
  });
});
