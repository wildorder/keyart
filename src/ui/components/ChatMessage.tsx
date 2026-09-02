/**
 * Renders one chat turn: a `user` bubble (plain text — never markdown) or an
 * `assistant` bubble that fills token-by-token as the hook's reducer folds
 * `token` events and `Markdown`-renders the sealed text, plus the turn's
 * tool-call cards. Pure presentational — the token accumulation lives in
 * `reduceChatEvent` (`chat-stream.ts`); this component renders what the hook
 * already accumulated.
 */
import React from "react";
import type { ChatTurn } from "../types";
import { Markdown } from "./Markdown";
import { ToolCallCard } from "./ToolCallCard";

export function ChatMessage({
  turn,
  onApprove,
  onDeny,
  submitting,
  reload,
}: {
  turn: ChatTurn;
  onApprove: () => void;
  onDeny: () => void;
  submitting: boolean;
  reload: () => void;
}) {
  if (turn.role === "user") {
    return (
      <div className="chat-message chat-message--user">
        <div className="chat-message__body">{turn.content}</div>
      </div>
    );
  }

  return (
    <div className="chat-message chat-message--assistant">
      {turn.content && (
        <div className="chat-message__body">
          <Markdown>{turn.content}</Markdown>
        </div>
      )}
      {turn.toolCalls.length > 0 && (
        <div className="chat-message__tool-calls">
          {turn.toolCalls.map((ev, i) => (
            <ToolCallCard
              key={i}
              ev={ev}
              onApprove={onApprove}
              onDeny={onDeny}
              submitting={submitting}
              reload={reload}
            />
          ))}
        </div>
      )}
    </div>
  );
}
