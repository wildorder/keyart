import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "../mcp/server.js";
import { redirectConsoleToStderr } from "../mcp/capture.js";
import { loadEnvFiles } from "../env.js";

export async function runMcp(opts: { cwd: string }): Promise<void> {
  // Re-point console.* to stderr BEFORE connecting: stdout is the JSON-RPC channel.
  redirectConsoleToStderr();

  // Load .env / .env.keyart / .env.local into process.env before dispatch so
  // agent-triggered explore/audit see the user's OPENAI_API_KEY instead of
  // silently dry-running. Synchronous; writes nothing to stdout (and console is
  // already redirected to stderr as a belt-and-braces guard).
  loadEnvFiles(path.resolve(opts.cwd));

  const server = buildServer({ defaultCwd: path.resolve(opts.cwd) });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write("keyart mcp server running (stdio)\n");

  // Keep the process alive; the transport closes when the client disconnects.
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
}
