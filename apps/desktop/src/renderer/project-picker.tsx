import type { Project } from "@dodocode/protocol";
import { Folder01Icon, FolderAddIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@dodocode/ui/components/select";
import { cn } from "@dodocode/ui/lib/utils";
import { addProject } from "./server/app-data";

const NONE = "none";
const ADD = "add-project";

/**
 * Picks one of the projects, or none when `none` names that choice ("No project", "All
 * projects"). Adding a project from it picks the new one.
 */
export function ProjectPicker({
  value,
  onChange,
  projects,
  none,
  side = "bottom",
  className,
}: {
  /** The project's id, or `null` for none. */
  value: string | null;
  onChange: (projectId: string | null) => void;
  projects: Project[];
  none?: string;
  side?: "top" | "bottom";
  className?: string;
}) {
  const items = [
    ...(none ? [{ value: NONE, label: none }] : []),
    ...projects.map((project) => ({ value: project.id, label: project.name })),
    { value: ADD, label: "Add a project…" },
  ];
  return (
    <Select
      value={value ?? NONE}
      items={items}
      onValueChange={(next) => {
        if (next === ADD) {
          void addProject().then((project) => project && onChange(project.id));
        } else if (next) {
          onChange(next === NONE ? null : next);
        }
      }}
    >
      <SelectTrigger size="sm" aria-label="Project" className={cn("gap-1.5", className)}>
        <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.8} className="size-3.5" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent side={side} align="start" alignItemWithTrigger={false} className="min-w-52">
        {none && <SelectItem value={NONE}>{none}</SelectItem>}
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id} title={project.path}>
            {project.name}
          </SelectItem>
        ))}
        {(none || projects.length > 0) && <SelectSeparator />}
        <SelectItem value={ADD} className="text-muted-foreground">
          <HugeiconsIcon icon={FolderAddIcon} strokeWidth={1.8} />
          Add a project…
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
