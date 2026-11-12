// The work an agent left running in the background, as a thread keeps it: what starts a job, what
// ends one, and how many finished ones it keeps. Each rule takes the list and gives back the
// changed copy.

import type { BackgroundJob } from "@dodocode/protocol";

/** How many finished jobs a thread keeps, besides the running ones. */
const KEEP_FINISHED = 20;

export type JobEnd = Pick<BackgroundJob, "status" | "summary">;

/** Starts a job, or starts it again with what is known now. */
export function startJob(jobs: BackgroundJob[], job: BackgroundJob): BackgroundJob[] {
  const index = jobs.findIndex((entry) => entry.id === job.id);
  const next =
    index === -1
      ? [...jobs, job]
      : jobs.map((entry, i) => (i === index ? { ...entry, ...job } : entry));
  return trimmed(next);
}

/**
 * Ends a job, keeping what it was and when it started. Work that never went to the background
 * ends too, but was never a job, so the list stays as it was.
 */
export function endJob(
  jobs: BackgroundJob[],
  id: string,
  end: JobEnd,
  now: number,
): BackgroundJob[] {
  const job = jobs.find((entry) => entry.id === id);
  if (!job) return jobs;
  const ended: BackgroundJob = { ...job, status: end.status, endedAt: now };
  if (end.summary) ended.summary = end.summary;
  return trimmed(jobs.map((entry) => (entry === job ? ended : entry)));
}

/**
 * The jobs a thread saved. Earlier versions also saved, as finished jobs, work that never went
 * to the background: they made the job only when the work ended, so it ended when it started.
 */
export function savedJobs(jobs: BackgroundJob[]): BackgroundJob[] {
  return jobs.filter((job) => job.endedAt !== job.startedAt);
}

/** Keeps the running jobs and the last few that finished. */
function trimmed(jobs: BackgroundJob[]): BackgroundJob[] {
  const finished = jobs.filter((job) => job.status !== "running");
  if (finished.length <= KEEP_FINISHED) return jobs;
  const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((job) => job.id));
  return jobs.filter((job) => !drop.has(job.id));
}
