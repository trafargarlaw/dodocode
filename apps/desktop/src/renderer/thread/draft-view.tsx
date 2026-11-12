import { useState, type Ref } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { ThreadSettings } from "@dodocode/protocol";
import { Spinner } from "@dodocode/ui/components/spinner";
import { toast } from "@dodocode/ui/components/toast";
import { cn } from "@dodocode/ui/lib/utils";
import { useListFilter } from "../list-filter";
import { ProjectPicker } from "../project-picker";
import {
  createTask,
  createThread,
  projects,
  settings as settingsRows,
  threads,
} from "../server/app-data";
import { openDraft, openThread } from "../view";
import { Composer, PICKER } from "./composer";

/** The words of a new thread wait under this key until it is started. */
export const DRAFT_KEY = "draft";

/** Settings picked for the next new thread. Kept while the window shows other threads. */
let picked: ThreadSettings | undefined;

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
  inputRef: Ref<HTMLTextAreaElement>;
}) {
  const filter = useListFilter();
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

  return (
    <div className="grid h-full grid-rows-[minmax(0,1fr)_auto_minmax(0,1.4fr)] px-5">
      <div />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <div className="flex flex-col gap-1 px-1">
          <h1 className="text-xl font-semibold tracking-tight">Ask anything, or start some work</h1>
          <p className="text-[13px] text-muted-foreground">
            {project
              ? `It works in ${project.name}. Add it to To do to start it later.`
              : "Without a project, it works in a folder of its own."}
          </p>
        </div>
        <Composer
          draftKey={DRAFT_KEY}
          settings={settings}
          onSettingsChange={choose}
          running={false}
          placeholder="Ask a question, or describe the work. Paste or drop screenshots."
          inputRef={inputRef}
          focusOnMount
          leading={
            <ProjectPicker
              value={project?.id ?? null}
              onChange={(next) => openDraft(next)}
              projects={projectList}
              none="No project"
              side="top"
              className={cn(PICKER, "text-foreground")}
            />
          }
          alternate={{
            label: "Add to To do",
            blocked: project ? undefined : "Pick a project to add a task: a task works in one",
            onSend: async (message) => {
              if (!project) return false;
              const task = await createTask(project.id, message, settings);
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
            const thread = await createThread(project?.id, settings, message);
            if (!thread) return false;
            // The server keeps these as the defaults for the next thread.
            picked = undefined;
            openThread(thread.id);
            return true;
          }}
        />
      </div>
    </div>
  );
}
