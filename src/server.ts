/**
 * `keyart/server` — the UNSTABLE embedding surface.
 *
 * Everything the `keyart serve` command composes, exported so an embedding
 * host (for example a hosted deployment) can assemble the same HTTP surface
 * behind its own middleware instead of forking the CLI:
 *
 * - `createApiMounts` returns the ordered route mounts; the local-only
 *   Origin/Host guard sits at index 0 — an embedding host replaces that slot
 *   with its own auth/tenancy middleware and every route inherits it.
 * - `createJobStore` is the in-process job tracker `serve` wires in.
 * - `dispatchCommand` is the single command chokepoint the CLI, MCP facades,
 *   and chat agent all route through.
 * - `runChatTurn`/`resumeChatTurn` + `LoopDeps` are the transport-agnostic
 *   chat loop; `createChatApi` is the reference SSE adapter over it.
 * - `configureModelClient` points every model call at an OpenAI-compatible
 *   endpoint (also set from `keyart.config.ts` → `models.baseURL`).
 *
 * UNSTABLE: this subpath exists so downstream composition needs no deep
 * imports, but its shape follows the internals — pre-1.0, any release may
 * change it without a major version. The package root (`keyart`) remains the
 * only stable API.
 */

export {
  createApiMounts,
  runServe,
} from "./commands/serve.js";
export type { Mount } from "./ui/static-server.js";
export { createJobStore } from "./ui/jobs.js";
export type { Job, JobKind, JobStatus, JobStore } from "./ui/jobs.js";
export { createChatApi } from "./ui/chat-api.js";
export {
  dispatchCommand,
  listCommands,
  getCommand,
} from "./mcp/registry.js";
export type {
  CommandMeta,
  DispatchResult,
  FacadeInput,
} from "./mcp/registry.js";
export { runChatTurn, resumeChatTurn } from "./agent/loop.js";
export type {
  ChatEvent,
  CompleteFn,
  DispatchFn,
  LaunchJobFn,
  LoopDeps,
} from "./agent/loop.js";
export {
  configureModelClient,
  createClient,
  hasApiKey,
  recordModelUsage,
} from "./openai.js";
export type { ModelClientOptions, ModelUsage } from "./openai.js";
export { loadConfig } from "./config.js";
