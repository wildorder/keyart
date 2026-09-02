import { describe, it, expect } from "vitest";
import { createJobStore } from "./jobs.js";
import { CommandError } from "../errors.js";

/** Resolves once the given job leaves the `running` state (bounded spins). */
async function settle(
  store: ReturnType<typeof createJobStore>,
  id: string,
): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (store.get(id)?.status !== "running") return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`job ${id} never settled`);
}

describe("createJobStore", () => {
  it("start() returns a running job that settles to succeeded with the result", async () => {
    const store = createJobStore();
    const job = store.start("explore", async () => 42);

    expect(job.status).toBe("running");
    expect(job.kind).toBe("explore");
    expect(job.result).toBeUndefined();
    expect(job.finishedAt).toBeUndefined();

    await settle(store, job.id);

    const done = store.get(job.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result).toBe(42);
    expect(typeof done?.finishedAt).toBe("string");
    expect(done?.error).toBeUndefined();
  });

  it("captures a rejection as failed without an unhandled rejection", async () => {
    const store = createJobStore();
    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on("unhandledRejection", onRejection);

    const job = store.start("approve", async () => {
      throw new CommandError("boom");
    });
    await settle(store, job.id);
    // Give any stray unhandled rejection a tick to surface.
    await new Promise((r) => setImmediate(r));
    process.off("unhandledRejection", onRejection);

    const done = store.get(job.id);
    expect(done?.status).toBe("failed");
    expect(done?.error).toBe("boom");
    expect(done?.result).toBeUndefined();
    expect(typeof done?.finishedAt).toBe("string");
    expect(rejections).toHaveLength(0);
  });

  it("tracks a regenerate job: running → succeeded with the result", async () => {
    const store = createJobStore();
    const job = store.start("regenerate", async () => ({ directionId: "d1" }));

    expect(job.status).toBe("running");
    expect(job.kind).toBe("regenerate");

    await settle(store, job.id);

    const done = store.get(job.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result).toEqual({ directionId: "d1" });
    expect(done?.error).toBeUndefined();
  });

  it("captures a throwing regenerate job as failed without an unhandled rejection", async () => {
    const store = createJobStore();
    const rejections: unknown[] = [];
    const onRejection = (err: unknown): void => {
      rejections.push(err);
    };
    process.on("unhandledRejection", onRejection);

    const job = store.start("regenerate", async () => {
      throw new CommandError("regen boom");
    });
    await settle(store, job.id);
    await new Promise((r) => setImmediate(r));
    process.off("unhandledRejection", onRejection);

    const done = store.get(job.id);
    expect(done?.status).toBe("failed");
    expect(done?.error).toBe("regen boom");
    expect(rejections).toHaveLength(0);
  });

  it("keeps jobs isolated and returns undefined for an unknown id", async () => {
    const store = createJobStore();
    const a = store.start("explore", async () => "a");
    const b = store.start("audit", async () => {
      throw new Error("nope");
    });

    expect(a.id).not.toBe(b.id);
    await Promise.all([settle(store, a.id), settle(store, b.id)]);

    expect(store.get(a.id)?.status).toBe("succeeded");
    expect(store.get(b.id)?.status).toBe("failed");
    expect(store.get("missing")).toBeUndefined();
  });

  it("list() returns copies that cannot mutate stored state", () => {
    const store = createJobStore();
    const job = store.start("explore", async () => 1);

    const listed = store.list();
    expect(listed.map((j) => j.id)).toContain(job.id);

    // Mutating a returned copy must not leak into the store.
    listed[0].status = "failed";
    expect(store.get(job.id)?.status).toBe("running");
  });
});
