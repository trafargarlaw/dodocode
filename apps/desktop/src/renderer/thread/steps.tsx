import type { ReactNode } from "react";
import type { ReasoningItem, TodoEntry, ToolItem, ToolKind } from "@dodocode/protocol";
import {
  ArrowUpRight01Icon,
  BrainIcon,
  CheckListIcon,
  CommandLineIcon,
  File01Icon,
  FileEditIcon,
  FileSearchIcon,
  Globe02Icon,
  Layers01Icon,
  Plug01Icon,
  Tick02Icon,
  UserMultiple02Icon,
  WorkflowSquare01Icon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@dodocode/ui/components/badge";
import { Button } from "@dodocode/ui/components/button";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@dodocode/ui/components/trace";
import { cn } from "@dodocode/ui/lib/utils";
import { duration } from "../time";
import { openThread } from "../view";
import type { Step } from "./blocks";
import { changeCounts, Code, FileDiff, Output } from "./code";
import { Images } from "./image-view";
import { Markdown } from "./markdown";

/** A settled run of more steps than this folds into one line. */
const FOLD_AT = 4;

const TOOL_ICON: Record<ToolKind, typeof ZapIcon> = {
  command: CommandLineIcon,
  edit: FileEditIcon,
  read: File01Icon,
  search: FileSearchIcon,
  web: Globe02Icon,
  mcp: Plug01Icon,
  subagent: UserMultiple02Icon,
  todo: CheckListIcon,
  plan: WorkflowSquare01Icon,
  other: ZapIcon,
};

/** Kinds whose title is a command or a path, which reads best in a monospace font. */
const MONO_TITLE = new Set<ToolKind>(["command", "edit", "read", "search"]);

/**
 * The agent's thinking and tool calls between two messages. The images its tools gave back, such
 * as screenshots, show under them, folded or not.
 */
export function StepsBlock({ steps, settled }: { steps: Step[]; settled: boolean }) {
  const images = steps.flatMap((step) => (step.type === "tool" ? (step.images ?? []) : []));
  const trace = <StepsTrace steps={steps} settled={settled} />;
  if (images.length === 0) return trace;
  return (
    <div className="flex flex-col gap-2.5">
      {trace}
      <Images images={images} align="start" />
    </div>
  );
}

/**
 * A run the agent is still adding to stays open: folding it while no step runs would fold and
 * unfold it between one step and the next.
 */
function StepsTrace({ steps, settled }: { steps: Step[]; settled: boolean }) {
  const list = (
    <Trace className="gap-1.5">
      {steps.map((step) =>
        step.type === "reasoning" ? (
          <ReasoningStep key={step.id} item={step} />
        ) : (
          <ToolStep key={step.id} item={step} />
        ),
      )}
    </Trace>
  );
  if (!settled || steps.length <= FOLD_AT) return list;

  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon>
            <HugeiconsIcon icon={Layers01Icon} strokeWidth={1.8} />
          </TraceIcon>
          <TraceTitle>{steps.length} steps</TraceTitle>
          <TraceDescription>{summarize(steps)}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>{list}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

const COUNT_WORDS: Partial<Record<ToolKind, [string, string]>> = {
  command: ["command", "commands"],
  edit: ["edit", "edits"],
  read: ["read", "reads"],
  search: ["search", "searches"],
  web: ["web call", "web calls"],
  mcp: ["tool call", "tool calls"],
  subagent: ["subagent", "subagents"],
};

/** What a folded run of steps did, by kind: `3 commands, 2 edits`. */
function summarize(steps: Step[]): string {
  const counts = new Map<ToolKind, number>();
  for (const step of steps) {
    if (step.type === "tool") counts.set(step.kind, (counts.get(step.kind) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [kind, words] of Object.entries(COUNT_WORDS) as [ToolKind, [string, string]][]) {
    const count = counts.get(kind);
    if (count) parts.push(`${count} ${count === 1 ? words[0] : words[1]}`);
  }
  return parts.join(", ");
}

function ReasoningStep({ item }: { item: ReasoningItem }) {
  const line = (
    <TraceLine status={item.streaming ? "running" : undefined}>
      <TraceIcon>
        <HugeiconsIcon icon={BrainIcon} strokeWidth={1.8} />
      </TraceIcon>
      <TraceTitle>{item.streaming ? "Thinking" : "Thought"}</TraceTitle>
    </TraceLine>
  );
  // Some providers keep the thinking to themselves: then there is only the line.
  if (!item.text.trim()) return <div>{line}</div>;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Markdown text={item.text} className="text-[13px]" />
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function ToolStep({ item }: { item: ToolItem }) {
  const detail = toolDetail(item);
  const status =
    item.status === "running" ? "running" : item.status === "error" ? "error" : undefined;
  const line = (
    <TraceLine status={status}>
      <TraceIcon>
        <HugeiconsIcon icon={TOOL_ICON[item.kind]} strokeWidth={1.8} />
      </TraceIcon>
      <TraceTitle className={cn(MONO_TITLE.has(item.kind) && "font-mono text-[12.5px]")}>
        {item.title}
      </TraceTitle>
      <ToolDescription item={item} />
    </TraceLine>
  );
  if (!detail) return <div>{line}</div>;
  return (
    <TraceCollapsible defaultOpen={item.kind === "todo" || item.kind === "plan"}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">{detail}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function ToolDescription({ item }: { item: ToolItem }) {
  const parts: ReactNode[] = [];
  if (item.kind === "edit" && item.changes?.length) {
    const { added, removed } = changeCounts(item.changes);
    if (added || removed) {
      parts.push(
        <span key="diff">
          <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
          <span className="text-destructive">−{removed}</span>
        </span>,
      );
    }
  }
  if (item.status === "denied") parts.push(<span key="denied">Denied</span>);
  if (item.exitCode !== undefined && item.exitCode !== 0) {
    parts.push(<span key="exit">exit {item.exitCode}</span>);
  }
  if (item.endedAt !== undefined) {
    parts.push(<span key="time">{duration(item.endedAt - item.createdAt)}</span>);
  }
  return (
    <>
      {item.background && item.status === "running" && (
        <Badge variant="secondary" className="h-4.5 px-1.5 text-[10.5px]">
          background
        </Badge>
      )}
      {parts.length > 0 && (
        <TraceDescription className="flex items-center gap-1.5">
          {parts.map((part, index) => (
            <span key={index} className="contents">
              {index > 0 && <span aria-hidden>·</span>}
              {part}
            </span>
          ))}
        </TraceDescription>
      )}
    </>
  );
}

/** What opening a tool call shows, or nothing when there is nothing more to see. */
function toolDetail(item: ToolItem): ReactNode {
  const output = item.output.trim();
  switch (item.kind) {
    case "command": {
      const raw = inputField(item.input, "command");
      const command = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.join(" ") : "";
      // The title is the command's first line: show the whole of a longer one.
      const longer = command.trim() && command.trim() !== item.title.trim();
      if (!longer && !output) return null;
      return (
        <>
          {longer && <Code value={command} language="bash" title="Command" wrap />}
          {output && <Output value={item.output} />}
        </>
      );
    }
    case "edit":
      if (item.changes?.length) {
        return item.changes.map((change) => (
          <FileDiff key={`${change.path}:${change.kind}`} change={change} />
        ));
      }
      return output ? <Output value={item.output} /> : null;
    case "todo":
      return item.todos?.length ? <TodoList todos={item.todos} /> : null;
    case "plan":
      return output ? <Markdown text={output} className="text-[13px] text-foreground" /> : null;
    case "subagent":
      return <SubagentDetail item={item} output={output} />;
    case "read":
    case "search":
    case "web":
      return output ? <Output value={item.output} /> : null;
    case "mcp":
    case "other": {
      const input = formatInput(item.input);
      if (!input && !output) return null;
      return (
        <>
          {input && (
            <Code value={input} language="json" title="Input" wrap contentClassName="max-h-60" />
          )}
          {output && <Output value={item.output} />}
        </>
      );
    }
  }
}

function SubagentDetail({ item, output }: { item: ToolItem; output: string }) {
  const prompt = inputField(item.input, "prompt");
  return (
    <>
      {item.childThreadId && (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => item.childThreadId && openThread(item.childThreadId)}
        >
          Open the subagent's thread
          <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} data-icon="inline-end" />
        </Button>
      )}
      {typeof prompt === "string" && prompt.trim() && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">Task</span>
          <Markdown text={prompt} className="text-[13px]" />
        </div>
      )}
      {output && (
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium">Result</span>
          <Markdown text={output} className="text-[13px] text-foreground" />
        </div>
      )}
    </>
  );
}

export function TodoList({ todos }: { todos: readonly TodoEntry[] }) {
  return (
    <ul className="flex flex-col gap-1.5 text-[13px]">
      {todos.map((todo, index) => (
        // A plan's entries can repeat their words: the place is the identity.
        // oxlint-disable-next-line react/no-array-index-key
        <li key={index} className="flex items-start gap-2">
          <span
            aria-hidden
            className={cn(
              "mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border",
              todo.status === "completed" && "border-primary bg-primary text-primary-foreground",
              todo.status === "in_progress" && "border-primary",
            )}
          >
            {todo.status === "completed" && (
              <HugeiconsIcon icon={Tick02Icon} strokeWidth={2.5} className="size-2.5" />
            )}
            {todo.status === "in_progress" && <span className="size-1.5 rounded-full bg-primary" />}
          </span>
          <span
            className={cn(
              todo.status === "completed" && "text-muted-foreground line-through",
              todo.status === "in_progress" && "font-medium text-foreground",
            )}
          >
            {todo.text}
          </span>
          <span className="sr-only">
            {todo.status === "completed"
              ? "(done)"
              : todo.status === "in_progress"
                ? "(doing)"
                : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function inputField(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

function formatInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input === "object" && Object.keys(input).length === 0) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}
