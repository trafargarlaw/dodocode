// Where a thread's agent works: in the project's folder, on the branch it has checked out, or in
// a worktree of its own, on a new branch. It shows in the row under the composer, and in the
// thread's details: the picker until the work starts, then where it went and what it changed.
// What it changed shows in full in the panel beside the conversation.

import { useState, type ReactNode } from "react";
import type { Project, Thread, WorkRepo, WorkspaceMode, Worktree } from "@dodocode/protocol";
import { ComputerIcon, GitBranchIcon, GitForkIcon, GitMergeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@dodocode/ui/components/dropdown-menu";
import { Spinner } from "@dodocode/ui/components/spinner";
import { cn } from "@dodocode/ui/lib/utils";
import { Tip } from "../keys";
import { mergeWork } from "../server/app-data";
import { useChangeCount } from "./change-count";
import { QUIET } from "./pickers";

const MODE: Record<WorkspaceMode, { label: string; icon: typeof GitForkIcon }> = {
  local: { label: "Current checkout", icon: ComputerIcon },
  worktree: { label: "New worktree", icon: GitForkIcon },
};

/** Picks where the work will happen, for a project in a git repository. */
export function WorkspacePicker({
  value,
  onChange,
  branch,
  className = QUIET,
  side = "top",
}: {
  value: WorkspaceMode;
  onChange: (workspace: WorkspaceMode) => void;
  /** The branch the project's folder has checked out, when it has one. */
  branch: string | undefined;
  /** The trigger's look: quiet under the composer unless given. */
  className?: string;
  side?: "top" | "bottom";
}) {
  const current = branch ?? "the commit checked out";
  const description: Record<WorkspaceMode, string> = {
    local: `Works in the project's folder, on ${current}.`,
    worktree: `Works in a separate checkout, on a new branch from ${current}. Your folder stays as it is.`,
  };
  const mode = MODE[value];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Where it works: ${mode.label}`}
            className={className}
          />
        }
      >
        <HugeiconsIcon icon={mode.icon} strokeWidth={1.8} />
        <span className="truncate">{mode.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align="start" className="w-72">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next: WorkspaceMode) => onChange(next)}
        >
          {(["local", "worktree"] as const).map((option) => (
            <DropdownMenuRadioItem key={option} value={option} closeOnClick>
              <span className="flex min-w-0 flex-col">
                <span>{MODE[option].label}</span>
                <span className="text-xs whitespace-normal text-muted-foreground">
                  {description[option]}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A fact in the row under the composer, which can't be changed from there. */
function Fact({
  icon,
  tip,
  children,
}: {
  icon: typeof GitForkIcon;
  tip: string;
  children: ReactNode;
}) {
  return (
    <Tip label={tip} side="top">
      <span
        className={cn(
          QUIET,
          "inline-flex items-center hover:bg-transparent hover:text-muted-foreground",
        )}
      >
        <HugeiconsIcon icon={icon} strokeWidth={1.8} />
        <span className="truncate">{children}</span>
      </span>
    </Tip>
  );
}

/**
 * Where a thread works, as the composer's row and the thread's details show it. A thread
 * without a project, a subagent, and one in a folder outside git have nothing to show.
 */
export type WorkPlace =
  /** Brought in from another app, which worked in a checkout of its own, such as a worktree. */
  | { kind: "other"; app: string; checkout: { path: string; branch?: string } }
  /** Its worktree's branch was merged, and the worktree removed. */
  | { kind: "merged"; worktree: Worktree }
  | { kind: "worktree"; worktree: Worktree }
  /** In the project's folder, on the branch it has checked out. */
  | { kind: "folder" }
  /** Not started: where it works can still change. `branch` is the folder's. */
  | { kind: "choosing"; branch: string | undefined };

export function workPlace(thread: Thread, project: Project | undefined): WorkPlace | undefined {
  if (!project || thread.kind !== "main") return undefined;
  const origin = thread.origin;
  if (origin?.checkout) return { kind: "other", app: origin.app, checkout: origin.checkout };
  const git = project.git;
  if (!git) return undefined;
  const worktree = thread.worktree;
  if (worktree?.mergedAt !== undefined) return { kind: "merged", worktree };
  if (worktree) return { kind: "worktree", worktree };
  if (thread.startedAt !== undefined) return { kind: "folder" };
  return { kind: "choosing", branch: git.branch };
}

/** Whether the work started in a checkout that's still there, so what it changed can be read. */
export function changesToShow(place: WorkPlace | undefined): boolean {
  return place?.kind === "worktree" || place?.kind === "folder" || place?.kind === "other";
}

/** The branch a started thread works on, as the person knows it. */
export function branchLabel(thread: Thread, project: Project): string {
  if (thread.worktree) return thread.worktree.branch;
  return ownRepo(thread, project)?.branch ?? fallbackBranch(thread, project) ?? "Detached HEAD";
}

/**
 * The repository the thread works in, as the server last read it. The server lists it first,
 * when its folder is in one: a checkout another app worked in, or the project's.
 */
export function ownRepo(thread: Thread, project: Project): WorkRepo | undefined {
  const inRepo = thread.origin ? thread.origin.checkout && !thread.origin.folderGone : project.git;
  return inRepo ? thread.repos?.[0] : undefined;
}

/** The branch as it was known before the server read the repository. */
function fallbackBranch(thread: Thread, project: Project): string | undefined {
  const checkout = thread.origin?.checkout;
  return checkout ? checkout.branch : project.git?.branch;
}

/**
 * What the row under the composer says about where a thread works: at its start, the picker or
 * where the work went; at its end, the branch, which once the work started opens what changed.
 */
export function workspaceSlots({
  thread,
  project,
  mode,
  onModeChange,
  onShowChanges,
}: {
  thread: Thread;
  project: Project | undefined;
  /** Where it will work, while that can still change. */
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  /** Shows what the work changed, beside the conversation. */
  onShowChanges: () => void;
}): { where?: ReactNode; branch?: ReactNode } {
  const place = workPlace(thread, project);
  if (!place || !project) return {};
  switch (place.kind) {
    case "other":
      return {
        where: (
          <Fact icon={GitForkIcon} tip={`Where it worked in ${place.app}: ${place.checkout.path}`}>
            Other checkout
          </Fact>
        ),
        branch: <WorkspaceChip thread={thread} project={project} onShowChanges={onShowChanges} />,
      };
    case "merged":
      return {
        where: (
          <Fact
            icon={GitMergeIcon}
            tip={`${place.worktree.branch} was merged, and its worktree removed`}
          >
            Merged into {place.worktree.base ?? "its branch"}
          </Fact>
        ),
      };
    case "worktree":
      return {
        where: (
          <Fact icon={GitForkIcon} tip={`In its own checkout, at ${place.worktree.path}`}>
            Worktree
          </Fact>
        ),
        branch: <WorkspaceChip thread={thread} project={project} onShowChanges={onShowChanges} />,
      };
    case "folder":
      return {
        where: (
          <Fact icon={ComputerIcon} tip={`In ${project.name}'s folder`}>
            Current checkout
          </Fact>
        ),
        branch: <WorkspaceChip thread={thread} project={project} onShowChanges={onShowChanges} />,
      };
    case "choosing":
      return {
        where: <WorkspacePicker value={mode} onChange={onModeChange} branch={place.branch} />,
        branch: <StartBranch branch={place.branch} mode={mode} />,
      };
  }
}

/** The branch work that hasn't started will be on: the folder's, or a new one from it. */
export function StartBranch({ branch, mode }: { branch: string | undefined; mode: WorkspaceMode }) {
  const from = branch ?? "the commit checked out";
  return (
    <Fact
      icon={GitBranchIcon}
      tip={mode === "worktree" ? `Its branch starts from ${from}` : `It works on ${from}`}
    >
      <span className="font-mono text-[11.5px]">{mode === "worktree" ? `from ${from}` : from}</span>
    </Fact>
  );
}

/** The branch a started thread works on, and how much its work changed, which it shows. */
function WorkspaceChip({
  thread,
  project,
  onShowChanges,
}: {
  thread: Thread;
  project: Project;
  onShowChanges: () => void;
}) {
  const label = branchLabel(thread, project);
  const changed = useChangeCount(thread.id, thread.activityAt) ?? thread.worktree?.changed;
  const pr = ownRepo(thread, project)?.pr;
  return (
    <Tip
      side="top"
      label={
        pr
          ? `On ${label}, #${pr.number}: ${pr.title}. See what changed`
          : `On ${label}. See what changed`
      }
    >
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Changes on ${label}`}
        className={QUIET}
        onClick={onShowChanges}
      >
        <HugeiconsIcon icon={GitBranchIcon} strokeWidth={1.8} />
        <span className="truncate font-mono text-[11.5px]">{label}</span>
        {pr && <span className="shrink-0 text-[11.5px] tabular-nums">#{pr.number}</span>}
        {changed && changed.files > 0 && <Counts added={changed.added} removed={changed.removed} />}
      </Button>
    </Tip>
  );
}

/** Line counts, grouped with commas: a space between groups reads as two numbers. */
const LINES = new Intl.NumberFormat("en-US");

export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{LINES.format(added)}</span>{" "}
      <span className="text-destructive">−{LINES.format(removed)}</span>
    </span>
  );
}

/** Merges a worktree's branch into the branch it came from. */
export function MergeButton({
  thread,
  disabled,
  className,
}: {
  thread: Thread;
  disabled?: boolean;
  className?: string;
}) {
  const [merging, setMerging] = useState(false);
  const base = thread.worktree?.base;
  if (!base) return null;
  const running = thread.status === "running" || thread.status === "waiting";
  const blocked = running
    ? "The agent is still working"
    : disabled
      ? "Nothing to merge yet"
      : undefined;
  return (
    <Tip
      label={
        blocked ??
        `Commit what it left, merge ${thread.worktree?.branch} into ${base}, and remove the worktree`
      }
    >
      <span className="inline-flex">
        <Button
          size="sm"
          className={cn("gap-1.5", className)}
          disabled={merging || blocked !== undefined}
          onClick={() => {
            setMerging(true);
            void mergeWork(thread).finally(() => setMerging(false));
          }}
        >
          {merging ? (
            <Spinner className="size-3.5" />
          ) : (
            <HugeiconsIcon icon={GitMergeIcon} strokeWidth={1.8} />
          )}
          Merge into {base}
        </Button>
      </span>
    </Tip>
  );
}
