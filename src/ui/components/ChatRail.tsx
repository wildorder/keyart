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
 *
 * It is rendered into the shell's rail slot (see RailHost), so it is a
 * viewport-tall column beside the workspace. A crop or color taken on the
 * gallery stage lands in the composer as a chip with quick Keep / Discard (or
 * Lock for a color) that post straight to element feedback with the composer's
 * text as the note — no model in the loop, which is the escape hatch that keeps
 * routing free text through the agent safe.
 */
import React, { useEffect, useRef, useState } from "react";
import type { DashboardDirection, DashboardGlobal } from "../types";
import { renderScopeChip, resolveInheritedScope } from "../chat-affordances.js";
import { buildChatTurnContext } from "../chat-context.js";
import {
  chatResumeRequest,
  chatSendRequest,
  elementFeedbackRequest,
} from "../direction-actions.js";
import { useChat, useElementFeedback } from "../hooks";
import { usePendingCapture } from "../pending-capture.js";
import { formatCropSize } from "../stage-capture.js";
import { elementFeedbackTargetFields } from "./memory-select.js";
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

  // The capture taken on the gallery stage, resolved from here.
  const { pending: capture, clear: clearCapture } = usePendingCapture();
  const { submit, pending: submitting } = useElementFeedback();

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

  // A capture belongs to the direction and version it was taken on, so the
  // composer's inherited scope never overrides it. The typed text is the note.
  const captureFields = (): Record<string, string> => {
    const trimmed = text.trim();
    return capture
      ? {
          ...elementFeedbackTargetFields(capture.directionId, capture.versionId),
          ...(trimmed ? { note: trimmed } : {}),
        }
      : {};
  };

  const dropCapture = (): void => clearCapture();

  /** Post a resolved capture, then clear it and the composer. */
  const recordCapture = async (
    payload: Parameters<typeof submit>[0],
    message: string,
  ): Promise<void> => {
    if (submitting) return;
    if (!(await submit(payload))) {
      pushToast({ kind: "error", message: "Could not record that — try again." });
      return;
    }
    pushToast({ kind: "success", message });
    setText("");
    clearCapture();
    reload();
  };

  /** Keep a crop (as an inspire reference) or lock a picked color. */
  const keepCapture = (): void => {
    if (!capture) return;
    if (capture.capture.kind === "crop") {
      const req = elementFeedbackRequest({ verb: "keep", intent: "inspire", ...captureFields() });
      void recordCapture(
        { blob: capture.capture.blob, filename: "crop.png", fields: req.form! },
        "Kept — saved to memory.",
      );
    } else {
      const req = elementFeedbackRequest({
        verb: "keep",
        hex: capture.capture.hex,
        ...captureFields(),
      });
      void recordCapture({ blob: null, fields: req.form! }, "Color locked — saved to memory.");
    }
  };

  /** Discard a crop, with the composer's text as the reason. */
  const discardCapture = (): void => {
    if (capture?.capture.kind !== "crop") return;
    const req = elementFeedbackRequest({ verb: "discard", ...captureFields() });
    void recordCapture(
      { blob: capture.capture.blob, filename: "discard.png", fields: req.form! },
      "Discarded — saved to memory.",
    );
  };

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
        <div className="chat-composer__context">
          <span className="chat-scope-chip">{renderScopeChip(scope)}</span>
          {capture && (
            <span className="chat-crop-chip">
              {capture.capture.kind === "crop" ? (
                <>
                  <img
                    className="chat-crop-chip__thumb"
                    src={capture.capture.previewUrl}
                    alt="Cropped region"
                  />
                  crop {formatCropSize(capture.capture.size)}
                </>
              ) : (
                <>
                  <span
                    className="chat-crop-chip__swatch"
                    style={{ backgroundColor: capture.capture.hex }}
                    aria-hidden="true"
                  />
                  {capture.capture.hex}
                </>
              )}
              <button
                type="button"
                className="chat-crop-chip__clear"
                aria-label="Drop this capture"
                onClick={dropCapture}
              >
                ✕
              </button>
            </span>
          )}
        </div>
        <textarea
          className="chat-composer__input textarea"
          value={text}
          placeholder={
            capture
              ? capture.capture.kind === "crop"
                ? "Why keep or discard this crop? (optional)"
                : "Why lock this color? (optional)"
              : "Make the CTA warmer…"
          }
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="chat-composer__send-row">
          {capture && (
            <div className="chat-quick-intents">
              <button
                type="button"
                className="btn btn-sm"
                disabled={submitting}
                title="Record this as a keep — no model call"
                onClick={keepCapture}
              >
                {capture.capture.kind === "crop" ? "Keep" : "Lock"}
              </button>
              {capture.capture.kind === "crop" && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={submitting}
                  title="Record this as a discard — no model call"
                  onClick={discardCapture}
                >
                  Discard
                </button>
              )}
            </div>
          )}
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
    </div>
  );
}
