import { useRef, useState, type RefObject } from "react";
import type { Project } from "@dodocode/protocol";
import {
  ArrowRight01Icon,
  Folder01Icon,
  FolderAddIcon,
  GitBranchIcon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Command as CommandPrimitive } from "cmdk";
import { Button } from "@dodocode/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@dodocode/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@dodocode/ui/components/popover";
import { cn } from "@dodocode/ui/lib/utils";
import { openPalette } from "./palette/palette";
import { searchScore } from "./search-match";

const NONE = "none";
const ADD = "add-project";

/**
 * Picks one of the projects, or none when `none` names that choice ("No project", "All
 * projects"). Adding a project from it opens the palette's ways to add one, and picks the new one.
 */
export function ProjectPicker({
  value,
  onChange,
  projects,
  none,
  side = "bottom",
  open: openProp,
  onOpenChange,
  finalFocus,
  className,
}: {
  /** The project's id, or `null` for none. */
  value: string | null;
  onChange: (projectId: string | null) => void;
  projects: Project[];
  none?: string;
  side?: "top" | "bottom";
  /** Open from outside, as well as by its button. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Where focus goes once it closes, rather than back to its button. */
  finalFocus?: RefObject<HTMLElement | null>;
  className?: string;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = openProp ?? ownOpen;
  // Set while it closes to let the palette add a project: focus stays in the palette.
  const adding = useRef(false);
  const setOpen = (next: boolean) => {
    if (next) adding.current = false;
    setOwnOpen(next);
    onOpenChange?.(next);
  };
  const current = projects.find((project) => project.id === value);
  const label = current?.name ?? none ?? "Pick a project";
  const pick = (projectId: string | null) => {
    setOpen(false);
    onChange(projectId);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Project: ${label}`}
            className={cn("max-w-64 min-w-0 gap-1.5 font-normal", className)}
          />
        }
      >
        <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.8} className="size-3.5" />
        <span className="min-w-0 truncate">{label}</span>
        <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={1.8} className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align="start"
        finalFocus={() => (adding.current ? false : (finalFocus?.current ?? true))}
        className="w-84 gap-0 overflow-hidden rounded-xl p-0 shadow-lg"
      >
        <Command
          filter={(_value, search, keywords) => searchScore(keywords ?? [], search)}
          loop
          defaultValue={value ?? NONE}
          className="rounded-none! p-0"
        >
          <div className="border-b px-3">
            <CommandPrimitive.Input
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened to pick from, by typing too.
              autoFocus
              placeholder="Find a project…"
              className="h-9.5 w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            />
          </div>
          <CommandList className="max-h-80 p-1">
            <CommandEmpty className="py-4 text-[12.5px] text-muted-foreground">
              No project has that name.
            </CommandEmpty>
            <CommandGroup className="p-0">
              {none && (
                <CommandItem
                  value={NONE}
                  keywords={[none]}
                  data-checked={value === null}
                  onSelect={() => pick(null)}
                  className="h-8"
                >
                  <span className="grid size-4 place-items-center text-muted-foreground">–</span>
                  {none}
                </CommandItem>
              )}
              {projects.map((project) => (
                <CommandItem
                  key={project.id}
                  value={project.id}
                  keywords={[project.name, project.path]}
                  data-checked={project.id === value}
                  onSelect={() => pick(project.id)}
                  className="items-start gap-2.5 py-1.5"
                >
                  <HugeiconsIcon
                    icon={Folder01Icon}
                    strokeWidth={1.8}
                    className="mt-0.5 text-muted-foreground"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-[13px] text-foreground">
                        {project.name}
                      </span>
                      {project.git?.branch && (
                        <span className="inline-flex min-w-0 shrink items-center gap-1 text-[11px] text-muted-foreground">
                          <HugeiconsIcon
                            icon={GitBranchIcon}
                            strokeWidth={1.8}
                            className="size-3"
                          />
                          <span className="truncate">{project.git.branch}</span>
                        </span>
                      )}
                    </span>
                    {/* Cut from the start, so the end of the path, which tells projects apart,
                        stays in view. */}
                    <span
                      dir="rtl"
                      className="truncate text-left text-[11.5px] text-muted-foreground"
                    >
                      <bdi dir="ltr">{project.path}</bdi>
                    </span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator className="mx-0 my-1" />
            <CommandGroup className="p-0" forceMount>
              <CommandItem
                value={ADD}
                forceMount
                onSelect={() => {
                  adding.current = true;
                  setOpen(false);
                  openPalette("add-project", { onAdded: (project) => onChange(project.id) });
                }}
                className="h-8"
              >
                <HugeiconsIcon icon={FolderAddIcon} strokeWidth={1.8} />
                Add a project…
                <CommandShortcut>
                  <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-3.5" />
                </CommandShortcut>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
