// One thread's items, queue and background jobs. The server sends them only while the window has
// the thread open: the first collection read opens it, and the last one dropped closes it.

import {
  createCollection,
  createOptimisticAction,
  type Collection,
  type Transaction,
} from "@tanstack/react-db";
import type {
  ApprovalDecision,
  BackgroundJob,
  Item,
  OutgoingMessage,
  QueuedMessage,
  ServerEvent,
  ThreadDetail,
} from "@dodocode/protocol";
import { reportError } from "./app-data";
import { server } from "./connection";
import { applyItemEvents, type ItemEvent } from "./item-events";
import { Feed, feedSync, type RowWriter } from "./sync";

/** How long a thread's rows stay after nothing reads them, so going back to it is instant. */
const KEEP_MS = 60_000;
/** Item events wait for the next frame, so a fast stream redraws once per frame. */
const HIDDEN_FLUSH_MS = 100;

export class ThreadFeed {
  readonly items: Collection<Item, string>;
  readonly queue: Collection<QueuedMessage, string>;
  readonly jobs: Collection<BackgroundJob, string>;
  private itemRows: RowWriter<Item, string> | undefined;
  private queueRows: RowWriter<QueuedMessage, string> | undefined;
  private jobRows: RowWriter<BackgroundJob, string> | undefined;
  private pending: ItemEvent[] = [];
  private frame: number | undefined;
  private timer: number | undefined;

  constructor(readonly threadId: string) {
    const feed = new Feed<ThreadDetail>({
      load: () => server.call("thread.open", { threadId }),
      apply: (event) => this.apply(event),
      reset: () => this.drop(),
      release: () => {
        this.drop();
        server.call("thread.close", { threadId }).catch(() => {});
      },
    });
    this.items = createCollection<Item, string>({
      id: `items:${threadId}`,
      getKey: (item) => item.id,
      gcTime: KEEP_MS,
      sync: feedSync(
        feed,
        (item: Item): string => item.id,
        (detail) => detail.items,
        (writer) => (this.itemRows = writer),
      ),
    });
    this.queue = createCollection<QueuedMessage, string>({
      id: `queue:${threadId}`,
      getKey: (entry) => entry.id,
      gcTime: KEEP_MS,
      sync: feedSync(
        feed,
        (entry: QueuedMessage): string => entry.id,
        (detail) => detail.queue,
        (writer) => (this.queueRows = writer),
      ),
    });
    this.jobs = createCollection<BackgroundJob, string>({
      id: `jobs:${threadId}`,
      getKey: (job) => job.id,
      gcTime: KEEP_MS,
      sync: feedSync(
        feed,
        (job: BackgroundJob): string => job.id,
        (detail) => detail.jobs,
        (writer) => (this.jobRows = writer),
      ),
    });
  }

  /** Writes the item events that are waiting. An action calls it before its optimistic copy goes. */
  flush(): void {
    this.cancelFlush();
    const events = this.pending;
    this.pending = [];
    const rows = this.itemRows;
    if (events.length === 0 || !rows) return;
    const changed = applyItemEvents(rows.rows, events);
    if (changed.size > 0) rows.upsert(changed.values());
  }

  private apply(event: ServerEvent): void {
    switch (event.type) {
      case "item":
      case "item.append":
        if (event.threadId !== this.threadId) return;
        this.pending.push(event);
        this.scheduleFlush();
        return;
      case "queue":
        if (event.threadId === this.threadId) this.queueRows?.replace(event.queue);
        return;
      case "jobs":
        if (event.threadId === this.threadId) this.jobRows?.replace(event.jobs);
        return;
    }
  }

  private scheduleFlush(): void {
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => this.flush());
    // A hidden window draws no frames.
    this.timer = window.setTimeout(() => this.flush(), HIDDEN_FLUSH_MS);
  }

  private cancelFlush(): void {
    if (this.frame !== undefined) cancelAnimationFrame(this.frame);
    window.clearTimeout(this.timer);
    this.frame = undefined;
    this.timer = undefined;
  }

  /** Drops item events a new snapshot already holds. */
  private drop(): void {
    this.pending = [];
    this.cancelFlush();
  }
}

const feeds = new Map<string, ThreadFeed>();

/** The thread's data. The collections load once something reads them. */
export function threadData(threadId: string): ThreadFeed {
  let feed = feeds.get(threadId);
  if (!feed) {
    feed = new ThreadFeed(threadId);
    feeds.set(threadId, feed);
  }
  return feed;
}

// Actions. Each one shows its effect at once, and the server's own copy replaces it when the
// call returns: the server sends the change before it answers.

function settle(transaction: Transaction, title: string) {
  transaction.when("settled").catch((error: unknown) => reportError(title, error));
}

const approvalAction = createOptimisticAction<{
  threadId: string;
  itemId: string;
  decision: ApprovalDecision;
}>({
  onMutate: ({ threadId, itemId, decision }) => {
    threadData(threadId).items.update(itemId, (draft) => {
      if (draft.type !== "approval") return;
      draft.status = decision === "deny" ? "denied" : "allowed";
      draft.decision = decision;
    });
  },
  mutationFn: async ({ threadId, itemId, decision }) => {
    await server.call("approval.respond", { threadId, itemId, decision });
    threadData(threadId).flush();
  },
});

export function respondApproval(threadId: string, itemId: string, decision: ApprovalDecision) {
  settle(approvalAction({ threadId, itemId, decision }), "Could not send the decision");
}

const questionAction = createOptimisticAction<{
  threadId: string;
  itemId: string;
  answers: Record<string, string[]> | null;
}>({
  onMutate: ({ threadId, itemId, answers }) => {
    threadData(threadId).items.update(itemId, (draft) => {
      if (draft.type !== "question") return;
      if (answers) {
        draft.status = "answered";
        draft.answers = answers;
      } else {
        draft.status = "cancelled";
      }
    });
  },
  mutationFn: async ({ threadId, itemId, answers }) => {
    await server.call("question.respond", { threadId, itemId, answers });
    threadData(threadId).flush();
  },
});

export function respondQuestion(
  threadId: string,
  itemId: string,
  answers: Record<string, string[]> | null,
) {
  settle(questionAction({ threadId, itemId, answers }), "Could not send the answers");
}

const queueAction = createOptimisticAction<{
  threadId: string;
  queueId: string;
  steer: boolean;
}>({
  onMutate: ({ threadId, queueId }) => {
    threadData(threadId).queue.delete(queueId);
  },
  mutationFn: async ({ threadId, queueId, steer }) => {
    await server.call(steer ? "queue.steer" : "queue.remove", { threadId, queueId });
    threadData(threadId).flush();
  },
});

export function removeQueued(threadId: string, queueId: string) {
  settle(queueAction({ threadId, queueId, steer: false }), "Could not remove the message");
}

export function steerQueued(threadId: string, queueId: string) {
  settle(queueAction({ threadId, queueId, steer: true }), "Could not send the message now");
}

export async function sendMessage(
  threadId: string,
  message: OutgoingMessage,
  mode?: "queue" | "steer",
): Promise<boolean> {
  try {
    await server.call("thread.send", { threadId, message, mode });
    return true;
  } catch (error) {
    reportError("Could not send the message", error);
    return false;
  }
}

export function interrupt(threadId: string): void {
  server
    .call("thread.interrupt", { threadId })
    .catch((error: unknown) => reportError("Could not stop the agent", error));
}

export function stopJob(threadId: string, jobId: string): void {
  server
    .call("job.stop", { threadId, jobId })
    .catch((error: unknown) => reportError("Could not stop it", error));
}
