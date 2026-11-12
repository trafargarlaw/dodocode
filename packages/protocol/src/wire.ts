// What travels over the WebSocket between a client and the server. A client calls methods, and
// the server answers each call and pushes events as things change.

import type {
  BackgroundJob,
  ImageRef,
  Item,
  Project,
  ProviderInfo,
  QueuedMessage,
  Settings,
  TaskStatus,
  Thread,
  ThreadSettings,
} from "./domain";

/** What the person sends: words and pasted images. */
export interface OutgoingMessage {
  text: string;
  images: ImageRef[];
}

export interface Snapshot {
  projects: Project[];
  threads: Thread[];
  providers: ProviderInfo[];
  settings: Settings;
}

export interface ThreadDetail {
  thread: Thread;
  items: Item[];
  queue: QueuedMessage[];
  jobs: BackgroundJob[];
}

export type ApprovalDecision = "allow" | "allow_session" | "deny";

/** Every method a client can call, with what it takes and what it gives back. */
export interface Methods {
  "app.snapshot": { params: Record<string, never>; result: Snapshot };

  "project.add": { params: { path: string }; result: Project };
  "project.remove": { params: { projectId: string }; result: null };
  "project.openInEditor": { params: { projectId: string }; result: null };

  /**
   * Starts a thread, and its first turn when a message comes with it. Without a project, the
   * agent works in a folder of the thread's own.
   */
  "thread.create": {
    params: { projectId?: string; settings?: Partial<ThreadSettings>; message?: OutgoingMessage };
    result: Thread;
  };
  /** Gives the thread's items and sends its changes until the client closes it. */
  "thread.open": { params: { threadId: string }; result: ThreadDetail };
  "thread.close": { params: { threadId: string }; result: null };
  /**
   * Sends a message. An idle thread starts a turn with it. While a turn runs, `queue` (the
   * default) holds it for the next turn, and `steer` sends it into the running turn.
   */
  "thread.send": {
    params: { threadId: string; message: OutgoingMessage; mode?: "queue" | "steer" };
    result: null;
  };
  "thread.interrupt": { params: { threadId: string }; result: null };
  "thread.update": {
    params: {
      threadId: string;
      title?: string;
      settings?: Partial<ThreadSettings>;
      pinned?: boolean;
      archived?: boolean;
    };
    result: Thread;
  };
  "thread.delete": { params: { threadId: string }; result: null };

  /** Adds a task to To do. It starts when its first message is sent. */
  "task.create": {
    params: {
      projectId: string;
      message: OutgoingMessage;
      settings?: Partial<ThreadSettings>;
    };
    result: Thread;
  };
  /**
   * Moves a thread on the board. A chat becomes a task. `null` makes a task a chat again, and it
   * then stays a chat.
   */
  "task.move": { params: { threadId: string; status: TaskStatus | null }; result: Thread };
  /**
   * Folds tasks that have not started into this one: what they cover joins it, and they go. When
   * this task has started, the agent gets what was added as a message.
   */
  "task.merge": { params: { threadId: string; from: string[] }; result: Thread };
  /** Takes one item off a task and puts it in To do as a task of its own, which it returns. */
  "task.split": { params: { threadId: string; itemId: string }; result: Thread };

  "queue.remove": { params: { threadId: string; queueId: string }; result: null };
  /** Sends a queued message into the running turn now. */
  "queue.steer": { params: { threadId: string; queueId: string }; result: null };

  "approval.respond": {
    params: { threadId: string; itemId: string; decision: ApprovalDecision };
    result: null;
  };
  /** Answers the agent's questions. `null` answers dismiss them. */
  "question.respond": {
    params: { threadId: string; itemId: string; answers: Record<string, string[]> | null };
    result: null;
  };

  "job.stop": { params: { threadId: string; jobId: string }; result: null };

  /** Keeps an image for a message. The data is base64. */
  "attachment.upload": { params: { name: string; mime: string; data: string }; result: ImageRef };

  "settings.update": { params: Partial<Settings>; result: Settings };
  "providers.refresh": { params: Record<string, never>; result: ProviderInfo[] };
}

export type Method = keyof Methods;
export type Params<M extends Method> = Methods[M]["params"];
export type Result<M extends Method> = Methods[M]["result"];

/** What the server pushes. Thread item events go only to clients that have the thread open. */
export type ServerEvent =
  | { type: "projects"; projects: Project[] }
  | { type: "thread"; thread: Thread }
  | { type: "thread.removed"; threadId: string }
  | { type: "providers"; providers: ProviderInfo[] }
  | { type: "settings"; settings: Settings }
  /** An item, new or changed, whole. */
  | { type: "item"; threadId: string; item: Item }
  /** Text added to the end of a streaming item's `text` or `output`. */
  | {
      type: "item.append";
      threadId: string;
      itemId: string;
      field: "text" | "output";
      text: string;
    }
  | { type: "queue"; threadId: string; queue: QueuedMessage[] }
  | { type: "jobs"; threadId: string; jobs: BackgroundJob[] };

export interface CallFrame<M extends Method = Method> {
  id: number;
  method: M;
  params: Params<M>;
}

export type ServerFrame =
  | { id: number; result: unknown }
  | { id: number; error: { message: string } }
  | { event: ServerEvent };

/** Where the server serves an attachment's bytes, relative to its address. */
export function attachmentPath(id: string): string {
  return `/attachments/${encodeURIComponent(id)}`;
}
