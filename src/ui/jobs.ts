import { randomUUID } from "node:crypto";

/**
 * In-process job tracker for the long-running dashboard actions
 * (`explore` / `approve` / `audit` / `regenerate` / `asset` / `surface`). A job
 * wraps the promise of one command function: {@link JobStore.start} returns
 * immediately with a `running` job and later transitions the stored copy to
 * `succeeded` (with `result`) or `failed` (with `error`). The store is
 * process-local — a job started by one request is pollable by later requests
 * for the life of the server.
 */

export type JobKind =
  | "explore"
  | "approve"
  | "audit"
  | "regenerate"
  | "asset"
  | "surface";
export type JobStatus = "running" | "succeeded" | "failed";

export interface Job {
  id: string; // crypto.randomUUID()
  kind: JobKind;
  status: JobStatus;
  startedAt: string; // ISO
  finishedAt?: string; // ISO, set on completion
  result?: unknown; // the command result on success
  error?: string; // message on failure
}

export interface JobStore {
  /** Starts `fn` in the background and returns immediately with a `running` job. */
  start<T>(kind: JobKind, fn: () => Promise<T>): Job;
  get(id: string): Job | undefined;
  list(): Job[];
}

/** Keep at most this many finished jobs so a long-lived dev server can't grow unbounded. */
const MAX_FINISHED = 50;

/** A defensive copy so callers can never mutate the store's internal state. */
function snapshot(job: Job): Job {
  return { ...job };
}

export function createJobStore(): JobStore {
  const jobs = new Map<string, Job>();

  /** Evicts the oldest finished jobs once more than {@link MAX_FINISHED} are retained. */
  function prune(): void {
    const finished = [...jobs.values()].filter((j) => j.status !== "running");
    const excess = finished.length - MAX_FINISHED;
    for (let i = 0; i < excess; i++) {
      jobs.delete(finished[i].id);
    }
  }

  return {
    start<T>(kind: JobKind, fn: () => Promise<T>): Job {
      const job: Job = {
        id: randomUUID(),
        kind,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      jobs.set(job.id, job);

      // Fire without awaiting; capture terminal state into the stored job. The
      // `.catch` guarantees a rejection never becomes an unhandled rejection.
      void Promise.resolve()
        .then(fn)
        .then(
          (result) => {
            job.status = "succeeded";
            job.result = result;
            job.finishedAt = new Date().toISOString();
            prune();
          },
          (err: unknown) => {
            job.status = "failed";
            job.error = err instanceof Error ? err.message : String(err);
            job.finishedAt = new Date().toISOString();
            prune();
          },
        );

      return snapshot(job);
    },

    get(id: string): Job | undefined {
      const job = jobs.get(id);
      return job === undefined ? undefined : snapshot(job);
    },

    list(): Job[] {
      return [...jobs.values()].map(snapshot);
    },
  };
}
