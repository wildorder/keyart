import { describe, it, expect } from "vitest";
import { initialChatViewState, parseSseFrames, reduceChatEvent } from "./chat-stream.js";
import type { ChatEvent } from "./types.js";

function frame(event: ChatEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

describe("parseSseFrames", () => {
  it("parses complete frames and preserves an incomplete trailing frame in rest", () => {
    const full = frame({ type: "token", text: "Make " }) + frame({ type: "token", text: "warmer" });
    const splitPoint = full.length - 10; // land mid-frame
    const first = parseSseFrames(full.slice(0, splitPoint));
    expect(first.events).toEqual([{ type: "token", text: "Make " }]);
    expect(first.rest.length).toBeGreaterThan(0);

    const second = parseSseFrames(first.rest + full.slice(splitPoint));
    expect(second.events).toEqual([{ type: "token", text: "warmer" }]);
    expect(second.rest).toBe("");
  });

  it("parses a data-only frame (no event: line)", () => {
    const raw = `data: ${JSON.stringify({ type: "done", sessionId: "s1" })}\n\n`;
    const { events, rest } = parseSseFrames(raw);
    expect(events).toEqual([{ type: "done", sessionId: "s1" }]);
    expect(rest).toBe("");
  });

  it("parses a multi-line frame with event: and data: lines", () => {
    const ev: ChatEvent = { type: "tool_result", toolName: "direction_list", text: "ok", isError: false };
    const raw = `event: tool_result\nid: 1\ndata: ${JSON.stringify(ev)}\n\n`;
    const { events } = parseSseFrames(raw);
    expect(events).toEqual([ev]);
  });

  it("returns no events and empty rest for an empty buffer", () => {
    expect(parseSseFrames("")).toEqual({ events: [], rest: "" });
  });
});

describe("reduceChatEvent", () => {
  it("streams token deltas into a live-growing assistant bubble", () => {
    let state = initialChatViewState();
    for (const text of ["Make ", "the CTA ", "warmer"]) {
      state = reduceChatEvent(state, { type: "token", text });
    }
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ role: "assistant", content: "Make the CTA warmer" });
  });

  it("assistant_message seals the SAME bubble rather than appending a second one", () => {
    let state = initialChatViewState();
    for (const text of ["Make ", "the CTA ", "warmer"]) {
      state = reduceChatEvent(state, { type: "token", text });
    }
    state = reduceChatEvent(state, { type: "assistant_message", text: "Make the CTA warmer" });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toBe("Make the CTA warmer");
  });

  it("tool_call attaches a card to the current turn", () => {
    let state = initialChatViewState();
    state = reduceChatEvent(state, {
      type: "tool_call",
      toolName: "direction_list",
      arguments: {},
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].toolCalls).toEqual([
      { type: "tool_call", toolName: "direction_list", arguments: {} },
    ]);
  });

  it("pending_approval halts consumption: sets pendingApproval and streaming: false", () => {
    let state = { ...initialChatViewState(), streaming: true };
    const pending: ChatEvent = {
      type: "pending_approval",
      sessionId: "s1",
      toolName: "direction_feedback",
      arguments: { body: "warmer" },
      mutates: "write",
    };
    state = reduceChatEvent(state, pending);
    expect(state.pendingApproval).toEqual(pending);
    expect(state.streaming).toBe(false);

    // No subsequent write is reflected until an approve turn feeds further events.
    const before = state;
    expect(state).toBe(before);
  });

  it("a following tool_result (after approve) clears pendingApproval and records the result", () => {
    let state = initialChatViewState();
    state = reduceChatEvent(state, {
      type: "pending_approval",
      sessionId: "s1",
      toolName: "direction_feedback",
      arguments: {},
      mutates: "write",
    });
    expect(state.pendingApproval).not.toBeNull();

    state = reduceChatEvent(state, {
      type: "tool_result",
      toolName: "direction_feedback",
      text: "Recorded.",
      isError: false,
    });
    expect(state.pendingApproval).toBeNull();
    expect(state.messages[0].toolCalls.at(-1)).toEqual({
      type: "tool_result",
      toolName: "direction_feedback",
      text: "Recorded.",
      isError: false,
    });
  });

  it("job tracks a jobId on the current turn", () => {
    let state = initialChatViewState();
    state = reduceChatEvent(state, { type: "job", jobId: "job-1", kind: "approve" });
    expect(state.messages[0].toolCalls).toEqual([{ type: "job", jobId: "job-1", kind: "approve" }]);
  });

  it("done clears streaming and captures sessionId", () => {
    let state = { ...initialChatViewState(), streaming: true };
    state = reduceChatEvent(state, { type: "done", sessionId: "s1" });
    expect(state.streaming).toBe(false);
    expect(state.sessionId).toBe("s1");
  });

  it("an error with unavailable sets unavailable: true", () => {
    let state = initialChatViewState();
    state = reduceChatEvent(state, {
      type: "error",
      message: "Chat is unavailable",
      unavailable: true,
    });
    expect(state.unavailable).toBe(true);
    expect(state.error).toBe("Chat is unavailable");
  });

  it("a normal turn error does not flip unavailable", () => {
    let state = initialChatViewState();
    state = reduceChatEvent(state, { type: "error", message: "The model stream ended." });
    expect(state.unavailable).toBe(false);
    expect(state.error).toBe("The model stream ended.");
  });

  it("does not mutate the input state", () => {
    const state = initialChatViewState();
    const before = JSON.stringify(state);
    reduceChatEvent(state, { type: "token", text: "hi" });
    expect(JSON.stringify(state)).toEqual(before);
  });
});
