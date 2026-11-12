// The seam between a thread and the agent that works in it. A provider adapter turns its agent's
// own events into dodocode items through an ItemWriter, and asks the person through the host.

import type {
  ApprovalItem,
  BackgroundJob,
  Item,
  ItemBase,
  ProviderId,
  ProviderInfo,
  Question,
  TaskStatus,
  ThreadSettings,
  TurnEndItem,
} from "@dodocode/protocol";
import type { ApprovalDecision } from "@dodocode/protocol";

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

/** The columns an agent can move its own task to. Only the person puts work in To do. */
export type AgentMove = Exclude<TaskStatus, "todo">;

/** What a thread gives its provider session. */
export interface SessionHost {
  readonly threadId: string;
  readonly cwd: string;
  /** The settings the thread has now. */
  settings(): ThreadSettings;
  readonly resumeId: string | undefined;
  saveResumeId(id: string): void;
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
  upsertJob(job: BackgroundJob): void;
  notice(level: "info" | "warning" | "error", text: string): void;
  /**
   * Moves the thread's task on the board, because the person asked the agent to. Returns what
   * to tell the agent, and throws when the thread can't go there.
   */
  moveTask(status: AgentMove): string;
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

export interface Provider {
  readonly id: ProviderId;
  readonly label: string;
  /** Checks the provider can run, and lists its models. */
  check(): Promise<ProviderInfo>;
  createSession(host: SessionHost): ProviderSession;
}
