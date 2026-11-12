import { useState, type RefObject } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { ThreadSettings, WorkspaceMode } from "@dodocode/protocol";
import { Spinner } from "@dodocode/ui/components/spinner";
import { toast } from "@dodocode/ui/components/toast";
import { useListFilter } from "../list-filter";
import { ProjectPicker } from "../project-picker";
import {
  createTask,
  createThread,
  projects,
  settings as settingsRows,
  threads,
} from "../server/app-data";
import { openDraft, openThread, setChoosingProject, useChoosingProject } from "../view";
import { Composer } from "./composer";
import { StartBranch, WorkspacePicker } from "./workspace";

/** The words of a new thread wait under this key until it is started. */
export const DRAFT_KEY = "draft";

/** Settings picked for the next new thread. Kept while the window shows other threads. */
let picked: ThreadSettings | undefined;
/** Where the next new thread works, when the person picked. A question asked runs in place. */
let pickedWorkspace: WorkspaceMode | undefined;

/**
 * A new thread: ask anything and it starts as a chat, or put it in To do as a task to start
 * later. A chat can work without a project, in a folder of its own.
 */
export function DraftView({
  projectId,
  inputRef,
}: {
  /** The project picked, `null` for none, or unset for the usual one. */
  projectId: string | null | undefined;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const filter = useListFilter();
  const choosing = useChoosingProject();
  const { data: projectList = [], isReady } = useLiveQuery({
    query: (q) => q.from({ project: projects }).orderBy(({ project }) => project.createdAt, "asc"),
  });
  // The same query as the sidebar's, so the two share one result.
  const { data: threadList = [] } = useLiveQuery({
    query: (q) => q.from({ thread: threads }).orderBy(({ thread }) => thread.activityAt, "desc"),
  });
  const { data: saved } = useLiveQuery({
    query: (q) => q.from({ row: settingsRows }).findOne(),
  });
  const [chosen, setChosen] = useState(picked);
  const [chosenWorkspace, setChosenWorkspace] = useState(pickedWorkspace);
  const settings = chosen ?? saved?.defaults;

  const known = (id: string | null | undefined) =>
    id ? projectList.find((entry) => entry.id === id) : undefined;
  // The usual project: the filter's, or the one worked in last.
  const usual =
    known(filter.projectId) ?? (threadList[0] ? known(threadList[0].projectId) : projectList[0]);
  const project = projectId === null ? undefined : (known(projectId) ?? usual);

  if (!isReady || !settings) {
    return (
      <div className="grid h-full place-items-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  const choose = (next: ThreadSettings) => {
    picked = next;
    setChosen(next);
  };
  const chooseWorkspace = (next: WorkspaceMode) => {
    pickedWorkspace = next;
    setChosenWorkspace(next);
  };
  // Only a project in a git repository has a branch to work apart from.
  const git = project?.git;
  const workspace: WorkspaceMode = git ? (chosenWorkspace ?? "local") : "local";

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      {/* The project the new thread works in, where a thread shows its own. */}
      <header className="flex h-11 min-w-0 items-center gap-2 border-b px-3">
        <ProjectPicker
          value={project?.id ?? null}
          onChange={(next) => openDraft(next)}
          projects={projectList}
          none="No project"
          // Asked when a new thread opens: once answered, or let be, the message comes next.
          open={choosing}
          onOpenChange={setChoosingProject}
          finalFocus={inputRef}
          className="h-7 px-2 text-[13px] font-medium"
        />
      </header>
      <div className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto_minmax(0,1.1fr)] px-5">
        <div />
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
          <h1 className="px-1 text-xl font-semibold tracking-tight">
            Ask anything, or start some work
          </h1>
          <Composer
            draftKey={DRAFT_KEY}
            projectId={project?.id}
            settings={settings}
            onSettingsChange={choose}
            running={false}
            placeholder="Ask a question, or describe the work. Paste or drop screenshots."
            inputRef={inputRef}
            focusOnMount={!choosing}
            where={
              git && (
                <WorkspacePicker value={workspace} onChange={chooseWorkspace} branch={git.branch} />
              )
            }
            branch={git && <StartBranch branch={git.branch} mode={workspace} />}
            alternate={{
              label: "Add to To do",
              blocked: project ? undefined : "Pick a project to add a task: a task works in one",
              onSend: async (message) => {
                if (!project) return false;
                // A task left in To do works where tasks usually start, unless the person picked.
                const task = await createTask(
                  project.id,
                  message,
                  settings,
                  git ? chosenWorkspace : undefined,
                );
                if (!task) return false;
                const id = toast.add({
                  title: "Added to To do",
                  description: task.title,
                  actionProps: {
                    children: "Open",
                    onClick: () => {
                      toast.close(id);
                      openThread(task.id);
                    },
                  },
                });
                return true;
              },
            }}
            onSend={async (message) => {
              const thread = await createThread(
                project?.id,
                settings,
                message,
                workspace === "worktree" ? "worktree" : undefined,
              );
              if (!thread) return false;
              // The server keeps these as the defaults for the next thread. The next question asked
              // runs in place again.
              picked = undefined;
              pickedWorkspace = undefined;
              openThread(thread.id);
              return true;
            }}
          />
        </div>
      </div>
    </div>
  );
}
