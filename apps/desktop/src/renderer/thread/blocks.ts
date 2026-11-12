import type {
  ApprovalItem,
  AssistantItem,
  Item,
  NoticeItem,
  QuestionItem,
  ReasoningItem,
  ToolItem,
  TurnEndItem,
  UserItem,
  ViewItem,
} from "@dodocode/protocol";

export type Step = ReasoningItem | ToolItem;

/** What the thread shows, in order: messages, and the agent's steps between them. */
export type Block =
  | { kind: "user"; id: string; item: UserItem }
  | { kind: "assistant"; id: string; item: AssistantItem }
  /**
   * Thinking and tool calls in a row, shown as one trace. It is settled once the agent has moved
   * past it, and no more steps can join it.
   */
  | { kind: "steps"; id: string; steps: Step[]; settled: boolean }
  | { kind: "approval"; id: string; item: ApprovalItem }
  | { kind: "question"; id: string; item: QuestionItem }
  | { kind: "notice"; id: string; item: NoticeItem }
  | { kind: "view"; id: string; item: ViewItem }
  | { kind: "turn_end"; id: string; item: TurnEndItem };

/**
 * Groups items, in order, into blocks. Thinking and tool calls in a row form one block, keyed by
 * its first item, so the block keeps its place while steps join it.
 *
 * While the thread runs, the steps after its last message or end of turn are not settled: the
 * agent is still at them, between one step and the next.
 */
export function toBlocks(items: readonly Item[], running: boolean): Block[] {
  const blocks: Block[] = [];
  for (const item of items) {
    if (item.type === "reasoning" || item.type === "tool") {
      const last = blocks.at(-1);
      if (last?.kind === "steps") last.steps.push(item);
      else blocks.push({ kind: "steps", id: item.id, steps: [item], settled: true });
      continue;
    }
    switch (item.type) {
      case "user":
        blocks.push({ kind: "user", id: item.id, item });
        break;
      case "assistant":
        blocks.push({ kind: "assistant", id: item.id, item });
        break;
      case "approval":
        blocks.push({ kind: "approval", id: item.id, item });
        break;
      case "question":
        blocks.push({ kind: "question", id: item.id, item });
        break;
      case "notice":
        blocks.push({ kind: "notice", id: item.id, item });
        break;
      case "view":
        blocks.push({ kind: "view", id: item.id, item });
        break;
      case "turn_end":
        blocks.push({ kind: "turn_end", id: item.id, item });
        break;
    }
  }
  if (running) {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const block = blocks[index]!;
      if (block.kind === "user" || block.kind === "assistant" || block.kind === "turn_end") break;
      if (block.kind === "steps") block.settled = false;
    }
  }
  return blocks;
}

export type DiffLineKind = "added" | "removed" | "hunk" | "context";

const FILE_HEADER =
  /^(index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity|rename )/;

export interface DiffLine {
  kind: DiffLineKind;
  /** The line without its leading `+`, `-` or space. A hunk keeps its `@@` header. */
  text: string;
}

/**
 * Reads a unified diff into lines. File headers (`---`, `+++`, `diff`, `index`) are dropped,
 * since the change already names its file.
 */
export function diffLines(diff: string): { lines: DiffLine[]; added: number; removed: number } {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let inHunk = false;
  for (const raw of diff.replace(/\n$/, "").split("\n")) {
    if (raw.startsWith("@@")) {
      inHunk = true;
      lines.push({ kind: "hunk", text: raw });
      continue;
    }
    // A new file's headers. Inside a hunk, `--- x` is a removed line that starts with `--`.
    if (raw.startsWith("diff ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk && FILE_HEADER.test(raw)) continue;
    const mark = raw[0];
    if (mark === "+") {
      added += 1;
      lines.push({ kind: "added", text: raw.slice(1) });
    } else if (mark === "-") {
      removed += 1;
      lines.push({ kind: "removed", text: raw.slice(1) });
    } else if (mark !== "\\") {
      // `\ No newline at end of file` says nothing worth a line.
      lines.push({ kind: "context", text: mark === " " ? raw.slice(1) : raw });
    }
  }
  return { lines, added, removed };
}
