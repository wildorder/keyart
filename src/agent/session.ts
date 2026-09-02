import { randomUUID } from "node:crypto";
import type { ChatContext, ChatMessage, PendingApproval } from "./model.js";

export interface ChatSession {
  id: string;
  context: ChatContext; // { directionId, versionId? } — the focused studio direction this session inherited
  messages: ChatMessage[]; // mutated in place by the loop; the system message is regenerated per turn (NOT stored)
  pending?: PendingApproval; // the single suspended mutating call, if any
  createdAt: string; // ISO
}

export interface SessionStore {
  create(context: ChatContext): ChatSession; // mints an id (randomUUID), stores + returns the LIVE object
  get(id: string): ChatSession | undefined; // the LIVE object (the loop mutates it; WS-03 reads it back)
}

/** Keep at most this many sessions so a long-lived dev server can't grow unbounded. */
const MAX_SESSIONS = 200;

/**
 * In-memory `SessionStore` — mirrors `src/ui/jobs.ts`'s `createJobStore()`
 * factory idiom over a private `Map`. UNLIKE `JobStore`, `create`/`get`
 * return the LIVE session object (not a defensive snapshot): the loop
 * mutates `session.messages`/`session.pending` in place and callers must see
 * those mutations on the next `get`. NOT persisted — no `fs`, no `yaml`, no
 * schema, no migration; process-local exactly like `JobStore`.
 */
export function createSessionStore(): SessionStore {
  const sessions = new Map<string, ChatSession>();

  /** Evicts the oldest sessions once more than {@link MAX_SESSIONS} are retained. */
  function prune(): void {
    const excess = sessions.size - MAX_SESSIONS;
    if (excess <= 0) return;
    const oldestIds = [...sessions.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, excess)
      .map((s) => s.id);
    for (const id of oldestIds) sessions.delete(id);
  }

  return {
    create(context: ChatContext): ChatSession {
      const session: ChatSession = {
        id: randomUUID(),
        context,
        messages: [],
        createdAt: new Date().toISOString(),
      };
      sessions.set(session.id, session);
      prune();
      return session;
    },

    get(id: string): ChatSession | undefined {
      return sessions.get(id);
    },
  };
}
