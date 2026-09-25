/**
 * Minimal in-process job store for long model stages.
 * POST /api/sources returns a jobId in milliseconds; the client polls
 * GET /api/jobs/[id] for attempt/elapsed/result. Local-only single process,
 * so an in-memory Map is sufficient (jobs vanish on server restart).
 */

export type JobStatus = "queued" | "running" | "done" | "error";

export interface JobSnapshot {
  id: string;
  kind: string;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  /** Human-readable current phase, e.g. "Searching the web…". */
  stage: string;
  startedAt: number;
  updatedAt: number;
  /** Seconds since start, for "proof of life" display. */
  elapsedSec: number;
  result?: unknown;
  error?: string;
}

interface Job extends Omit<JobSnapshot, "elapsedSec"> {
  onAttempt?: (attempt: number, maxAttempts: number) => void;
}

const jobs = new Map<string, Job>();
const MAX_STORED = 100;

function snap(j: Job): JobSnapshot {
  const now = Date.now();
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    attempt: j.attempt,
    maxAttempts: j.maxAttempts,
    stage: j.stage,
    startedAt: j.startedAt,
    updatedAt: now,
    elapsedSec: Math.round((now - j.startedAt) / 1000),
    result: j.result,
    error: j.error,
  };
}

export function createJob(kind: string, maxAttempts: number): JobSnapshot {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  const job: Job = {
    id,
    kind,
    status: "queued",
    attempt: 0,
    maxAttempts,
    stage: "",
    startedAt: now,
    updatedAt: now,
  };
  jobs.set(id, job);
  if (jobs.size > MAX_STORED) {
    const oldest = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) jobs.delete(oldest.id);
  }
  return snap(job);
}

export function getJob(id: string): JobSnapshot | null {
  const j = jobs.get(id);
  return j ? snap(j) : null;
}

/** Progress reporter handed to background work. */
export interface JobReporter {
  attempt(n: number): void;
  stage(s: string): void;
}

/** Run fn in the background, tracking attempts and stages. Never throws. */
export function runJob<T>(id: string, fn: (r: JobReporter) => Promise<T>): void {
  const job = jobs.get(id);
  if (!job) return;
  job.status = "running";
  job.updatedAt = Date.now();
  const reporter: JobReporter = {
    attempt(n: number) {
      const j = jobs.get(id);
      if (j) {
        j.attempt = n;
        j.updatedAt = Date.now();
        j.onAttempt?.(n, j.maxAttempts);
      }
    },
    stage(s: string) {
      const j = jobs.get(id);
      if (j) {
        j.stage = s;
        j.updatedAt = Date.now();
      }
    },
  };
  void (async () => {
    try {
      const result = await fn(reporter);
      const done = jobs.get(id);
      if (done) {
        done.status = "done";
        done.result = result;
        done.updatedAt = Date.now();
      }
    } catch (err) {
      const failed = jobs.get(id);
      if (failed) {
        failed.status = "error";
        failed.error = err instanceof Error ? err.message : "Job failed.";
        failed.updatedAt = Date.now();
      }
    }
  })();
}
