import { describe, it, expect } from "vitest";
import { appendUserTurn, decideChatApproval, groupChatActions, initialChatViewState, parseSseFrames, reduceChatEvent } from "./chat-stream.js";
import type { ChatCardEvent, ChatEvent } from "./types.js";

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
  it("keeps the crop on its user turn after the composer clears", () => {
    const attachment = { dataUrl: "data:image/png;base64,crop", source: { kind: "foundation" as const, directionId: "bold", versionId: "v8" } };
    const state = appendUserTurn(initialChatViewState(), "Extract this", attachment);
    expect(state.messages[0].attachment).toEqual(attachment);
  });
  it.each([true, false])("consumes approval once and keeps history resolved after completion (approve=%s)", (approved) => {
    const pending: ChatEvent = { type: "pending_approval", sessionId: "s1", toolName: "asset_extract", arguments: { version: "v8" }, mutates: "write" };
    const original = reduceChatEvent(initialChatViewState(), pending);
    let state = decideChatApproval(original, approved);
    expect(original.pendingApproval).toBe(pending);
    expect(original.messages[0].toolCalls[0]).toBe(pending);
    expect(state.pendingApproval).toBeNull();
    expect(state.messages[0].toolCalls[0]).toMatchObject({ type: "approval_decision", approved, arguments: { version: "v8" } });
    expect(decideChatApproval(state, !approved)).toBe(state);
    if (approved) state = reduceChatEvent(state, { type: "job", jobId: "job-1", kind: "asset" });
    state = reduceChatEvent(state, { type: "tool_result", toolName: "asset_extract", text: approved ? "Launched." : "Declined.", isError: false });
    state = reduceChatEvent(state, { type: "done", sessionId: "s1" });
    expect(state.streaming).toBe(false);
    expect(state.messages.flatMap((turn) => turn.toolCalls).filter((event) => event.type === "pending_approval")).toEqual([]);
    // Even a subsequent request for the same tool gets its own gate, never revives the old one.
    state = reduceChatEvent(state, { ...pending });
    expect(state.messages[0].toolCalls[0].type).toBe("approval_decision");
    expect(state.messages[0].toolCalls.filter((event) => event.type === "pending_approval")).toHaveLength(1);
  });
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
    let state = { ...initialChatViewState(), streaming: true };
    state = reduceChatEvent(state, { type: "error", message: "The model stream ended." });
    expect(state.unavailable).toBe(false);
    expect(state.streaming).toBe(false);
    expect(state.error).toBe("The model stream ended.");
  });

  it("does not mutate the input state", () => {
    const state = initialChatViewState();
    const before = JSON.stringify(state);
    reduceChatEvent(state, { type: "token", text: "hi" });
    expect(JSON.stringify(state)).toEqual(before);
  });
});

describe("groupChatActions", () => {
  it("matches interleaved same-tool lifecycles by call id, not tool name", () => {
    const events: ChatCardEvent[] = [
      { type: "tool_call", callId: "first", toolName: "asset_extract", arguments: {} },
      { type: "tool_call", callId: "second", toolName: "asset_extract", arguments: {} },
      { type: "approval_decision", callId: "first", toolName: "asset_extract", arguments: {}, approved: true },
      { type: "job", callId: "first", toolName: "asset_extract", jobId: "j1", kind: "asset" },
      { type: "pending_approval", callId: "second", sessionId: "s", toolName: "asset_extract", arguments: {}, mutates: "write" },
      { type: "tool_result", callId: "first", toolName: "asset_extract", text: "Launched j1.", isError: false },
    ];
    const actions = groupChatActions(events);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ key: "first", approved: true, event: { type: "job", jobId: "j1" } });
    expect(actions[1]).toMatchObject({ key: "second", event: { type: "pending_approval" } });
  });
  it("projects one evolving card through call, approval, job and launch receipt", () => {
    const events: ChatCardEvent[] = [
      { type: "tool_call", toolName: "asset_extract", arguments: {} },
      { type: "approval_decision", toolName: "asset_extract", arguments: { version: "v8" }, approved: true },
      { type: "job", jobId: "j1", kind: "asset" },
      { type: "tool_result", toolName: "asset_extract", text: "Launched asset as job j1.", isError: false },
    ];
    const original = JSON.stringify(events);
    expect(groupChatActions(events)).toEqual([{
      key: "action-0", toolName: "asset_extract", approved: true,
      job: events[2], event: events[2],
    }]);
    expect(JSON.stringify(events)).toBe(original);
  });

  it("does not merge a second call to the same tool", () => {
    const events: ChatCardEvent[] = [
      { type: "tool_call", toolName: "asset_extract", arguments: { name: "first" } },
      { type: "tool_result", toolName: "asset_extract", text: "Done.", isError: false },
      { type: "tool_call", toolName: "asset_extract", arguments: { name: "second" } },
      { type: "pending_approval", sessionId: "s", toolName: "asset_extract", arguments: { name: "second" }, mutates: "write" },
    ];
    const actions = groupChatActions(events);
    expect(actions).toHaveLength(2);
    expect(actions[0].event.type).toBe("tool_result");
    expect(actions[1].event.type).toBe("pending_approval");
  });

  it("preserves cancellation and surfaces dispatch failures", () => {
    const denied: ChatCardEvent = { type: "approval_decision", toolName: "asset_extract", arguments: {}, approved: false };
    const receipt: ChatCardEvent = { type: "tool_result", toolName: "asset_extract", text: "Declined.", isError: false };
    expect(groupChatActions([denied, receipt])[0].event).toBe(denied);
    const failed = { ...receipt, text: "Could not launch.", isError: true };
    expect(groupChatActions([denied, failed])[0].event).toBe(failed);
  });
});
