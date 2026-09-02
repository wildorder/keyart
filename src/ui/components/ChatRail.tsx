/**
 * The chat rail — the single rail beside the focused direction in
 * `DirectionWorkspace` (its ONLY mount in the studio), and the primary surface
 * for recalling and recording direction memory (the agent's memory/feedback
 * verbs; the DirectionChrome Memory drawer remains the full review surface).
 * The direction is REQUIRED — `directionId` is non-nullable, so an
 * empty-context turn is not representable studio-side (SC-10). Reads the
 * studio's focus (direction + viewed version), renders the inherited-scope
 * chip so the user sees what a context-free message resolves to, streams the
 * turn live, and renders each tool call with its approve/deny affordance.
 * Keyless renders only the explicit unavailable notice — never a broken
 * composer (SC-09).
 */
import React, { useEffect, useRef, useState } from "react";
import type { DashboardDirection, DashboardGlobal } from "../types";
import { renderScopeChip, resolveInheritedScope } from "../chat-affordances.js";
import { buildChatTurnContext } from "../chat-context.js";
import { chatResumeRequest, chatSendRequest } from "../direction-actions.js";
import { useChat } from "../hooks";
import { useToasts } from "./Toasts";
import { ChatMessage } from "./ChatMessage";

export function ChatRail({
  directionId,
  direction,
  focusedVersionId,
  pointer,
  reload,
}: {
  /** The focused direction — REQUIRED (never nullable, never optional). */
  directionId: string;
  direction: DashboardDirection;
  /** The VIEWED version, lifted from the segmented version switcher. */
  focusedVersionId: string | null;
  pointer: DashboardGlobal["approvedPointer"];
  reload: () => void;
}) {
  const { pushToast } = useToasts();
  const chat = useChat();
  const [text, setText] = useState("");
  const lastToastedError = useRef<string | null>(null);

  const scope = resolveInheritedScope(direction, focusedVersionId, pointer);

  useEffect(() => {
    if (chat.error && !chat.unavailable && chat.error !== lastToastedError.current) {
      lastToastedError.current = chat.error;
      pushToast({ kind: "error", message: chat.error });
    }
  }, [chat.error, chat.unavailable, pushToast]);

  if (chat.unavailable) {
    return (
      <div className="chat-rail">
        <div className="chat-rail__header">
          <span className="chat-rail__title">Chat</span>
        </div>
        <p className="chat-unavailable">
          Chat needs an OpenAI API key. Set <code>OPENAI_API_KEY</code> and restart{" "}
          <code>serve</code> to enable chat.
        </p>
      </div>
    );
  }

  const disabled = chat.streaming || chat.pendingApproval !== null;

  const send = (): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || disabled) return;
    // The sent context matches the chip the user sees: the required
    // directionId prop + the RESOLVED inherited version (omitted for a draft).
    chat.send(
      chatSendRequest({
        message: trimmed,
        context: buildChatTurnContext(directionId, scope.versionId),
      }),
    );
    setText("");
  };

  // Resume the single suspended mutating call — each control BUILDS its resume
  // request via the pure builder (approve/deny are the same route, opposite
  // boolean) and hands the bytes to the chat transport.
  const approveCall = (): void => {
    const sessionId = chat.pendingApproval?.sessionId ?? chat.sessionId;
    if (!sessionId) return;
    chat.approve(chatResumeRequest(sessionId, true));
  };
  const denyCall = (): void => {
    const sessionId = chat.pendingApproval?.sessionId ?? chat.sessionId;
    if (!sessionId) return;
    chat.approve(chatResumeRequest(sessionId, false));
  };

  return (
    <div className="chat-rail">
      <div className="chat-rail__header">
        <span className="chat-rail__title">Chat</span>
      </div>
      <div className="chat-rail__body">
        {chat.messages.map((turn, i) => (
          <ChatMessage
            key={i}
            turn={turn}
            onApprove={approveCall}
            onDeny={denyCall}
            submitting={chat.streaming}
            reload={reload}
          />
        ))}
      </div>
      <div className="chat-composer">
        <span className="chat-scope-chip">{renderScopeChip(scope)}</span>
        <textarea
          className="chat-composer__input textarea"
          value={text}
          placeholder="Make the CTA warmer…"
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary chat-composer__send"
          disabled={disabled || text.trim().length === 0}
          onClick={send}
        >
          {chat.streaming ? "Sending…" : "Send"}
        </button>
      </div>
    </div>
  );
}
