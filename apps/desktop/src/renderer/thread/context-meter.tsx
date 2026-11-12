import { useRef, useState } from "react";
import type { ContextUsage } from "@dodocode/protocol";
import { HugeiconsIcon } from "@hugeicons/react";
import { Settings02Icon } from "@hugeicons/core-free-icons";
import { Button } from "@dodocode/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@dodocode/ui/components/popover";
import { Spinner } from "@dodocode/ui/components/spinner";
import { cn } from "@dodocode/ui/lib/utils";
import { compact } from "./numbers";

// How full the agent's context is, under the message box, where it is always in sight. Opening
// it tells more, and compacts the conversation now or changes when that happens by itself.

/** Past this share of where it compacts, or of the window when it doesn't, the meter warns. */
const NEARLY_FULL = 0.85;

const whole = new Intl.NumberFormat();

export function ContextMeter({
  context,
  canCompact,
  onCompact,
  onChangeThreshold,
}: {
  context: ContextUsage;
  /** Why it can't compact now, or nothing when it can. */
  canCompact: string | undefined;
  onCompact: () => void;
  /** Starts a command that changes when it compacts by itself, for an agent that takes one. */
  onChangeThreshold?: () => void;
}) {
  const [open, setOpen] = useState(false);
  // Set when the person went on to type a command, which keeps the focus.
  const typing = useRef(false);
  const { used, window: size, autoCompactAt } = context;
  const share = Math.min(1, used / size);
  const limit = autoCompactAt ?? size;
  const nearly = used >= limit * NEARLY_FULL;
  const percent = Math.round(share * 100);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) typing.current = false;
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            aria-label={`Context: ${compact(used)} of ${compact(size)} tokens used`}
            className={cn(
              "gap-1.5 font-normal text-muted-foreground tabular-nums",
              nearly && "text-amber-700 dark:text-amber-400",
            )}
          />
        }
      >
        {context.compacting ? <Spinner className="size-3.5" /> : <Ring share={share} />}
        {context.compacting ? "Compacting…" : `${compact(used)} / ${compact(size)}`}
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-72 gap-3 p-3"
        finalFocus={() => !typing.current}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-medium">Context</span>
          <span className="text-xs text-muted-foreground tabular-nums">{percent}% full</span>
        </div>
        <Bar share={share} mark={autoCompactAt ? autoCompactAt / size : undefined} warn={nearly} />
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          The conversation takes up {whole.format(used)} of the {whole.format(size)} tokens the
          agent can hold.{" "}
          {autoCompactAt !== undefined
            ? `It compacts by itself at ${whole.format(autoCompactAt)}, the line on the bar.`
            : onChangeThreshold
              ? "It does not compact by itself."
              : ""}
        </p>
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={canCompact !== undefined || context.compacting}
            onClick={() => {
              setOpen(false);
              onCompact();
            }}
          >
            Compact now
          </Button>
          {onChangeThreshold && (
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={() => {
                typing.current = true;
                setOpen(false);
                onChangeThreshold();
              }}
            >
              <HugeiconsIcon icon={Settings02Icon} strokeWidth={1.8} data-icon="inline-start" />
              Change when it compacts
            </Button>
          )}
        </div>
        {canCompact && <p className="text-xs text-muted-foreground">{canCompact}</p>}
      </PopoverContent>
    </Popover>
  );
}

const RADIUS = 5;
const AROUND = 2 * Math.PI * RADIUS;

function Ring({ share }: { share: number }) {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className="size-3.5 -rotate-90">
      <circle
        cx="7"
        cy="7"
        r={RADIUS}
        fill="none"
        strokeWidth="2"
        className="stroke-current opacity-25"
      />
      <circle
        cx="7"
        cy="7"
        r={RADIUS}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={AROUND}
        strokeDashoffset={AROUND * (1 - share)}
        className="stroke-current"
      />
    </svg>
  );
}

function Bar({ share, mark, warn }: { share: number; mark: number | undefined; warn: boolean }) {
  return (
    <div className="relative h-1.5 rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full bg-foreground/70", warn && "bg-amber-500")}
        style={{ width: `${share * 100}%` }}
      />
      {mark !== undefined && (
        <div
          aria-hidden
          className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={{ left: `${Math.min(1, mark) * 100}%` }}
        />
      )}
    </div>
  );
}
