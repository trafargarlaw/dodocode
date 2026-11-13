// A thread's items built from a conversation that happened in another app: its turns, at the
// times they happened, and its subagents' threads. Kept in memory until all of it is read, then
// saved together.

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";

import type { ImageRef, Item, TurnEndItem } from "@dodocode/protocol";

import type { ItemPatch, ItemWriter, NewItem } from "./providers/types";
import { newId } from "./util";

/** The time a conversation being read had reached. Each line read moves it on. */
export interface Clock {
  at: number;
}

export type TurnStatus = TurnEndItem["status"];

type TurnTotals = Pick<TurnEndItem, "error" | "costUsd" | "inputTokens" | "outputTokens">;

interface OpenTurn {
  id: string;
  startedAt: number;
  byAgent: boolean;
  items: number;
}

/** Writes the items of one thread, the main one or a subagent's, as a conversation is read. */
export class HistoryWriter implements ItemWriter {
  readonly threadId: string;
  readonly clock: Clock;
  private entries = new Map<string, Item>();
  /**
   * The ids the agent gave items, to the ids they have here. Every item gets a new id: a copy
   * of a conversation names its tool calls as the original does, and ids are unique across
   * threads.
   */
  private ids = new Map<string, string>();
  private seq: number;
  private turn: OpenTurn | undefined;

  constructor(threadId: string, clock: Clock = { at: 0 }, seq = 0) {
    this.threadId = threadId;
    this.clock = clock;
    this.seq = seq;
  }

  add(input: NewItem): Item {
    const { id: given, ...fields } = input;
    const id = newId();
    if (given) this.ids.set(given, id);
    const item = {
      ...fields,
      id,
      threadId: this.threadId,
      turnId: this.turn?.id ?? "",
      seq: ++this.seq,
      createdAt: this.clock.at,
    } as Item;
    if (this.turn) this.turn.items += 1;
    this.entries.set(id, item);
    return item;
  }

  update(id: string, patch: ItemPatch): void {
    const key = this.ids.get(id) ?? id;
    const current = this.entries.get(key);
    if (current) this.entries.set(key, { ...current, ...patch } as Item);
  }

  append(id: string, field: "text" | "output", text: string): void {
    const key = this.ids.get(id) ?? id;
    const current = this.entries.get(key);
    if (!current || !(field in current)) return;
    const before = (current as unknown as Record<string, string>)[field] ?? "";
    this.entries.set(key, { ...current, [field]: before + text } as Item);
  }

  get(id: string): Item | undefined {
    return this.entries.get(this.ids.get(id) ?? id);
  }

  get inTurn(): boolean {
    return this.turn !== undefined;
  }

  /** Starts a turn at the clock's time, by the person's message or by the agent itself. */
  startTurn(byAgent: boolean): void {
    this.turn = { id: newId(), startedAt: this.clock.at, byAgent, items: 0 };
  }

  /**
   * Ends the turn at `at`, the time of its last line, closing what it left open, as the thread
   * does when a live turn ends.
   */
  endTurn(status: TurnStatus, at = this.clock.at, totals: TurnTotals = {}): void {
    const turn = this.turn;
    if (!turn) return;
    for (const item of this.entries.values()) {
      if (item.turnId !== turn.id) continue;
      if ((item.type === "assistant" || item.type === "reasoning") && item.streaming) {
        this.entries.set(item.id, { ...item, streaming: false });
      } else if (item.type === "tool" && item.status === "running" && !item.background) {
        this.entries.set(item.id, {
          ...item,
          status: status === "completed" ? "done" : "error",
          endedAt: at,
        });
      }
    }
    if (!(turn.byAgent && turn.items === 0)) {
      const clock = this.clock.at;
      this.clock.at = at;
      this.add({
        type: "turn_end",
        status,
        durationMs: Math.max(0, at - turn.startedAt),
        ...definedOnly(totals),
      });
      this.clock.at = clock;
    }
    this.turn = undefined;
  }

  /**
   * Everything written, once the whole conversation is read. What was left running in the
   * background ended there unseen, and what waited on the person waits no more.
   */
  finish(): Item[] {
    for (const item of this.entries.values()) {
      if (item.type === "tool" && item.status === "running") {
        this.entries.set(item.id, { ...item, status: "done", background: undefined });
      } else if (
        (item.type === "approval" || item.type === "question") &&
        item.status === "pending"
      ) {
        this.entries.set(item.id, { ...item, status: "cancelled" });
      }
    }
    return [...this.entries.values()];
  }
}

/** A subagent's thread, read along with the conversation that started it. */
export interface HistoryChild {
  writer: HistoryWriter;
  /** The thread whose tool call started it. */
  parentId: string;
  /** That tool call's item. */
  parentItemId: string;
  title: string;
  failed: boolean;
}

/** A conversation being read into a thread, with its subagents' threads. */
export class History {
  readonly main: HistoryWriter;
  readonly children: HistoryChild[] = [];
  private keep: (data: Buffer, mime: string, name: string) => ImageRef | undefined;

  constructor(
    threadId: string,
    keep: (data: Buffer, mime: string, name: string) => ImageRef | undefined,
  ) {
    this.main = new HistoryWriter(threadId);
    this.keep = keep;
  }

  /** Opens the thread of a subagent that `parent`'s tool call `toolId` started. */
  child(parent: HistoryWriter, toolId: string, title: string): HistoryWriter {
    const writer = new HistoryWriter(newId(), { at: parent.clock.at });
    const parentItemId = parent.get(toolId)?.id ?? toolId;
    parent.update(toolId, { childThreadId: writer.threadId });
    this.children.push({ writer, parentId: parent.threadId, parentItemId, title, failed: false });
    return writer;
  }

  /** Keeps an image the conversation held, base64 encoded. */
  keepImage(data: string, mime: string): ImageRef | undefined {
    const extension = mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
    return this.keep(Buffer.from(data, "base64"), mime, `image.${extension}`);
  }

  /** Keeps an image file the conversation sent, while it is still there. */
  keepFile(path: string): ImageRef | undefined {
    const name = basename(path);
    const mime = IMAGE_TYPES[extname(name).slice(1).toLowerCase()];
    if (!mime) return undefined;
    try {
      return this.keep(readFileSync(path), mime, name);
    } catch {
      return undefined;
    }
  }
}

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/** Splits a `data:` URL into its type and base64 data. */
export function dataUrl(url: string): { mime: string; data: string } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return match ? { mime: match[1]!, data: match[2]! } : undefined;
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
