/**
 * Pure, JSX-free builder for the chat turn's `context` payload — the
 * studio-side twin of SC-10's transport contract. `directionId` is REQUIRED
 * and always present; `versionId` is present ONLY when a concrete version
 * resolves, and is otherwise OMITTED entirely (never `versionId: undefined`,
 * never `null`). `ChatRail` consumes this to build the turn's context before
 * `chatSendRequest`. No I/O.
 */
export function buildChatTurnContext(
  directionId: string,
  versionId?: string | null,
): { directionId: string; versionId?: string } {
  if (typeof versionId === "string" && versionId.length > 0) {
    return { directionId, versionId };
  }
  return { directionId };
}
