import type { DispatchResult } from "../mcp/registry.js";
import type { dispatchCommand } from "../mcp/registry.js";
import { loadConfig } from "../config.js";
import { assembleForChat } from "./context.js";
import {
  listLeaves,
  applyContext,
  toolCallToTokens,
} from "./verb-catalog.js";
import type { VerbLeaf } from "./verb-catalog.js";
import { listToolSchemas } from "./tool-schemas.js";
import type {
  AssistantTurn,
  ChatContext,
  ChatMessage,
  CompleteFn,
  PendingApproval,
  ToolCall,
} from "./model.js";
import type { ChatSession } from "./session.js";

export type { CompleteFn } from "./model.js";

/**
 * The SINGLE canonical event union WS-02 OWNS. `token` events carry live
 * assistant prose deltas (re-emitted from the `complete()` seam's
 * text-deltas); `assistant_message` SEALS a prose step with its full
 * authoritative text — the UI renders tokens live, then replaces the
 * in-progress bubble with the sealed text. Tool events (tool_call/
 * tool_result/pending_approval/job) also stream live as they occur.
 */
export type ChatEvent =
  | { type: "token"; text: string } // a live assistant prose delta (streamed)
  | { type: "assistant_message"; text: string } // the completed prose for one step (= concatenated tokens); seals the bubble
  | { type: "tool_call"; toolName: string; arguments: Record<string, unknown> }
  | {
      type: "pending_approval";
      sessionId: string;
      toolName: string;
      arguments: Record<string, unknown>;
      mutates: "write" | "destructive";
    }
  | { type: "tool_result"; toolName: string; text: string; isError: boolean }
  | { type: "job"; jobId: string; kind: string }
  | { type: "done"; sessionId: string }
  | { type: "error"; message: string; unavailable?: boolean };

export type DispatchFn = typeof dispatchCommand;
export type LaunchJobFn = (kind: string, tokens: string[]) => { jobId: string }; // SYNC — jobs.start returns immediately

export interface LoopDeps {
  complete: CompleteFn; // the model seam (injected; fake in tests)
  dispatch: DispatchFn; // the single write path (injected)
  launchJob: LaunchJobFn; // WS-03 injects the jobs bridge; fake in tests
  cwd: string; // where buildPreamble reads memory + where dispatch runs
  maxToolIterations?: number; // safety bound on tool round-trips (default 8)
  historyBudget?: number; // retained non-system turns (default 40)
}

const DEFAULT_MAX_TOOL_ITERATIONS = 8;
const DEFAULT_HISTORY_BUDGET = 40;

/**
 * The long-running leaves (image/screenshot calls, 60s+). Keyed by leaf
 * toolName — NOT command — because the five `asset` leaves share one command
 * but only extract/regenerate are long-running. For the original four members
 * toolName === command (1:1 leaves), so this re-keying is behavior-identical
 * for them. Every member is `write`/`destructive`, so every one SUSPENDS in
 * the shared tool handler; `launchJob` is consulted ONLY in `resumeChatTurn`,
 * on approval — never during `runChatTurn`.
 */
const LONG_RUNNING = new Set([
  "explore",
  "regenerate",
  "approve",
  "audit",
  "asset_extract",
  "asset_regenerate",
]);

/** Keeps at most `budget` retained messages, never orphaning a `tool` message from its assistant tool-call message. */
function capHistory(session: ChatSession, budget: number): void {
  while (session.messages.length > budget) {
    const first = session.messages[0];
    if (first.role === "assistant" && first.content === null) {
      let end = 1;
      while (end < session.messages.length && session.messages[end].role === "tool") {
        end++;
      }
      session.messages.splice(0, end);
    } else {
      session.messages.shift();
    }
  }
}

function appendMessage(session: ChatSession, msg: ChatMessage, budget: number): void {
  session.messages.push(msg);
  capHistory(session, budget);
}

type ToolOutcome =
  | { kind: "dispatched"; message: ChatMessage }
  | { kind: "suspended" };

/**
 * The shared tool handler — the ONE place a dispatch (or suspension) happens
 * for a single `ToolCall`, so the confirm gate is unbypassable (SC-04).
 */
async function* handleToolCall(
  deps: LoopDeps,
  session: ChatSession,
  leaves: Map<string, VerbLeaf>,
  call: ToolCall,
): AsyncGenerator<ChatEvent, ToolOutcome, unknown> {
  yield { type: "tool_call", toolName: call.toolName, arguments: call.arguments };

  const leaf = leaves.get(call.toolName);
  if (!leaf) {
    const text = "Unknown tool.";
    yield { type: "tool_result", toolName: call.toolName, text, isError: true };
    return {
      kind: "dispatched",
      message: { role: "tool", toolCallId: call.id, content: text },
    };
  }

  // Inherit ids via the pure applyContext BEFORE toolCallToTokens (SC-05/SC-10):
  // ONLY the focused directionId is inherited (the single `directionSlot`) —
  // NO versionId is ever injected, so an omitted version stays omitted through
  // leaf construction, PendingApproval, and resume; the dispatched tokens carry
  // only the direction target. Both applyContext and toolCallToTokens perform
  // NO filesystem access — the head is resolved by the dispatched/launched
  // command AFTER approval, never before the confirm gate.
  const filled = applyContext(leaf, call.arguments, {
    directionId: session.context.directionId,
  });
  const tokens = toolCallToTokens(leaf, filled);

  if (leaf.mutates === "none") {
    const r: DispatchResult = await deps.dispatch(
      { command: leaf.command, input: tokens },
      { defaultCwd: deps.cwd },
    );
    yield { type: "tool_result", toolName: call.toolName, text: r.text, isError: r.isError };
    return {
      kind: "dispatched",
      message: { role: "tool", toolCallId: call.id, content: r.text },
    };
  }

  // write | destructive — THE GATE: SUSPEND, never dispatch, never launchJob here.
  const pending: PendingApproval = {
    sessionId: session.id,
    call: { id: call.id, toolName: call.toolName, arguments: filled },
    leaf,
    tokens,
  };
  session.pending = pending;
  yield {
    type: "pending_approval",
    sessionId: session.id,
    toolName: call.toolName,
    arguments: filled,
    mutates: leaf.mutates,
  };
  return { kind: "suspended" };
}

/** Regenerates the system preamble from live state (`ChatContext` + a fresh `assembleContext`). */
async function buildPreamble(deps: LoopDeps, context: ChatContext): Promise<ChatMessage> {
  const config = await loadConfig(deps.cwd);
  const content = await assembleForChat(context, { cwd: deps.cwd, config });
  return { role: "system", content };
}

/**
 * Drives tool round-trips until a prose turn ends the loop, a mutating call
 * suspends, or `maxToolIterations` is exceeded. Shared by `runChatTurn`
 * (first entry) and `resumeChatTurn` (re-entry after approve/deny).
 */
async function* runToolLoop(deps: LoopDeps, session: ChatSession): AsyncGenerator<ChatEvent> {
  const leaves = new Map(listLeaves().map((l) => [l.toolName, l]));
  const tools = listToolSchemas();
  const maxIterations = deps.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS;
  const historyBudget = deps.historyBudget ?? DEFAULT_HISTORY_BUDGET;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const systemMsg = await buildPreamble(deps, session.context);

    let turn: AssistantTurn | undefined;
    for await (const chunk of deps.complete([systemMsg, ...session.messages], tools)) {
      if (chunk.type === "text-delta") {
        yield { type: "token", text: chunk.text };
      } else {
        turn = chunk.turn;
      }
    }

    if (!turn) {
      yield { type: "error", message: "The model stream ended without a result." };
      return;
    }

    if (turn.content) {
      yield { type: "assistant_message", text: turn.content };
    }

    if (turn.toolCalls.length === 0) {
      appendMessage(session, { role: "assistant", content: turn.content ?? "" }, historyBudget);
      yield { type: "done", sessionId: session.id };
      return;
    }

    appendMessage(
      session,
      { role: "assistant", content: null, toolCalls: turn.toolCalls },
      historyBudget,
    );

    let suspended = false;
    for (const call of turn.toolCalls) {
      const outcome = yield* handleToolCall(deps, session, leaves, call);
      if (outcome.kind === "suspended") {
        suspended = true;
        break; // do not dispatch later calls in this turn speculatively
      }
      appendMessage(session, outcome.message, historyBudget);
    }

    if (suspended) {
      return; // the generator ends after the pending_approval event
    }
    // Otherwise every call in this turn was read-only/job-launch: feed the
    // tool results back to the model on the next iteration.
  }

  const boundMessage = `Reached the maximum of ${maxIterations} tool round-trips for this turn; stopping.`;
  appendMessage(session, { role: "assistant", content: boundMessage }, historyBudget);
  yield { type: "assistant_message", text: boundMessage };
  yield { type: "done", sessionId: session.id };
}

/** Starts (or continues) a chat turn from a new user message. */
export async function* runChatTurn(
  deps: LoopDeps,
  session: ChatSession,
  userMessage: string,
): AsyncGenerator<ChatEvent> {
  if (session.pending) {
    yield { type: "error", message: "A previous action is awaiting approval." };
    return;
  }

  const historyBudget = deps.historyBudget ?? DEFAULT_HISTORY_BUDGET;
  appendMessage(session, { role: "user", content: userMessage }, historyBudget);

  yield* runToolLoop(deps, session);
}

/** Resumes a suspended chat turn after the user approves or denies the pending mutating call. */
export async function* resumeChatTurn(
  deps: LoopDeps,
  session: ChatSession,
  decision: { approve: boolean },
): AsyncGenerator<ChatEvent> {
  const pending = session.pending;
  if (!pending) {
    yield { type: "error", message: "Nothing is awaiting approval." };
    return;
  }

  const historyBudget = deps.historyBudget ?? DEFAULT_HISTORY_BUDGET;
  session.pending = undefined;

  if (decision.approve) {
    if (LONG_RUNNING.has(pending.leaf.toolName)) {
      const { jobId } = deps.launchJob(pending.leaf.command, pending.tokens);
      yield { type: "job", jobId, kind: pending.leaf.command };
      const text = `Launched ${pending.leaf.command} as job ${jobId}.`;
      yield { type: "tool_result", toolName: pending.call.toolName, text, isError: false };
      appendMessage(
        session,
        { role: "tool", toolCallId: pending.call.id, content: text },
        historyBudget,
      );
    } else {
      const r: DispatchResult = await deps.dispatch(
        { command: pending.leaf.command, input: pending.tokens },
        { defaultCwd: deps.cwd },
      );
      yield { type: "tool_result", toolName: pending.call.toolName, text: r.text, isError: r.isError };
      appendMessage(
        session,
        { role: "tool", toolCallId: pending.call.id, content: r.text },
        historyBudget,
      );
    }
  } else {
    const text = "The user declined this action. Nothing was changed.";
    yield { type: "tool_result", toolName: pending.call.toolName, text, isError: false };
    appendMessage(
      session,
      { role: "tool", toolCallId: pending.call.id, content: text },
      historyBudget,
    );
  }

  yield* runToolLoop(deps, session);
}
