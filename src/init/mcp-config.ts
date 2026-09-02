/** The server entry written into .cursor/mcp.json. */
export const KEYART_MCP_SERVER = {
  command: "npx",
  args: ["keyart", "mcp"],
} as const;

export type McpMergeAction =
  | "created"
  | "merged"
  | "unchanged"
  | "skipped-exists"
  | "skipped-invalid";

export interface McpMergeResult {
  action: McpMergeAction;
  /** Full new file content (2-space indent, trailing newline). Present only for "created" | "merged". */
  content?: string;
  /** Human-readable note for skip cases (shown in the init summary). */
  reason?: string;
}

function serialize(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + "\n";
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Pure merge logic for `.cursor/mcp.json`. No filesystem I/O.
 *
 * @param existingRaw Raw file contents, or `null` if the file does not exist.
 */
export function mergeMcpConfig(
  existingRaw: string | null,
  opts?: { force?: boolean },
): McpMergeResult {
  const force = opts?.force ?? false;

  if (existingRaw === null) {
    return {
      action: "created",
      content: serialize({
        mcpServers: { keyart: KEYART_MCP_SERVER },
      }),
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(existingRaw) as Record<string, unknown>;
  } catch {
    return {
      action: "skipped-invalid",
      reason:
        ".cursor/mcp.json is not valid JSON — fix it manually, file left untouched",
    };
  }

  const existingServers =
    (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  const existingEntry = existingServers.keyart;

  if (existingEntry !== undefined) {
    if (deepEqual(existingEntry, KEYART_MCP_SERVER)) {
      return { action: "unchanged" };
    }
    if (!force) {
      return {
        action: "skipped-exists",
        reason:
          ".cursor/mcp.json already has a custom keyart entry (use --force to overwrite)",
      };
    }
  }

  const merged = {
    ...parsed,
    mcpServers: {
      ...existingServers,
      keyart: KEYART_MCP_SERVER,
    },
  };

  return { action: "merged", content: serialize(merged) };
}
