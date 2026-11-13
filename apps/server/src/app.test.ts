import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Thread } from "@dodocode/protocol";

import { testApp, type TestApp } from "./test-app";

let t: TestApp;

beforeEach(async () => {
  t = await testApp();
});

afterEach(async () => {
  await t.close();
});

/** Retries `check` until it passes. Git in a worktree can take a while, on Windows most. */
function eventually<T>(check: () => Promise<T>): Promise<T> {
  return vi.waitFor(check, { timeout: 5000, interval: 25 });
}

/** Waits until the agent's turn in a thread has ended. */
async function idle(threadId: string): Promise<Thread> {
  return await eventually(async () => {
    const thread = await t.thread(threadId);
    expect(thread.status).not.toBe("running");
    return thread;
  });
}

/** A task, in its own worktree, whose agent added a file and which waits in In review. */
async function taskInReview(): Promise<Thread> {
  const message = { text: "Add b.txt", images: [] };
  const task = await t.call("task.create", {
    projectId: t.project.id,
    message,
    workspace: "worktree",
  });
  t.agent.worker = (host) => writeFileSync(join(host.cwd, "b.txt"), "bee\n");
  await t.call("thread.send", { threadId: task.id, message });
  await idle(task.id);
  t.agent.worker = () => {};
  return await t.call("task.move", { threadId: task.id, status: "review" });
}

/**
 * Takes away a task's worktree and its branch, so its folder can't be made again and nothing
 * can be sent to it. Gives back what mends it.
 */
function breakWorktree(task: Thread): () => void {
  const { path, branch } = task.worktree!;
  // On Windows, git run in the folder a moment ago can still hold it.
  rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  t.git("worktree", "prune");
  t.git("branch", "-D", branch);
  return () => t.git("branch", branch, "main");
}

describe("reviews", { timeout: 30_000 }, () => {
  test("findings that couldn't go to the task wait, and go when the reviewer's next turn ends", async () => {
    const task = await taskInReview();
    let mend: (() => void) | undefined;
    t.agent.reviewer = (host) => {
      host.reportFindings([{ group: "Standards", kind: "violation", summary: "b.txt is empty" }]);
      mend = breakWorktree(task);
    };
    const review = await t.call("review.start", { threadId: task.id });
    await eventually(async () => {
      expect(await t.notes(review.id)).toEqual([
        expect.stringMatching(
          /^The findings couldn't go to the task, so they wait here\. Send the reviewer a message, and they go when its turn ends\. What went wrong: Its worktree is gone/,
        ),
      ]);
    });
    expect(await t.messages(task.id)).toEqual(["Add b.txt"]);

    mend!();
    t.agent.reviewer = () => {};
    const message = { text: "Try again", images: [] };
    await t.call("thread.send", { threadId: review.id, message });
    const sent = await eventually(async () => {
      const messages = await t.messages(task.id);
      expect(messages).toHaveLength(2);
      return messages[1];
    });
    expect(sent).toContain("violation: b.txt is empty");
  });
});
