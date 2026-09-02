import { describe, it, expect } from "vitest";
import { createSessionStore } from "./session.js";
import type { PendingApproval } from "./model.js";

describe("createSessionStore", () => {
  it("create + live retrieval — mutations are visible on the next get", () => {
    const store = createSessionStore();
    const session = store.create({ directionId: "moody" });

    expect(session.id).toBeTruthy();
    expect(session.context).toEqual({ directionId: "moody" });
    expect(session.messages).toEqual([]);
    expect(session.pending).toBeUndefined();

    session.messages.push({ role: "user", content: "hi" });

    const fetched = store.get(session.id);
    expect(fetched).toBe(session); // the SAME live object
    expect(fetched?.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("pending set + clear round-trips", () => {
    const store = createSessionStore();
    const session = store.create({ directionId: "moody" });

    const pending: PendingApproval = {
      sessionId: session.id,
      call: { id: "call_1", toolName: "direction_feedback", arguments: { id: "moody" } },
      leaf: {
        toolName: "direction_feedback",
        command: "direction",
        verb: "feedback",
        description: "desc",
        positionals: [],
        flags: [],
        mutates: "write",
        contextBinding: {},
      },
      tokens: ["feedback", "moody"],
    };

    session.pending = pending;
    expect(store.get(session.id)?.pending).toEqual(pending);

    session.pending = undefined;
    expect(store.get(session.id)?.pending).toBeUndefined();
  });

  it("per-session isolation + not persisted", () => {
    const store = createSessionStore();
    const a = store.create({ directionId: "direction-a" });
    const b = store.create({ directionId: "direction-b" });

    a.messages.push({ role: "user", content: "for a only" });

    expect(store.get(a.id)?.messages).toHaveLength(1);
    expect(store.get(b.id)?.messages).toHaveLength(0);
    expect(a.id).not.toBe(b.id);

    // Not persisted: a fresh store never sees a prior store's sessions.
    const freshStore = createSessionStore();
    expect(freshStore.get(a.id)).toBeUndefined();
  });

  it("get returns undefined for an unknown id", () => {
    const store = createSessionStore();
    expect(store.get("nonexistent")).toBeUndefined();
  });
});
