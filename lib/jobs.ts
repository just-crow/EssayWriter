import { supabase } from "@/lib/db";

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

const memoryJobs = new Map<string, Job>();
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

export async function createJob(kind: string, maxAttempts: number): Promise<JobSnapshot> {
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
  memoryJobs.set(id, job);
  if (memoryJobs.size > MAX_STORED) {
    const oldest = [...memoryJobs.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (oldest) memoryJobs.delete(oldest.id);
  }

  try {
    await supabase.from("Job").insert({
      id,
      kind,
      status: "queued",
      attempt: 0,
      maxAttempts,
      stage: "",
      startedAt: now,
      updatedAt: now,
      result: null,
      error: "",
    });
  } catch {
    // fallback
  }

  return snap(job);
}

export async function getJob(id: string): Promise<JobSnapshot | null> {
  const mem = memoryJobs.get(id);

  try {
    const { data, error } = await supabase.from("Job").select("*").eq("id", id).maybeSingle();
    if (!error && data) {
      const now = Date.now();
      const updatedJob: Job = {
        id: String(data.id),
        kind: String(data.kind ?? ""),
        status: (data.status as JobStatus) || "queued",
        attempt: Number(data.attempt ?? 0),
        maxAttempts: Number(data.maxAttempts ?? 1),
        stage: String(data.stage ?? ""),
        startedAt: Number(data.startedAt ?? now),
        updatedAt: Number(data.updatedAt ?? now),
        result: data.result,
        error: String(data.error ?? ""),
      };
      memoryJobs.set(id, updatedJob);
      return snap(updatedJob);
    }
  } catch {
    // fallback
  }

  return mem ? snap(mem) : null;
}

/** Progress reporter handed to background work. */
export interface JobReporter {
  attempt(n: number): void;
  stage(s: string): void;
}

/** Run fn in the background, tracking attempts and stages. Never throws. */
export function runJob<T>(id: string, fn: (r: JobReporter) => Promise<T>): void {
  const job = memoryJobs.get(id) || {
    id,
    kind: "sources",
    status: "running" as JobStatus,
    attempt: 0,
    maxAttempts: 1,
    stage: "",
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  job.status = "running";
  job.updatedAt = Date.now();
  memoryJobs.set(id, job);

  void supabase.from("Job").update({ status: "running", updatedAt: Date.now() }).eq("id", id);

  const reporter: JobReporter = {
    attempt(n: number) {
      const j = memoryJobs.get(id) || job;
      j.attempt = n;
      j.updatedAt = Date.now();
      j.onAttempt?.(n, j.maxAttempts);
      void supabase.from("Job").update({ attempt: n, updatedAt: Date.now() }).eq("id", id);
    },
    stage(s: string) {
      const j = memoryJobs.get(id) || job;
      j.stage = s;
      j.updatedAt = Date.now();
      void supabase.from("Job").update({ stage: s, updatedAt: Date.now() }).eq("id", id);
    },
  };

  void (async () => {
    try {
      const result = await fn(reporter);
      const done = memoryJobs.get(id) || job;
      done.status = "done";
      done.result = result;
      done.updatedAt = Date.now();
      await supabase
        .from("Job")
        .update({ status: "done", result, updatedAt: Date.now() })
        .eq("id", id);
    } catch (err) {
      const failed = memoryJobs.get(id) || job;
      const errorMsg = err instanceof Error ? err.message : "Job failed.";
      failed.status = "error";
      failed.error = errorMsg;
      failed.updatedAt = Date.now();
      await supabase
        .from("Job")
        .update({ status: "error", error: errorMsg, updatedAt: Date.now() })
        .eq("id", id);
    }
  })();
}
