/**
 * Pure SSE plumbing the `useChat` hook wraps: `parseSseFrames` splits a
 * decoded SSE byte buffer into complete `ChatEvent` frames (tolerating chunk
 * boundaries that land mid-frame), and `reduceChatEvent` folds one event into
 * the rendered transcript. JSX-free, total, unit-tested — this is where the
 * streaming UI logic gets executable coverage without a render harness.
 */
import type { ChatEvent, ChatTurn } from "./types.js";

export interface ParsedSseFrames {
  events: ChatEvent[];
  /** The trailing, not-yet-complete frame text — feed back in on the next chunk. */
  rest: string;
}

/**
 * Splits a buffer of accumulated SSE text on the `\n\n` frame delimiter.
 * Every complete frame's `data:` line is JSON-parsed into a `ChatEvent`; a
 * malformed frame is skipped rather than thrown (never throws). The final
 * (possibly incomplete) segment is returned as `rest` for the caller to
 * prepend to the next chunk.
 */
export function parseSseFrames(buffer: string): ParsedSseFrames {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: ChatEvent[] = [];
  for (const block of parts) {
    const trimmed = block.trim();
    if (trimmed.length === 0) continue;
    const dataLine = trimmed.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    try {
      events.push(JSON.parse(dataLine.slice("data: ".length)) as ChatEvent);
    } catch {
      // Malformed frame — skip it rather than throw.
    }
  }
  return { events, rest };
}

export interface ChatViewState {
  messages: ChatTurn[];
  pendingApproval: Extract<ChatEvent, { type: "pending_approval" }> | null;
  streaming: boolean;
  unavailable: boolean;
  error: string | null;
  sessionId: string | null;
}

/** The empty transcript a fresh `useChat` session starts from. */
export function initialChatViewState(): ChatViewState {
  return {
    messages: [],
    pendingApproval: null,
    streaming: false,
    unavailable: false,
    error: null,
    sessionId: null,
  };
}

/** Appends a user turn (plain text, no tool calls) — does not mutate `state`. */
export function appendUserTurn(state: ChatViewState, message: string): ChatViewState {
  return {
    ...state,
    messages: [...state.messages, { role: "user", content: message, toolCalls: [] }],
    error: null,
  };
}

/**
 * Ensures the last message is an open assistant turn (creating an empty one
 * if the transcript is empty or the last turn is a user turn), then applies
 * `update` to it. Does not mutate `messages`.
 */
function updateOpenAssistantTurn(
  messages: ChatTurn[],
  update: (turn: ChatTurn) => ChatTurn,
): ChatTurn[] {
  const last = messages[messages.length - 1];
  const opened: ChatTurn[] =
    last && last.role === "assistant"
      ? messages
      : [...messages, { role: "assistant", content: "", toolCalls: [] }];
  const idx = opened.length - 1;
  return [...opened.slice(0, idx), update(opened[idx])];
}

/**
 * Folds one `ChatEvent` into the rendered transcript. `token` deltas append
 * live to the in-progress assistant bubble (opening one if none is open);
 * `assistant_message` seals that SAME bubble with its authoritative full
 * text — it never appends a second bubble. `tool_call`/`tool_result`/`job`/
 * `pending_approval` attach to the current turn's tool-call log as they
 * arrive, so the UI can render them live. A `pending_approval` halts the
 * turn (`streaming: false`) until an `approve`/`deny` continuation feeds
 * further events into this SAME reducer.
 */
export function reduceChatEvent(state: ChatViewState, event: ChatEvent): ChatViewState {
  switch (event.type) {
    case "token":
      return {
        ...state,
        messages: updateOpenAssistantTurn(state.messages, (t) => ({
          ...t,
          content: t.content + event.text,
        })),
      };

    case "assistant_message":
      return {
        ...state,
        messages: updateOpenAssistantTurn(state.messages, (t) => ({
          ...t,
          content: event.text,
        })),
      };

    case "tool_call":
    case "job":
      return {
        ...state,
        messages: updateOpenAssistantTurn(state.messages, (t) => ({
          ...t,
          toolCalls: [...t.toolCalls, event],
        })),
      };

    case "tool_result":
      return {
        ...state,
        pendingApproval: null,
        messages: updateOpenAssistantTurn(state.messages, (t) => ({
          ...t,
          toolCalls: [...t.toolCalls, event],
        })),
      };

    case "pending_approval":
      return {
        ...state,
        streaming: false,
        pendingApproval: event,
        messages: updateOpenAssistantTurn(state.messages, (t) => ({
          ...t,
          toolCalls: [...t.toolCalls, event],
        })),
      };

    case "done":
      return { ...state, streaming: false, sessionId: event.sessionId };

    case "error":
      return {
        ...state,
        error: event.message,
        unavailable: event.unavailable === true ? true : state.unavailable,
      };

    default:
      return state;
  }
}
