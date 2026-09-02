import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  dispatchCommand,
  getCommand,
  getGroup,
  groupHelp,
  groupToolDescription,
  helpIndex,
  listGroups,
  unknownCommandText,
  WORKFLOW_OVERVIEW,
} from "./registry.js";

export interface BuildServerOptions {
  /** cwd used when a facade call omits input.cwd. */
  defaultCwd: string;
}

// INTERACTIVITY INVARIANT (SC-05): no dispatchable command may block on stdin.
// As of WS-01, `init` is flag-driven (--force) and nothing in src/ reads stdin
// (the `prompts` package is present but unused). Any future command that needs
// interactive input MUST either accept explicit args or throw a CommandError
// when running under MCP — it must NEVER call `prompts` / read stdin from a
// `run` adapter, because the MCP server has no interactive terminal and would
// hang the JSON-RPC channel.

export function buildServer(opts: BuildServerOptions): McpServer {
  const server = new McpServer({ name: "keyart", version: "0.1.0" });

  // Capability facades: one tool per domain group. Grouping drives routing,
  // description, and help only — any command dispatches through any facade.
  const facadeInputSchema = {
    command: z.string(),
    input: z.union([z.string(), z.array(z.string())]).optional(),
    cwd: z.string().optional(),
  };

  for (const group of listGroups()) {
    server.registerTool(
      group.tool,
      {
        description: groupToolDescription(group.id),
        inputSchema: facadeInputSchema,
      },
      async (arg) => {
        const r = await dispatchCommand(
          { command: arg.command, input: arg.input, cwd: arg.cwd },
          { defaultCwd: opts.defaultCwd },
        );
        return { content: [{ type: "text", text: r.text }], isError: r.isError };
      },
    );
  }

  // Progressive docs. Precedence: workflow > command > group > index.
  server.registerTool(
    "keyart_help",
    {
      description:
        "Keyart docs. No args: a grouped command index. { command }: full usage for one command. { group: brand|implement|setup }: the domain's commands. { workflow: true }: the end-to-end lifecycle.",
      inputSchema: {
        command: z.string().optional(),
        group: z.string().optional(),
        workflow: z.boolean().optional(),
      },
    },
    async (input) => {
      if (input.workflow === true) {
        return {
          content: [{ type: "text", text: WORKFLOW_OVERVIEW }],
          isError: false,
        };
      }

      if (input.command) {
        const meta = getCommand(input.command);
        if (!meta) {
          return {
            isError: true,
            content: [{ type: "text", text: unknownCommandText(input.command) }],
          };
        }
        return { content: [{ type: "text", text: meta.helpDoc }], isError: false };
      }

      if (input.group) {
        const group = getGroup(input.group);
        if (!group) {
          const ids = listGroups()
            .map((g) => g.id)
            .join(", ");
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `Unknown group "${input.group}". Valid groups: ${ids}.`,
              },
            ],
          };
        }
        return {
          content: [{ type: "text", text: groupHelp(group.id) }],
          isError: false,
        };
      }

      return { content: [{ type: "text", text: helpIndex() }], isError: false };
    },
  );

  return server;
}
