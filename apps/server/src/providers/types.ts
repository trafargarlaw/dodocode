// The seam between a thread and the agent that works in it. A provider adapter turns its agent's
// own events into dodocode items through an ItemWriter, and asks the person through the host.

import type {
  ApprovalItem,
  BackgroundJob,
  ContextUsage,
  Finding,
  FindingAnswer,
  ImageRef,
  Item,
  ItemBase,
  ProviderId,
  ProviderInfo,
  Question,
  SlashCommand,
  TaskStatus,
  ThreadSettings,
  TurnEndItem,
} from "@dodocode/protocol";
import type { ApprovalDecision, OutsideSession } from "@dodocode/protocol";

import type { History } from "../history";
import type { JobEnd } from "../jobs";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An item before the thread gives it an id, a turn and a place. */
export type NewItem = DistributiveOmit<Item, keyof ItemBase> & { id?: string };

/** Fields of an item that may change after it is added. */
export type ItemPatch = Partial<DistributiveOmit<Item, keyof ItemBase | "type">>;

export interface ItemWriter {
  readonly threadId: string;
  add(item: NewItem): Item;
  update(id: string, patch: ItemPatch): void;
  /** Adds text to the end of an item's `text` or `output`. */
  append(id: string, field: "text" | "output", text: string): void;
  get(id: string): Item | undefined;
}

/** An image to send, read from the attachment store. */
export interface TurnImage {
  id: string;
  name: string;
  mime: string;
  path: string;
}

export interface TurnMessage {
  text: string;
  images: TurnImage[];
}

export type TurnOutcome = Pick<
  TurnEndItem,
  "status" | "error" | "costUsd" | "inputTokens" | "outputTokens"
>;

export type ApprovalRequest = Pick<
  ApprovalItem,
  "kind" | "title" | "detail" | "reason" | "changes" | "toolItemId"
> & {
  /** Leave out "allow for this session" when the agent cannot remember it. */
  sessionOption?: boolean;
};

/** A subagent's own thread, which the parent's adapter writes into. */
export interface SubagentWriter extends ItemWriter {
  finish(status: "completed" | "failed" | "stopped", summary?: string): void;
}

/**
 * The columns an agent can move its own task to. Only the person puts work in To do or the
 * backlog.
 */
export type AgentMove = Exclude<TaskStatus, "todo" | "backlog">;

/** An idea the agent noticed along the way, for the backlog. */
export interface IdeaRequest {
  title: string;
  /** What someone picking it up later needs to know. */
  details?: string;
}

/** A web page the agent shows: HTML it wrote, or an HTML file on disk. */
export interface PageRequest {
  title: string;
  html?: string;
  /** Absolute, or relative to where the agent works. */
  path?: string;
}

/** What changed in the context usage since it was last measured. */
export type ContextPatch = Partial<Omit<ContextUsage, "at">>;

/** What a thread gives its provider session. */
export interface SessionHost {
  readonly threadId: string;
  readonly cwd: string;
  /** The settings the thread has now. */
  settings(): ThreadSettings;
  readonly resumeId: string | undefined;
  /** Keeps the session to pick up again. A different session forgets the cost of the last. */
  saveResumeId(id: string): void;
  /** The running cost the session to pick up had reached, as last saved. */
  readonly resumeCost: number | undefined;
  saveResumeCost(costUsd: number): void;
  /** Writes into the thread's current turn. */
  readonly items: ItemWriter;
  /**
   * The agent started work on its own, e.g. after a background task finished. Opens a turn for
   * it when none is running, so its items have a turn to belong to.
   */
  agentTurnStarted(): void;
  /** Ends the running turn. */
  turnEnded(outcome: TurnOutcome): void;
  requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
  /** Resolves to the answers by question id, or `null` when the person dismisses them. */
  requestAnswers(
    questions: Question[],
    signal?: AbortSignal,
  ): Promise<Record<string, string[]> | null>;
  /** Opens a thread for a subagent the agent started from a tool call. */
  openSubagent(options: { title: string; toolItemId: string }): SubagentWriter;
  /** Work the agent sent to the background started, or changed. */
  jobStarted(job: BackgroundJob): void;
  /** Work ended. Only work that went to the background is a job. */
  jobEnded(id: string, end: JobEnd): void;
  notice(level: "info" | "warning" | "error", text: string): void;
  /**
   * Moves the thread's task on the board, because the person asked the agent to. Returns what
   * to tell the agent, and throws when the thread can't go there.
   */
  moveTask(status: AgentMove): string;
  /** Adds an idea to the backlog of the thread's project. Returns what to tell the agent. */
  addIdea(idea: IdeaRequest): string;
  /** Keeps an image a tool gave back, base64 encoded, so the thread can show it. */
  keepImage(data: string, mime: string): ImageRef | undefined;
  /** Shows a web page in the thread. Returns what to tell the agent; throws when it can't. */
  showPage(page: PageRequest): string;
  /** How full the agent's context is now. */
  contextUsed(patch: ContextPatch): void;
  /** The slash commands the agent takes where it works, its own and the ones added there. */
  commandsFound(commands: SlashCommand[]): void;
  /**
   * Set when the agent reviews a task's work: it only reads, and reports what it found with
   * report_findings, rather than moving tasks or answering findings.
   */
  readonly reviewing: boolean;
  /** Keeps what a reviewer found. Returns what to tell it; throws when it can't. */
  reportFindings(findings: FindingReport[]): string;
  /** Records the task's agent's answers to the reviews sent to it. Returns what to tell it. */
  answerFindings(answers: FindingAnswerRequest[]): string;
  /**
   * Sets the Markdown file the project's work is reviewed by, or the built-in way with `null`,
   * because the person asked the agent to. Returns what to tell it; throws when it can't.
   */
  setReviewInstructions(path: string | null): string;
}

/** A finding as a reviewer reports it. */
export type FindingReport = Omit<Finding, "id" | "answer" | "decision">;

/** The task's agent's answer to the finding with `id`. */
export interface FindingAnswerRequest extends FindingAnswer {
  id: string;
}

export interface ProviderSession {
  /** Starts a turn with the message. The session calls `turnEnded` when it ends. */
  startTurn(message: TurnMessage): Promise<void>;
  /** Sends a message into the running turn. Resolves false when it cannot right now. */
  steer(message: TurnMessage): Promise<boolean>;
  interrupt(): Promise<void>;
  stopJob(jobId: string): Promise<void>;
  /** Stops the agent's process. The thread can start a new session later. */
  dispose(): Promise<void>;
}

/** What checking a provider finds: whether it runs, its models, and its slash commands. */
export interface ProviderCheck extends ProviderInfo {
  /** Its agent's own slash commands, before any project adds its own. */
  commands?: SlashCommand[];
}

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  /** Checks the provider can run, and lists its models and commands. */
  check(): Promise<ProviderCheck>;
  createSession(host: SessionHost): ProviderSession;
  /** The conversations its agent had in other apps. */
  readonly sessions: SessionSource;
}

/** A conversation the agent had in another app, as its provider lists it. */
export type FoundSession = Omit<OutsideSession, "provider" | "threadId">;

/** What reading a conversation from another app found, beside its items. */
export interface SessionRead {
  title?: string;
  /** The model and effort it ran with last. */
  model?: string;
  effort?: string;
  /** The running cost it had reached, which the agent carries on from. */
  costUsd?: number;
}

/** The conversations a provider's agent had in other apps, which a thread can carry on. */
export interface SessionSource {
  /** Newest first. */
  list(): Promise<FoundSession[]>;
  /** Writes what was said and done in it, and in its subagents, into `history`. */
  read(id: string, history: History): Promise<SessionRead>;
  /** Makes a copy of it, which goes on apart from it, and gives the copy's id. */
  copy(id: string, cwd: string): Promise<string>;
}
