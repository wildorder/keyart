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
 * gallery stage lands in the composer as a contextual attachment. Crop intent
 * comes from the user's message; a picked color retains its explicit Lock action.
 */
import React, { useEffect, useRef, useState } from "react";
import type { DashboardDirection, DashboardGlobal, VisualFocus } from "../types";
import { sourceFields } from "../board-view.js";
import { renderScopeChip, resolveInheritedScope } from "../chat-affordances.js";
import { buildChatTurnContext } from "../chat-context.js";
import {
  chatResumeRequest,
  chatSendRequest,
  elementFeedbackRequest,
} from "../direction-actions.js";
import { useChat, useElementFeedback } from "../hooks";
import { usePendingCapture, type PendingCapture } from "../pending-capture.js";
import { formatCropSize } from "../stage-capture.js";
import { useToasts } from "./Toasts";
import { ChatMessage } from "./ChatMessage";

export function ChatRail({
  directionId,
  direction,
  focusedVersionId,
  focusedSource,
  pointer,
  reload,
}: {
  /** The focused direction — REQUIRED (never nullable, never optional). */
  directionId: string;
  direction: DashboardDirection;
  /** The VIEWED version, lifted from the segmented version switcher. */
  focusedVersionId: string | null;
  focusedSource?: VisualFocus | null;
  pointer: DashboardGlobal["approvedPointer"];
  reload: () => void;
}) {
  const { pushToast } = useToasts();
  const chat = useChat();
  const [text, setText] = useState("");
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
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

  const disabled = preparing || chat.streaming || chat.pendingApproval !== null;

  // A capture belongs to the direction and version it was taken on, so the
  // composer's inherited scope never overrides it. The typed text is the note.
  const captureFields = (target: PendingCapture): Record<string, string> & { directionId: string } => {
    const trimmed = text.trim();
    return {
      ...sourceFields(target.source),
      ...(trimmed ? { note: trimmed } : {}),
    };
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

  /** A color can still be locked explicitly without a model call. */
  const keepCapture = (): void => {
    if (capture?.capture.kind === "color") {
      const req = elementFeedbackRequest({
        verb: "keep",
        hex: capture.capture.hex,
        ...captureFields(capture),
      });
      void recordCapture({ blob: null, fields: req.form! }, "Color locked — saved to memory.");
    }
  };

  const send = async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || disabled || preparingRef.current) return;
    preparingRef.current = true;
    setPreparing(true);
    try {
      const crop = capture?.capture.kind === "crop" ? capture : null;
      const cropBlob = capture?.capture.kind === "crop" ? capture.capture.blob : undefined;
      const attachment = crop && crop.capture.kind === "crop" ? {
        source: crop.source,
        dataUrl: await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(new Error("Could not read the crop. Please try again."));
          reader.readAsDataURL(cropBlob!);
        }),
      } : undefined;
      const source = crop?.source ?? focusedSource;
      chat.send(
        chatSendRequest({
          message: trimmed,
          context: buildChatTurnContext(source?.directionId ?? directionId, source?.versionId ?? scope.versionId,
            source?.kind === "board" ? { boardId: source.boardId, ...(source.revisionId ? { revisionId: source.revisionId } : {}) } : undefined),
          ...(attachment ? { attachment } : {}),
        }),
      );
      setText("");
      if (crop) clearCapture();
    } catch (error) {
      pushToast({ kind: "error", message: error instanceof Error ? error.message : "Could not attach crop." });
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  };

  // Resume the single suspended mutating call — each control BUILDS its resume
  // request via the pure builder (approve/deny are the same route, opposite
  // boolean) and hands the bytes to the chat transport.
  const approveCall = (): void => {
    const sessionId = chat.pendingApproval?.sessionId;
    if (!sessionId) return;
    chat.approve(chatResumeRequest(sessionId, true));
  };
  const denyCall = (): void => {
    const sessionId = chat.pendingApproval?.sessionId;
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
          <span className="chat-scope-chip">{focusedSource?.kind === "board"
            ? `${direction.name} · Board ${focusedSource.boardId} · ${focusedSource.revisionId ?? "no render"} · foundation ${focusedSource.versionId}`
            : renderScopeChip(scope)}</span>
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
                ? "What would you like to do with this?"
                : "Why lock this color? (optional)"
              : "Make the CTA warmer…"
          }
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="chat-composer__send-row">
          {capture?.capture.kind === "color" && (
            <div className="chat-quick-intents">
              <button
                type="button"
                className="btn btn-sm"
                disabled={submitting}
                title="Record this as a keep — no model call"
                onClick={keepCapture}
              >
                Lock
              </button>
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
