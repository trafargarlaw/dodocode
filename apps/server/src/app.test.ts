import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Thread } from "@dodocode/protocol";

import { testApp, type FakeConversation, type TestApp } from "./test-app";

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

/** Runs a review that finds one thing, and waits until the task's agent has had it. */
async function reviewFinding(
  taskId: string,
  summary: string,
): Promise<{ reviewId: string; findingId: string }> {
  const before = (await t.messages(taskId)).length;
  t.agent.reviewer = (host) => {
    host.reportFindings([{ group: "Standards", kind: "violation", summary }]);
  };
  const review = await t.call("review.start", { threadId: taskId });
  await eventually(async () => expect(await t.messages(taskId)).toHaveLength(before + 1));
  await idle(taskId);
  return { reviewId: review.id, findingId: (await t.thread(review.id)).review!.findings[0]!.id };
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

/** The id of the first finding in a findings message. */
function findingIn(message: string): string {
  return /\*\*(f\w+)\*\*/.exec(message)![1]!;
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

  test("an answer goes to the review its finding is in, though a later review came since", async () => {
    const task = await taskInReview();
    const first = await reviewFinding(task.id, "b.txt is empty");
    t.agent.worker = (host, message) => {
      host.answerFindings([
        { id: first.findingId, outcome: "fixed", note: "Filled it in." },
        { id: findingIn(message.text), outcome: "disputed", note: "It needs none." },
      ]);
    };
    const second = await reviewFinding(task.id, "b.txt has no heading");
    expect((await t.thread(first.reviewId)).review!.findings[0]!.answer).toEqual({
      outcome: "fixed",
      note: "Filled it in.",
    });
    expect((await t.thread(second.reviewId)).review!.findings[0]!.answer).toEqual({
      outcome: "disputed",
      note: "It needs none.",
    });
  });

  test("a fix asked for anyway that couldn't be sent is undone, and can be asked again", async () => {
    const task = await taskInReview();
    t.agent.worker = (host, message) => {
      host.answerFindings([
        { id: findingIn(message.text), outcome: "disputed", note: "Intended." },
      ]);
    };
    const { reviewId, findingId } = await reviewFinding(task.id, "b.txt is empty");
    t.agent.worker = () => {};
    const mend = breakWorktree(task);
    const decide = { reviewId, findingId, decision: "fix" } as const;
    await expect(t.call("review.decide", decide)).rejects.toThrow(/^Its worktree is gone/);
    expect((await t.thread(reviewId)).review!.findings[0]!.decision).toBeUndefined();

    mend();
    await t.call("review.decide", decide);
    expect((await t.thread(reviewId)).review!.findings[0]!.decision).toBe("fix");
    expect((await t.messages(task.id)).at(-1)).toMatch(
      new RegExp(`^I read why you left ${findingId} as it is, and I want it fixed anyway`),
    );
  });

  test("findings reported just before the app quit go to the task when it starts again", async () => {
    const task = await taskInReview();
    t.agent.reviewer = async (host) => {
      host.reportFindings([{ group: "Standards", kind: "violation", summary: "b.txt is empty" }]);
      // The app quits before the reviewer's turn ends.
      await new Promise(() => {});
    };
    const review = await t.call("review.start", { threadId: task.id });
    await eventually(async () => {
      expect((await t.thread(review.id)).review!.reportedAt).toBeTypeOf("number");
    });
    await t.restart();
    const sent = await eventually(async () => {
      const messages = await t.messages(task.id);
      expect(messages).toHaveLength(2);
      return messages[1];
    });
    expect(sent).toContain("violation: b.txt is empty");
  });
});

/** A 1×1 PNG. */
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

/** Gives the agent a conversation `id` it had in Claude Code, in `cwd`. */
function hadConversation(id: string, cwd: string, extra: Partial<FakeConversation> = {}): void {
  t.agent.elsewhere.push({
    id,
    title: `Conversation ${id}`,
    cwd,
    app: "Claude Code",
    updatedAt: Date.now() - 60_000,
    said: `Asked in ${id}`,
    ...extra,
  });
}

/** Brings in the Claude Code conversation `sessionId`. */
function bringIn(sessionId: string, mode: "same" | "copy"): Promise<Thread> {
  return t.call("sessions.import", { provider: "claude", sessionId, mode });
}

/** The conversations "Bring in" lists, and which of them are threads already. */
async function listed(): Promise<string[]> {
  const { sessions } = await t.call("sessions.list", {});
  return sessions.map((session) => (session.threadId ? `${session.id}, brought in` : session.id));
}

describe("bringing in a conversation from another app", { timeout: 30_000 }, () => {
  test("one that can't be brought in leaves no copy in the other app", async () => {
    // A file where its folder was, so it can't be added as a project.
    const file = join(t.dir, "notes.txt");
    writeFileSync(file, "");
    hadConversation("s1", file);
    await expect(bringIn("s1", "copy")).rejects.toThrow(/is not a folder\.$/);
    expect(t.agent.elsewhere.map((conversation) => conversation.id)).toEqual(["s1"]);
  });

  test("the sessions dodocode made stay out of the list once their threads are deleted", async () => {
    const message = { text: "Add b.txt", images: [] };
    const task = await t.call("task.create", { projectId: t.project.id, message });
    await t.call("thread.send", { threadId: task.id, message });
    await idle(task.id);
    hadConversation("s1", t.project.path);
    const copy = await bringIn("s1", "copy");
    // The task's own session and the copy are threads, so only the original lists.
    expect(await listed()).toEqual(["s1, brought in"]);

    await t.call("thread.delete", { threadId: task.id });
    await t.call("thread.delete", { threadId: copy.id });
    expect(await listed()).toEqual(["s1"]);
  });

  test("one whose folder was gone can't carry on, though the folder comes back", async () => {
    const folder = join(t.dir, "gone");
    hadConversation("s1", folder);
    const thread = await bringIn("s1", "same");
    expect(await t.messages(thread.id)).toEqual(["Asked in s1"]);

    mkdirSync(folder);
    const message = { text: "Go on", images: [] };
    await expect(t.call("thread.send", { threadId: thread.id, message })).rejects.toThrow(
      /^The folder this conversation worked in was gone when it was brought in/,
    );
  });

  test("one from another app's worktree has that checkout, and the branch it is on", async () => {
    const worktree = join(t.dir, "elsewhere");
    t.git("worktree", "add", "-q", "-b", "feature", worktree);
    hadConversation("s1", worktree);
    hadConversation("s2", t.project.path);
    const there = await bringIn("s1", "same");
    const here = await bringIn("s2", "same");
    expect(there.projectId).toBe(t.project.id);
    expect(there.origin!.checkout).toEqual({ path: worktree, branch: "feature" });
    expect(here.origin!.checkout).toBeUndefined();

    t.agent.worker = () => {
      t.git("-C", worktree, "switch", "-q", "-c", "other");
    };
    const message = { text: "Branch off", images: [] };
    await t.call("thread.send", { threadId: there.id, message });
    await eventually(async () => {
      expect((await t.thread(there.id)).origin!.checkout).toEqual({
        path: worktree,
        branch: "other",
      });
    });
  });

  test("its images are kept once it is brought in, and not when that fails", async () => {
    hadConversation("s1", t.project.path, { image: PNG });
    t.agent.copyFails = true;
    await expect(bringIn("s1", "copy")).rejects.toThrow("The copy could not be written.");
    expect(t.attachments()).toEqual([]);

    t.agent.copyFails = false;
    const thread = await bringIn("s1", "copy");
    const sent = (await t.items(thread.id)).flatMap((item) =>
      item.type === "user" ? item.images : [],
    );
    expect(t.attachments()).toEqual([`${sent[0]!.id}.png`]);
  });
});
