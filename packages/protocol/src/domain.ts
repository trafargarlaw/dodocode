// The things dodocode keeps: projects, threads and what happens in them. The server owns them and
// sends them to clients in these shapes, whichever provider ran the agent.

export type ProviderId = "claude" | "codex";

/** How much the agent may do without asking. */
export type AccessMode =
  /** Runs commands and edits files without asking. */
  | "full"
  /** Asks before each command and edit it has not been allowed. */
  | "supervised";

export interface ModelOption {
  /** What the provider calls the model. */
  id: string;
  label: string;
  description?: string;
  /** The reasoning effort levels the model takes, lowest first. Empty when it takes none. */
  efforts: string[];
  defaultEffort?: string;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** `missing`: its CLI is not installed. `error`: it is installed but did not start. */
  status: "checking" | "ready" | "missing" | "error";
  message?: string;
  version?: string;
  models: ModelOption[];
}

/** A command typed as `/name` at the start of a message, which the agent runs itself. */
export interface SlashCommand {
  /** Without the slash. */
  name: string;
  description: string;
  /** What it takes after its name, e.g. `<tokens>`. */
  argumentHint?: string;
}

/** How full the agent's context window is. */
export interface ContextUsage {
  /** Tokens the conversation takes up now. */
  used: number;
  /** Tokens the window holds. */
  window: number;
  /** Where the agent compacts the conversation by itself. Unset when it doesn't. */
  autoCompactAt?: number;
  /** Set while the agent compacts the conversation. */
  compacting?: boolean;
  /** When it was measured. */
  at: number;
}

/** The settings a thread runs with. Each turn uses the settings the thread has when it starts. */
export interface ThreadSettings {
  provider: ProviderId;
  model: string;
  /** Empty when the model takes no effort level. */
  effort: string;
  access: AccessMode;
}

export interface Project {
  id: string;
  name: string;
  /** The folder the agents work in. */
  path: string;
  createdAt: number;
  /** Set when the folder is in a git repository. The server keeps it current. */
  git?: ProjectGit;
  /**
   * A Markdown file that says how to review this project's work, in place of the built-in way:
   * relative to the project's folder, or absolute. Unset: the built-in way.
   */
  reviewInstructions?: string;
}

/** What git says about a project's folder. */
export interface ProjectGit {
  /** The branch the folder has checked out. Unset when none is (a detached HEAD). */
  branch?: string;
}

/** Where a thread's agent works in its project. */
export type WorkspaceMode =
  /** In the project's folder, on whatever branch it has checked out. */
  | "local"
  /** In a worktree of its own, on a new branch, so the project's folder stays as it is. */
  | "worktree";

/** A worktree made for a thread: a checkout of its own, on a branch of its own. */
export interface Worktree {
  /** The worktree's folder. */
  path: string;
  /** Where in it the agent works: the project's folder, inside the checkout. */
  workDir: string;
  /** The branch made for the work. */
  branch: string;
  /** The branch it came from, which it merges back into. Unset when it came from a bare commit. */
  base?: string;
  /** The commit it came from. */
  from: string;
  /** What the work changed against `base`, counted when its last turn ended. */
  changed?: ChangeCount;
  /** Set once the branch was merged into `base` and the worktree removed. */
  mergedAt?: number;
}

/** How much changed: files, and lines added and removed. */
export interface ChangeCount {
  files: number;
  added: number;
  removed: number;
}

export type ThreadStatus =
  | "idle"
  | "running"
  /** Waiting for the person: an approval or a question. */
  | "waiting"
  | "error";

/**
 * Where a task stands. A thread without a task is a chat. A task in `backlog` is an idea: written
 * down, not planned, and not started until it moves to To do or someone starts it.
 */
export type TaskStatus = "backlog" | "todo" | "progress" | "review" | "done";

/** One thing a task is for, such as a fix the person wrote down. A task can cover several. */
export interface TaskItem {
  id: string;
  /** A short name for it. */
  title: string;
  /** All of it, in the person's words, when there is more than the title. */
  body?: string;
  images?: ImageRef[];
}

/** What makes a thread a task: where it stands, and what it is for. */
export interface Task {
  status: TaskStatus;
  /** What the task is for. A chat that became a task covers nothing until something is added. */
  covers: TaskItem[];
  /** When the status last changed. */
  movedAt: number;
  /** Set when a chat became this task by itself, because the agent changed files. */
  promoted?: boolean;
  /** Set when an agent wrote it down: the thread it was working in, which noticed it. */
  suggestedBy?: string;
  /**
   * Set once it reached In review with automatic reviews on, so a review started for it. It
   * reviews by itself only that once; after that, only when the person asks.
   */
  autoReviewed?: boolean;
  /** Set when it went back to In progress by itself, because its agent changed files in review. */
  reopened?: boolean;
}

/**
 * A review of a task's work, in a thread of its own under the task. The reviewer reads and
 * reports; the task's own agent, which knows why the code is as it is, answers each finding.
 */
export interface Review {
  /** The commit the work is compared with. */
  base: string;
  /** How the person knows the base: a branch, or a short commit. */
  baseLabel: string;
  /** The Markdown file the reviewer followed, when the project set one. Unset: the built-in way. */
  instructions?: string;
  /** Started by the app as the task reached In review, not by the person. */
  auto?: boolean;
  /** Set once the reviewer reported what it found. */
  reportedAt?: number;
  findings: Finding[];
  /** Set once the findings went to the task's agent. Its answers come back into them. */
  sentAt?: number;
}

/** One thing a review found. */
export interface Finding {
  id: string;
  /** The axis it was found on, such as Standards or Spec. Findings are never ranked across axes. */
  group: string;
  /** What sort of finding it is on its axis, such as a violation or a judgement call. */
  kind: string;
  /** What is wrong, in a sentence or two. */
  summary: string;
  /** The file it is in, relative to the project's folder. */
  file?: string;
  line?: number;
  /** The code, the standard or the request it rests on, word for word. */
  quote?: string;
  /** What the task's agent did about it. */
  answer?: FindingAnswer;
  /** What the person decided about a finding the agent disputed. */
  decision?: "fix" | "agree";
}

export interface FindingAnswer {
  /** `fixed`: the agent changed the code. `disputed`: it is as intended, and the note says why. */
  outcome: "fixed" | "disputed";
  note: string;
}

export interface Thread {
  id: string;
  /** The project the agent works in. A thread without one works in a folder of its own. */
  projectId?: string;
  /** Set on a subagent's thread: the thread that started it. On a review's: the task. */
  parentId?: string;
  /** On a subagent's thread, the tool call in the parent that started it. */
  parentItemId?: string;
  /** `review`: a fresh agent reviewing a task's work, under the task. */
  kind: "main" | "subagent" | "review";
  title: string;
  status: ThreadStatus;
  settings: ThreadSettings;
  /** The error that ended the last turn, while the thread is in `error`. */
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** When something last happened in the thread. Threads are listed by it, newest first. */
  activityAt: number;
  /** When its first turn started. A task in To do has none until someone starts it. */
  startedAt?: number;
  /** Set when the thread is a task. A thread without one is a chat. */
  task?: Task;
  /** Set once the person kept it a chat: it then never becomes a task by itself. */
  keepChat?: boolean;
  /**
   * Where the agent works, as chosen before its first turn. Unset: in the project's folder, or,
   * for a task in To do, wherever tasks usually start.
   */
  workspace?: WorkspaceMode;
  /** The worktree the agent works in, once one was made for it. */
  worktree?: Worktree;
  /** Listed first in its group. */
  pinned?: boolean;
  /** Hidden from the lists. Search still finds it. */
  archived?: boolean;
  /** How full the agent's context is, as last measured. Unset before its first turn. */
  context?: ContextUsage;
  /** On a review's thread: what it reviews, and what it found. */
  review?: Review;
}

/** An image the person pasted or dropped, kept by the server. */
export interface ImageRef {
  id: string;
  name: string;
  mime: string;
}

export interface ItemBase {
  id: string;
  threadId: string;
  /** The turn the item belongs to. */
  turnId: string;
  /** Orders items in the thread. */
  seq: number;
  createdAt: number;
}

export interface UserItem extends ItemBase {
  type: "user";
  text: string;
  images: ImageRef[];
  /** Sent into a turn that was running, rather than starting one. */
  steered?: boolean;
  /** Set when the app wrote the message for the person: what it is, which shows in its place. */
  app?: AppMessage;
}

/** A message the app sends an agent on the person's behalf. */
export type AppMessage =
  /** What a reviewer is asked to do. */
  | { kind: "review" }
  /** A review's findings, handed to the task's agent to answer. */
  | { kind: "findings"; reviewId: string };

export interface AssistantItem extends ItemBase {
  type: "assistant";
  text: string;
  streaming: boolean;
}

export interface ReasoningItem extends ItemBase {
  type: "reasoning";
  text: string;
  streaming: boolean;
}

export type ToolKind =
  | "command"
  | "edit"
  | "read"
  | "search"
  | "web"
  | "mcp"
  | "subagent"
  | "todo"
  | "plan"
  | "other";

export interface FileChange {
  path: string;
  kind: "add" | "update" | "delete" | "move";
  /** A unified diff, when the provider gives one. */
  diff?: string;
  movedTo?: string;
}

export interface TodoEntry {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ToolItem extends ItemBase {
  type: "tool";
  kind: ToolKind;
  /** The provider's name for the tool. */
  name: string;
  /** One line that says what the call does, e.g. the command or the file. */
  title: string;
  /** The call's input, as the provider sent it. */
  input: unknown;
  /** What the call printed or returned, as text. Streams for commands. */
  output: string;
  status: "running" | "done" | "error" | "denied";
  changes?: FileChange[];
  todos?: TodoEntry[];
  /** For a subagent call: the thread that shows the subagent's work. */
  childThreadId?: string;
  /** Exit code, for a command. */
  exitCode?: number;
  /** Set while the call runs in the background. */
  background?: boolean;
  endedAt?: number;
  /** Images the call gave back, such as a screenshot or an image file it read. */
  images?: ImageRef[];
}

export interface ApprovalOption {
  id: "allow" | "allow_session" | "deny";
  label: string;
}

export interface ApprovalItem extends ItemBase {
  type: "approval";
  kind: "command" | "edit" | "tool";
  title: string;
  /** The command, the files, or the tool input, to look at before deciding. */
  detail: string;
  reason?: string;
  changes?: FileChange[];
  /** The tool call it is for, when there is one. */
  toolItemId?: string;
  options: ApprovalOption[];
  status: "pending" | "allowed" | "denied" | "cancelled";
  decision?: ApprovalOption["id"];
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface Question {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface QuestionItem extends ItemBase {
  type: "question";
  questions: Question[];
  status: "pending" | "answered" | "cancelled";
  /** Question id to the chosen labels, or the person's own words as one entry. */
  answers?: Record<string, string[]>;
}

export interface NoticeItem extends ItemBase {
  type: "notice";
  level: "info" | "warning" | "error";
  text: string;
}

/** A web page the agent showed in the conversation, such as a mock-up or a chart. */
export interface ViewItem extends ItemBase {
  type: "view";
  title: string;
  /** Where the server serves the page: see `viewPath`. */
  viewId: string;
  /** The file it came from, when the agent showed a file. */
  path?: string;
}

/** What a reviewer reported, which shows as the findings with what became of each. */
export interface FindingsItem extends ItemBase {
  type: "findings";
  /** The review's thread, which holds them. */
  reviewId: string;
}

/** The end of a turn, with what it took. */
export interface TurnEndItem extends ItemBase {
  type: "turn_end";
  status: "completed" | "interrupted" | "failed";
  durationMs: number;
  error?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type Item =
  | UserItem
  | AssistantItem
  | ReasoningItem
  | ToolItem
  | ApprovalItem
  | QuestionItem
  | NoticeItem
  | ViewItem
  | FindingsItem
  | TurnEndItem;

export type ItemType = Item["type"];

/** A message waiting to be sent: the next turn starts with it, unless it is sent now to steer. */
export interface QueuedMessage {
  id: string;
  text: string;
  images: ImageRef[];
  createdAt: number;
  /** Set when the app wrote it for the person. */
  app?: AppMessage;
}

/** Work the agent left running: a background command, a subagent, a monitor. */
export interface BackgroundJob {
  id: string;
  kind: "command" | "subagent" | "monitor" | "other";
  title: string;
  status: "running" | "completed" | "failed" | "stopped";
  /** The tool call that started it. */
  toolItemId?: string;
  startedAt: number;
  endedAt?: number;
  summary?: string;
}

/** Defaults for new threads. */
export interface Settings {
  defaults: ThreadSettings;
  /** The model and effort last used with each provider, so switching back keeps them. */
  lastByProvider: Partial<Record<ProviderId, { model: string; effort: string }>>;
  /** Where tasks start: the choice last made for one. Chats start in the project's folder. */
  workspace: WorkspaceMode;
  review: ReviewSettings;
}

/** How tasks get reviewed. */
export interface ReviewSettings {
  /** Reviews a task by itself the first time it reaches In review. */
  auto: boolean;
  /** The model reviews run with. Unset: each task's own. */
  model?: Pick<ThreadSettings, "provider" | "model" | "effort">;
}
