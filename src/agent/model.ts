import type { VerbLeaf } from "./verb-catalog.js";
import { createClient, recordModelUsage } from "../openai.js";
import { DEFAULT_MODELS } from "../types.js";

/** One tool call the model asked for. `arguments` is the parsed JSON object. */
export interface ToolCall {
  id: string; // the model's tool_call id (echoed on the tool result)
  toolName: string; // maps to a VerbLeaf.toolName
  arguments: Record<string, unknown>; // parsed function arguments
}

/**
 * One assistant turn from the model, ASSEMBLED: the full prose + any tool
 * calls. The streaming seam yields this as its final `done` chunk (after the
 * prose has already streamed as `text-delta` chunks), so the loop has both
 * the live deltas and the authoritative assembled turn (with tool-call
 * fragments merged).
 */
export interface AssistantTurn {
  content?: string; // full assistant prose = concatenation of the turn's text-deltas
  toolCalls: ToolCall[]; // empty ⇒ a prose turn ends the loop
}

/**
 * One chunk from the STREAMING model seam. Prose arrives incrementally as
 * `text-delta`; the terminal `done` carries the fully-assembled turn
 * (OpenAI's fragmented tool_call deltas merged into whole ToolCalls inside
 * model.ts).
 */
export type CompletionChunk =
  | { type: "text-delta"; text: string }
  | { type: "done"; turn: AssistantTurn };

/** The OpenAI-shaped message history the seam sends. */
export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: null; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** A suspended mutating call awaiting the user's approve/deny. Carries the EXACT call. */
export interface PendingApproval {
  sessionId: string;
  call: ToolCall;
  leaf: VerbLeaf; // its mutates class drives the UI's confirm weight (WS-04)
  tokens: string[]; // toolCallToTokens(leaf, call.arguments) — the exact dispatch tokens
}

/** The focused studio selection the agent inherits. */
export interface ChatContext {
  directionId: string;
  versionId?: string;
}

/**
 * The one model seam — STREAMING. Injectable; the only place the loop
 * touches a model. Yields prose deltas live, then a terminal `done` with the
 * assembled turn. A test fake is a plain async generator, so streaming stays
 * fully deterministic.
 */
export type CompleteFn = (
  messages: ChatMessage[],
  tools: unknown[],
) => AsyncIterable<CompletionChunk>;

/** Thrown by `complete()` when no OpenAI API key is configured. Never a fabricated turn. */
export class ChatUnavailableError extends Error {
  constructor() {
    super("Chat is unavailable: no OPENAI_API_KEY configured.");
    this.name = "ChatUnavailableError";
  }
}

/** Maps the loop's `ChatMessage[]` to the OpenAI `chat.completions` message shape. */
function toOpenAIMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    }
    if (m.role === "assistant" && m.content === null) {
      return {
        role: "assistant",
        content: null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.toolName,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

/** Parses a tool call's accumulated arguments string; malformed JSON degrades to `{}`. */
function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argsBuf: string;
}

/**
 * Factory closing over the existing `src/openai.ts` client. Returns the
 * injectable, STREAMING `complete()` seam — the ONLY place under `src/agent/`
 * that touches `src/openai.ts`. Imports nothing from `src/ui/`. Not a
 * provider abstraction — OpenAI only.
 */
export function createComplete(opts?: { model?: string }): CompleteFn {
  return async function* complete(
    messages: ChatMessage[],
    tools: unknown[],
  ): AsyncIterable<CompletionChunk> {
    const client = createClient();
    if (!client) {
      throw new ChatUnavailableError();
    }

    const model = opts?.model ?? DEFAULT_MODELS.text;
    const stream = await client.chat.completions.create({
      model,
      messages: toOpenAIMessages(messages) as never,
      tools: tools as never,
      tool_choice: "auto",
      stream: true,
      // The usage block only exists on a stream when asked for; it arrives as
      // a final choice-less chunk, fed to the metering hook below.
      stream_options: { include_usage: true },
    });

    let contentBuf = "";
    const toolCalls = new Map<number, ToolCallAccumulator>();

    for await (const part of stream) {
      if (part.usage) recordModelUsage(model, part.usage);
      const delta = part.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        contentBuf += delta.content;
        yield { type: "text-delta", text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index = tc.index;
          let entry = toolCalls.get(index);
          if (!entry) {
            entry = { id: "", name: "", argsBuf: "" };
            toolCalls.set(index, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.argsBuf += tc.function.arguments;
        }
      }
    }

    const turn: AssistantTurn = {
      content: contentBuf || undefined,
      toolCalls: [...toolCalls.values()].map((entry) => ({
        id: entry.id,
        toolName: entry.name,
        arguments: parseArguments(entry.argsBuf),
      })),
    };

    yield { type: "done", turn };
  };
}
