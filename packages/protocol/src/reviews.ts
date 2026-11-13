// What the server and the window both work out about a task's reviews.

import type { Finding, Review, Thread } from "./domain";

/** How many findings each axis has, in the order the reviewer reported the axes. */
export function findingCounts(review: Review): { group: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const finding of review.findings) {
    counts.set(finding.group, (counts.get(finding.group) ?? 0) + 1);
  }
  return [...counts].map(([group, count]) => ({ group, count }));
}

/** Findings the task's agent disputed that wait for the person's call. */
export function disputesWaiting(review: Review): Finding[] {
  return review.findings.filter(
    (finding) => finding.answer?.outcome === "disputed" && !finding.decision,
  );
}

/** Each task's latest review, by the task's id. */
export function latestReviews(threads: Iterable<Thread>): Map<string, Thread> {
  const latest = new Map<string, Thread>();
  for (const thread of threads) {
    if (thread.kind !== "review" || !thread.parentId) continue;
    const current = latest.get(thread.parentId);
    if (!current || thread.createdAt > current.createdAt) latest.set(thread.parentId, thread);
  }
  return latest;
}
