// How tasks get reviewed, set from the board: by themselves as they reach In review or not, by
// which model, and, per project, by which Markdown file.

import { useState } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { Project, ReviewSettings, ThreadSettings } from "@dodocode/protocol";
import { InspectCodeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import { Input } from "@dodocode/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@dodocode/ui/components/popover";
import { Switch } from "@dodocode/ui/components/switch";
import { cn } from "@dodocode/ui/lib/utils";
import { Tip } from "./keys";
import { ProjectPicker } from "./project-picker";
import {
  providers,
  setReviewInstructions,
  setReviewSettings,
  settings as settingsRows,
} from "./server/app-data";
import { ModelPicker } from "./thread/model-picker";

const OFF: ReviewSettings = { auto: false };

export function ReviewSettingsButton({
  projects,
  projectId,
}: {
  projects: Project[];
  /** The project the board shows, which the settings start on. */
  projectId: string | undefined;
}) {
  const { data: saved } = useLiveQuery({
    query: (q) => q.from({ row: settingsRows }).findOne(),
  });
  const review = saved?.review ?? OFF;

  return (
    <Popover>
      <Tip label="How tasks get reviewed">
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-[12.5px] font-normal text-muted-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
            />
          }
        >
          <HugeiconsIcon icon={InspectCodeIcon} strokeWidth={1.8} />
          Reviews
          <span className="text-[12px] text-muted-foreground">
            {review.auto ? "Auto" : "Manual"}
          </span>
        </PopoverTrigger>
      </Tip>
      <PopoverContent align="end" sideOffset={6} className="w-96 gap-0 p-0">
        <div className="flex items-start gap-3 p-3">
          <label htmlFor="auto-review" className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] font-medium">Review tasks when they reach In review</span>
            <span className="text-[12px] text-muted-foreground">
              Once per task, the first time it gets there. A task's Review button starts one any
              time.
            </span>
          </label>
          <Switch
            id="auto-review"
            checked={review.auto}
            onCheckedChange={(auto) => setReviewSettings({ ...review, auto })}
            className="mt-0.5"
          />
        </div>
        {saved && <ReviewerModel review={review} defaults={saved.defaults} />}
        {projects.length > 0 ? (
          <ProjectMethod projects={projects} projectId={projectId} />
        ) : (
          <p className="border-t p-3 text-[12px] text-muted-foreground">
            Add a project to set how its work is reviewed.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The model reviews run with: each task's own, or one picked for all of them. */
function ReviewerModel({
  review,
  defaults,
}: {
  review: ReviewSettings;
  /** The model new threads start with, shown while each task uses its own. */
  defaults: ThreadSettings;
}) {
  const { data: providerList = [] } = useLiveQuery({
    query: (q) => q.from({ provider: providers }),
  });
  const shown = review.model ?? defaults;
  return (
    <div className="flex flex-col gap-1.5 border-t p-3">
      <span className="text-[13px] font-medium">Reviewer</span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={!review.model}
          onClick={() => setReviewSettings({ auto: review.auto })}
          className="text-[12.5px] font-normal text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
        >
          Each task's own model
        </Button>
        <span className="px-1 text-[12px] text-muted-foreground">or</span>
        <span className={cn(!review.model && "opacity-60 hover:opacity-100")}>
          <ModelPicker
            settings={{ ...shown, access: "full" }}
            providers={providerList}
            onChange={(picked) =>
              setReviewSettings({
                ...review,
                model: { provider: picked.provider, model: picked.model, effort: picked.effort },
              })
            }
          />
        </span>
      </div>
      <p className="text-[12px] text-muted-foreground">
        A fresh agent reviews each time. It reads, and changes nothing.
      </p>
    </div>
  );
}

/** The Markdown file a project's work is reviewed by, or the built-in way. */
function ProjectMethod({
  projects,
  projectId,
}: {
  projects: Project[];
  projectId: string | undefined;
}) {
  const [chosen, setChosen] = useState(() => projectId ?? projects[0]!.id);
  const project = projects.find((entry) => entry.id === chosen) ?? projects[0]!;
  return (
    <div className="flex flex-col gap-1.5 border-t p-3">
      <div className="flex min-w-0 items-center gap-1 text-[13px] font-medium">
        How
        <ProjectPicker
          value={project.id}
          onChange={(id) => id && setChosen(id)}
          projects={projects}
          className="h-7 min-w-0 border-transparent bg-transparent px-1.5 text-[13px] shadow-none hover:bg-muted"
        />
        is reviewed
      </div>
      {/* Keyed by what is saved, so the field starts over when that changes. */}
      <MethodField key={`${project.id}:${project.reviewInstructions ?? ""}`} project={project} />
    </div>
  );
}

function MethodField({ project }: { project: Project }) {
  const saved = project.reviewInstructions ?? "";
  const [path, setPath] = useState(saved);
  const [saving, setSaving] = useState(false);
  const changed = path.trim() !== saved;

  const save = async (next: string | null) => {
    setSaving(true);
    await setReviewInstructions(project.id, next);
    setSaving(false);
  };

  return (
    <>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (changed) void save(path.trim() || null);
        }}
      >
        <Input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="The built-in way: Standards and Spec"
          aria-label={`The Markdown file ${project.name} is reviewed by`}
          className="h-7 font-mono text-[12px] md:text-[12px]"
        />
        <Button type="submit" size="sm" disabled={!changed || saving}>
          Save
        </Button>
      </form>
      <p className="text-[12px] text-muted-foreground">
        A Markdown file, in the project or anywhere. The reviewer follows it instead of the built-in
        way, and still gets the changes and what was asked. An agent sets it too, when you ask it
        to.
      </p>
      {saved && (
        <Button
          variant="ghost"
          size="xs"
          disabled={saving}
          onClick={() => void save(null)}
          className="self-start text-muted-foreground"
        >
          Use the built-in way
        </Button>
      )}
    </>
  );
}
