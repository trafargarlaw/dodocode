// The small pieces that show a thread's place and state the same way everywhere: in the sidebar,
// on the board and in the thread's header.

import type { ReactNode } from "react";
import { unstarted, type Thread } from "@dodocode/protocol";
import { Message01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@dodocode/ui/components/dropdown-menu";
import { Spinner } from "@dodocode/ui/components/spinner";
import { cn } from "@dodocode/ui/lib/utils";
import { moveTask, placeTask } from "./server/app-data";
import { COLUMNS, GROUP_LABEL, type GroupId } from "./task-list";

const FILLED: Record<Exclude<GroupId, "chats">, number> = {
  todo: 0,
  progress: 0.5,
  review: 0.75,
  done: 1,
};

const COLOR: Record<GroupId, string> = {
  todo: "text-muted-foreground",
  progress: "text-amber-600 dark:text-amber-400",
  review: "text-violet-600 dark:text-violet-400",
  done: "text-emerald-600 dark:text-emerald-400",
  chats: "text-muted-foreground",
};

/** A ring that fills as the task goes from To do to Done, or a bubble for a chat. */
export function StatusGlyph({ status, className }: { status: GroupId; className?: string }) {
  if (status === "chats") {
    return (
      <HugeiconsIcon
        icon={Message01Icon}
        strokeWidth={1.8}
        aria-hidden
        className={cn("size-3.5 shrink-0", COLOR.chats, className)}
      />
    );
  }
  const filled = FILLED[status];
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden
      className={cn("size-3.5 shrink-0", COLOR[status], className)}
    >
      <circle
        cx="7"
        cy="7"
        r="5.75"
        fill={filled === 1 ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={filled === 0 ? "2.2 1.6" : undefined}
      />
      {filled > 0 && filled < 1 && <path d={pie(filled)} fill="currentColor" />}
      {filled === 1 && (
        <path
          d="M4.4 7.2 6.2 9 9.6 5.4"
          fill="none"
          stroke="var(--background)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/** A slice of the inner circle, clockwise from the top. */
function pie(share: number): string {
  const r = 3.25;
  const angle = share * 2 * Math.PI;
  const x = 7 + r * Math.sin(angle);
  const y = 7 - r * Math.cos(angle);
  return `M7 7 L7 ${7 - r} A${r} ${r} 0 ${share > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)} Z`;
}

/**
 * Running, waiting for the person, or stopped by an error. An idle thread shows nothing, or
 * `idle` when given.
 */
export function Attention({
  thread,
  idle,
  className,
}: {
  thread: Thread;
  idle?: ReactNode;
  /** The spinner's colour, where muted text is another colour. */
  className?: string;
}) {
  if (thread.status === "running") {
    return (
      <Spinner aria-label="Running" className={cn("size-3.5 text-muted-foreground", className)} />
    );
  }
  if (thread.status === "waiting") {
    return (
      <span className="grid size-3.5 place-items-center">
        <span aria-hidden className="size-2 rounded-full bg-amber-500 ring-3 ring-amber-500/25" />
        <span className="sr-only">Waiting for you</span>
      </span>
    );
  }
  if (thread.status === "error") {
    return (
      <span className="grid size-3.5 place-items-center">
        <span aria-hidden className="size-2 rounded-full bg-destructive" />
        <span className="sr-only">Stopped by an error</span>
      </span>
    );
  }
  return idle ?? null;
}

/**
 * Menu items that put a thread in a column of the board, and a task back to a chat. One nobody
 * started can't go back: it has no chat yet.
 */
export function MoveItems({ thread }: { thread: Thread }) {
  const current = thread.task?.status;
  return (
    <>
      {COLUMNS.map((status) => (
        <DropdownMenuItem
          key={status}
          disabled={status === current}
          onClick={() => void placeTask(thread, status, status === "done")}
        >
          <StatusGlyph status={status} />
          {status === "progress" && unstarted(thread) ? "Start" : GROUP_LABEL[status]}
          {status === current && (
            <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} className="ml-auto" />
          )}
        </DropdownMenuItem>
      ))}
      {thread.task && !unstarted(thread) && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => void moveTask(thread, null, true)}>
            <StatusGlyph status="chats" />
            Make it a chat
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
