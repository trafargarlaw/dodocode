import { useAppHotkeys } from "@tanstack/react-hotkeys";
import { useLiveQuery } from "@tanstack/react-db";
import {
  Folder01Icon,
  FolderAddIcon,
  KanbanIcon,
  PencilEdit02Icon,
  UserMultiple02Icon,
  VisualStudioCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@dodocode/ui/components/command";
import { Keys } from "./keys";
import { searchScore } from "./search-match";
import { addProject, openInEditor, projects, threads } from "./server/app-data";
import { ago, useNow } from "./time";
import { GROUP_LABEL } from "./task-list";
import { openBoard, openThread, useView } from "./view";

/** Search the threads and projects, and run the app's actions, from the keyboard. */
export function SearchDialog({
  open,
  onOpenChange,
  onNewThread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNewThread: (projectId?: string) => void;
}) {
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search"
      description="Search threads and projects, or run an action"
      className="sm:max-w-xl"
    >
      {/* Mounted only while open, so its queries and its clock run only then. */}
      {open && <SearchContent close={() => onOpenChange(false)} onNewThread={onNewThread} />}
    </CommandDialog>
  );
}

function SearchContent({
  close,
  onNewThread,
}: {
  close: () => void;
  onNewThread: (projectId?: string) => void;
}) {
  const hotkeys = useAppHotkeys();
  const view = useView();
  const now = useNow();
  const { data: projectList = [] } = useLiveQuery({
    query: (q) => q.from({ project: projects }).orderBy(({ project }) => project.createdAt, "asc"),
  });
  const { data: threadList = [] } = useLiveQuery({
    query: (q) => q.from({ thread: threads }).orderBy(({ thread }) => thread.activityAt, "desc"),
  });
  const names = new Map(projectList.map((project) => [project.id, project.name]));
  const openId = view.kind === "thread" ? view.threadId : undefined;
  const current = threadList.find((thread) => thread.id === openId);
  const currentProject = projectList.find((project) => project.id === current?.projectId);
  const newThreadKeys = hotkeys["thread.new"].hotkey;
  const boardKeys = hotkeys["board.open"].hotkey;

  const run = (action: () => void) => () => {
    close();
    action();
  };

  return (
    <Command filter={(_value, search, keywords) => searchScore(keywords ?? [], search)} loop>
      <CommandInput placeholder="Search threads and projects, or run an action" />
      <CommandList className="max-h-[min(60vh,28rem)]">
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem
            value="action:new-thread"
            keywords={["New thread", "start", "create"]}
            onSelect={run(() => onNewThread(current?.projectId))}
          >
            <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={1.8} />
            New thread
            {newThreadKeys && (
              <CommandShortcut>
                <Keys hotkey={newThreadKeys} />
              </CommandShortcut>
            )}
          </CommandItem>
          <CommandItem
            value="action:open-board"
            keywords={["Open the board", "board", "tasks", "kanban", "to do"]}
            onSelect={run(openBoard)}
          >
            <HugeiconsIcon icon={KanbanIcon} strokeWidth={1.8} />
            Open the board
            {boardKeys && (
              <CommandShortcut>
                <Keys hotkey={boardKeys} />
              </CommandShortcut>
            )}
          </CommandItem>
          <CommandItem
            value="action:add-project"
            keywords={["Add a project", "folder", "open"]}
            onSelect={run(() => {
              void addProject().then((project) => project && onNewThread(project.id));
            })}
          >
            <HugeiconsIcon icon={FolderAddIcon} strokeWidth={1.8} />
            Add a project
          </CommandItem>
          {currentProject && (
            <CommandItem
              value="action:open-in-editor"
              keywords={["Open in VS Code", "editor", "code", currentProject.name]}
              onSelect={run(() => openInEditor(currentProject.id))}
            >
              <HugeiconsIcon icon={VisualStudioCodeIcon} strokeWidth={1.8} />
              Open {currentProject.name} in VS Code
            </CommandItem>
          )}
        </CommandGroup>
        {threadList.length > 0 && (
          <CommandGroup heading="Threads">
            {threadList.map((thread) => {
              const project = (thread.projectId && names.get(thread.projectId)) ?? "";
              const place = thread.archived ? `Archived${project ? ` · ${project}` : ""}` : project;
              return (
                <CommandItem
                  key={thread.id}
                  value={`thread:${thread.id}`}
                  keywords={[
                    thread.title,
                    project,
                    ...(thread.task ? [GROUP_LABEL[thread.task.status]] : []),
                  ]}
                  onSelect={run(() => openThread(thread.id))}
                >
                  {thread.kind === "subagent" && (
                    <HugeiconsIcon icon={UserMultiple02Icon} strokeWidth={1.8} />
                  )}
                  <span className="min-w-0 truncate">{thread.title}</span>
                  {/* Grows rather than pushing with ml-auto: the item's hidden check icon has
                      ml-auto too, and two would split the space and float the time mid-row. */}
                  <span className="shrink-0 grow text-muted-foreground">{place}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {ago(thread.activityAt, now)}
                  </span>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        {projectList.length > 0 && (
          <CommandGroup heading="Projects">
            {projectList.map((project) => (
              <CommandItem
                key={project.id}
                value={`project:${project.id}`}
                keywords={[project.name, project.path]}
                onSelect={run(() => onNewThread(project.id))}
              >
                <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.8} />
                {/* The name keeps its room and the path gives way, so a deep folder can't hide it. */}
                <span className="max-w-2/3 shrink-0 truncate">New thread in {project.name}</span>
                <span className="min-w-0 grow truncate text-xs text-muted-foreground">
                  {project.path}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  );
}
