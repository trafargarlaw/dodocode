// Where a thread's agent works: in the project's folder, on the branch it has checked out, or in
// a worktree of its own, on a new branch. It shows in the row under the composer: the picker
// until the work starts, then where it went and what it changed.

import { useEffect, useState, type ReactNode } from "react";
import type { Project, Thread, WorkChanges, WorkspaceMode } from "@dodocode/protocol";
import {
  ComputerIcon,
  GitBranchIcon,
  GitForkIcon,
  GitMergeIcon,
  VisualStudioCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@dodocode/ui/components/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@dodocode/ui/components/sheet";
import { Spinner } from "@dodocode/ui/components/spinner";
import { cn } from "@dodocode/ui/lib/utils";
import { Tip } from "../keys";
import { mergeWork, openThreadInEditor, threadChanges } from "../server/app-data";
import { changeCounts, FileDiff } from "./code";
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
}: {
  value: WorkspaceMode;
  onChange: (workspace: WorkspaceMode) => void;
  /** The branch the project's folder has checked out, when it has one. */
  branch: string | undefined;
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
            className={QUIET}
          />
        }
      >
        <HugeiconsIcon icon={mode.icon} strokeWidth={1.8} />
        <span className="truncate">{mode.label}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-72">
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
 * What the row under the composer says about where a thread works: at its start, the picker or
 * where the work went; at its end, the branch, which once the work started opens what changed.
 */
export function workspaceSlots({
  thread,
  project,
  mode,
  onModeChange,
}: {
  thread: Thread;
  project: Project | undefined;
  /** Where it will work, while that can still change. */
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
}): { where?: ReactNode; branch?: ReactNode } {
  const git = project?.git;
  if (!project || !git || thread.kind !== "main") return {};
  const worktree = thread.worktree;
  if (worktree?.mergedAt !== undefined) {
    const base = worktree.base ?? "its branch";
    return {
      where: (
        <Fact icon={GitMergeIcon} tip={`${worktree.branch} was merged, and its worktree removed`}>
          Merged into {base}
        </Fact>
      ),
    };
  }
  if (worktree || thread.startedAt !== undefined) {
    return {
      where: worktree ? (
        <Fact icon={GitForkIcon} tip={`In its own checkout, at ${worktree.path}`}>
          Worktree
        </Fact>
      ) : (
        <Fact icon={ComputerIcon} tip={`In ${project.name}'s folder`}>
          Current checkout
        </Fact>
      ),
      branch: <WorkspaceChip thread={thread} project={project} />,
    };
  }
  return {
    where: <WorkspacePicker value={mode} onChange={onModeChange} branch={git.branch} />,
    branch: <StartBranch branch={git.branch} mode={mode} />,
  };
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

/** The branch a started thread works on. It opens what the work changed, and the way to merge. */
function WorkspaceChip({ thread, project }: { thread: Thread; project: Project }) {
  const [open, setOpen] = useState(false);
  const worktree = thread.worktree;
  const label = worktree ? worktree.branch : (project.git?.branch ?? "Detached HEAD");
  const changed = worktree?.changed;
  return (
    <>
      <Tip
        side="top"
        label={
          worktree
            ? `On ${worktree.branch}. See what changed`
            : `On ${label}. See what isn't committed`
        }
      >
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Changes on ${label}`}
          className={QUIET}
          onClick={() => setOpen(true)}
        >
          <HugeiconsIcon icon={GitBranchIcon} strokeWidth={1.8} />
          <span className="truncate font-mono text-[11.5px]">{label}</span>
          {changed && changed.files > 0 && (
            <Counts added={changed.added} removed={changed.removed} />
          )}
        </Button>
      </Tip>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="w-full gap-0 data-[side=right]:w-[min(46rem,94vw)] data-[side=right]:sm:max-w-none">
          {open && <ChangesPanel thread={thread} project={project} branch={label} />}
        </SheetContent>
      </Sheet>
    </>
  );
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-[11.5px] tabular-nums">
      <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
      <span className="text-destructive">−{removed}</span>
    </span>
  );
}

function ChangesPanel({
  thread,
  project,
  branch,
}: {
  thread: Thread;
  project: Project;
  branch: string;
}) {
  const [state, setState] = useState<{ changes?: WorkChanges; error?: string }>({});
  const worktree = thread.worktree;

  // Read again when a turn starts or ends, the times its activity moves, so what shows is
  // what's there.
  useEffect(() => {
    let live = true;
    threadChanges(thread.id).then(
      (changes) => live && setState({ changes }),
      (error: unknown) =>
        live && setState({ error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the reason to read again
  }, [thread.id, thread.activityAt]);

  const files = state.changes?.files ?? [];
  const counts = changeCounts(files);

  return (
    <>
      <SheetHeader className="border-b pr-12">
        <SheetTitle>{worktree ? "What this work changed" : "What isn't committed"}</SheetTitle>
        <SheetDescription>
          {worktree
            ? `On ${worktree.branch}, against ${worktree.base ?? "the commit it started from"}. Commits and edits not yet committed both count.`
            : `In ${project.name}, on ${branch}. This thread works in the project's folder, so your own edits show here too.`}
        </SheetDescription>
        {worktree && (
          <p
            className="truncate pt-1 font-mono text-[11.5px] text-muted-foreground"
            title={worktree.path}
          >
            {worktree.path}
          </p>
        )}
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.error ? (
          <p className="p-4 text-[13px] text-destructive">{state.error}</p>
        ) : !state.changes ? (
          <div className="grid h-40 place-items-center">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : files.length === 0 ? (
          <p className="p-4 text-[13px] text-muted-foreground">Nothing has changed yet.</p>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            <p className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
              {files.length} {files.length === 1 ? "file" : "files"}
              <Counts added={counts.added} removed={counts.removed} />
            </p>
            {state.changes.truncated && (
              <p className="rounded-lg border bg-muted/40 px-3 py-2 text-[12.5px] text-muted-foreground">
                Some of it is too large to show here. Open the folder in VS Code to see all of it.
              </p>
            )}
            {files.map((change) => (
              <FileDiff key={`${change.path}:${change.kind}`} change={change} />
            ))}
          </div>
        )}
      </div>
      <SheetFooter className="flex-row items-center justify-end border-t">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => openThreadInEditor(thread.id)}
        >
          <HugeiconsIcon icon={VisualStudioCodeIcon} strokeWidth={1.8} />
          Open in VS Code
        </Button>
        {worktree?.base && (
          <MergeButton thread={thread} disabled={files.length === 0 && !!state.changes} />
        )}
      </SheetFooter>
    </>
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
