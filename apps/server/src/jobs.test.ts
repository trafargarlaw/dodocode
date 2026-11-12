import { expect, test } from "vitest";
import type { BackgroundJob } from "@dodocode/protocol";
import { endJob, savedJobs, startJob } from "./jobs";

const command: BackgroundJob = {
  id: "t1",
  kind: "command",
  title: "Run the dev server",
  status: "running",
  toolItemId: "tool-1",
  startedAt: 1000,
};

test("ending a job keeps what it was, and work that never went to the background stays out", () => {
  const jobs = startJob([], command);

  expect(endJob(jobs, "t1", { status: "completed", summary: "Server stopped" }, 61_000)).toEqual([
    { ...command, status: "completed", endedAt: 61_000, summary: "Server stopped" },
  ]);
  expect(endJob(jobs, "t2", { status: "completed", summary: "Took a screenshot" }, 61_000)).toBe(
    jobs,
  );
});

test("a thread keeps its running jobs and the last 20 that finished", () => {
  const finished = Array.from({ length: 21 }, (_, i) => ({
    ...command,
    id: `done-${i}`,
    status: "completed" as const,
    endedAt: 2000,
  }));
  const jobs = startJob([command, ...finished.slice(0, 20)], finished[20]!);

  expect(jobs.map((job) => job.id)).toEqual(["t1", ...finished.slice(1).map((job) => job.id)]);
});

test("saved jobs lose the work earlier versions wrongly kept as finished background work", () => {
  const ended = { ...command, id: "t3", status: "completed" as const, endedAt: 5000 };
  const foreground: BackgroundJob = {
    id: "t4",
    kind: "other",
    title: "Screenshot the mockup",
    status: "completed",
    startedAt: 7000,
    endedAt: 7000,
    summary: "Screenshot the mockup",
  };
  const stoppedCommand: BackgroundJob = {
    ...foreground,
    id: "t5",
    title: "Launch the app",
    status: "stopped",
    toolItemId: "tool-5",
    summary: "Launch the app",
  };

  expect(savedJobs([command, ended, foreground, stoppedCommand])).toEqual([command, ended]);
});
