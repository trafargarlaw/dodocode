// What travels over the WebSocket between a client and the server. A client calls methods, and
// the server answers each call and pushes events as things change.

import type {
  BackgroundJob,
  FileChange,
  ImageRef,
  Item,
  Project,
  ProviderInfo,
  QueuedMessage,
  Settings,
  TaskStatus,
  Thread,
  ThreadSettings,
  WorkspaceMode,
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

/** What a thread's work changed, file by file. */
export interface WorkChanges {
  /**
   * The branch the changes are against, for work in a worktree. Unset for work in the project's
   * folder, whose changes are what isn't committed yet.
   */
  against?: string;
  files: FileChange[];
  /** Set when there was more than could be shown. */
  truncated?: boolean;
}

/** The folders in a folder on the server's machine, to pick a project's folder from. */
export interface FolderListing {
  /** The folder listed, absolute, as the system writes it. */
  path: string;
  /** The folder above it. Unset at the top of a drive. */
  parent?: string;
  /** The home folder, which a path can start with `~` for. */
  home: string;
  folders: FolderEntry[];
}

export interface FolderEntry {
  name: string;
  /** Set when it holds a git repository at its top. */
  git?: boolean;
}

/** How merging a worktree's branch went. When it conflicts, nothing changed. */
export type MergeResult =
  | { merged: true; thread: Thread }
  | { merged: false; base: string; conflicts: string[] };

/** Every method a client can call, with what it takes and what it gives back. */
export interface Methods {
  "app.snapshot": { params: Record<string, never>; result: Snapshot };

  "project.add": { params: { path: string }; result: Project };
  /**
   * Makes a new folder `name` in `parent`, starts a git repository in it with an empty first
   * commit, so a worktree has something to branch from, and adds it as a project.
   */
  "project.create": { params: { parent: string; name: string }; result: Project };
  /** Clones a repository into a new folder `name` in `parent`, and adds it as a project. */
  "project.clone": { params: { url: string; parent: string; name: string }; result: Project };
  /** Lists the folders in a folder. A path can start with `~` for the home folder. */
  "folder.list": { params: { path: string }; result: FolderListing };
  "project.remove": { params: { projectId: string }; result: null };
  "project.openInEditor": { params: { projectId: string }; result: null };

  /**
   * Starts a thread, and its first turn when a message comes with it. Without a project, the
   * agent works in a folder of the thread's own. Sent to a `worktree`, it is a task from the
   * start, and works in a worktree of its own.
   */
  "thread.create": {
    params: {
      projectId?: string;
      settings?: Partial<ThreadSettings>;
      message?: OutgoingMessage;
      workspace?: WorkspaceMode;
    };
    result: Thread;
  };
  /** Gives the thread's items and sends its changes until the client closes it. */
  "thread.open": { params: { threadId: string }; result: ThreadDetail };
  "thread.close": { params: { threadId: string }; result: null };
  /**
   * Sends a message. An idle thread starts a turn with it. While a turn runs, `queue` (the
   * default) holds it for the next turn, and `steer` sends it into the running turn. A thread's
   * first message makes its worktree, when it works in one.
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
      /** Only before the thread's first turn. */
      workspace?: WorkspaceMode;
    };
    result: Thread;
  };
  /** Deletes a thread. Its worktree goes too, after its changes are committed to its branch. */
  "thread.delete": { params: { threadId: string }; result: null };
  /** Opens the folder the thread's agent works in, in VS Code. */
  "thread.openInEditor": { params: { threadId: string }; result: null };
  /** What the thread's work changed: against its base branch in a worktree, else uncommitted. */
  "thread.changes": { params: { threadId: string }; result: WorkChanges };
  /**
   * Commits what the agent left in the thread's worktree, merges its branch into the branch it
   * came from, then removes the worktree and the branch. A task is then done.
   */
  "thread.merge": { params: { threadId: string }; result: MergeResult };

  /** Adds a task to To do, or an idea to the backlog. It starts when its first message is sent. */
  "task.create": {
    params: {
      projectId: string;
      message: OutgoingMessage;
      /** Unset: To do. */
      status?: "todo" | "backlog";
      settings?: Partial<ThreadSettings>;
      /** Where it will work. Unset: wherever tasks usually start, when it starts. */
      workspace?: WorkspaceMode;
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
  /**
   * Takes one item off a task and puts it in To do as a task of its own, which it returns. Off
   * an idea in the backlog, it stays in the backlog.
   */
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
