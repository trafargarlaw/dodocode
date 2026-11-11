import type { ReactElement } from "react";
import {
  useFormatForDisplay,
  useHotkeyHint,
  type AppHotkey,
  type Hotkey,
} from "@tanstack/react-hotkeys";
import { Kbd } from "@dodocode/ui/components/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@dodocode/ui/components/tooltip";
import { cn } from "@dodocode/ui/lib/utils";

/** A hotkey as the platform writes it: one key cap per step, so `G T` reads as two presses. */
export function Keys({ hotkey, className }: { hotkey: Hotkey; className?: string }) {
  const format = useFormatForDisplay();
  const steps = typeof hotkey === "string" ? [hotkey] : hotkey;
  return (
    <span className="inline-flex items-center gap-0.5">
      {steps.map((step, i) => (
        // A sequence can press the same keys twice, so the step's place is its identity.
        // oxlint-disable-next-line react/no-array-index-key
        <Kbd key={i} className={cn("h-4.5 rounded-[5px] px-1.25 text-[10.5px]", className)}>
          {format(step)}
        </Kbd>
      ))}
    </span>
  );
}

/** Key caps on the wallpaper, in the wallpaper's own colours. */
export const WALLPAPER_KEYS = "bg-sidebar-selected text-sidebar-muted-foreground";

/** A short label for a control, with the keys that do the same thing. */
export function Tip({
  label,
  hotkey,
  side = "bottom",
  children,
}: {
  label: string;
  hotkey?: AppHotkey;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactElement;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side={side}>
        {label}
        {hotkey?.hotkey && <Keys hotkey={hotkey.hotkey} />}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The keys for a control, shown next to it only while the modifiers they start with are held,
 * and only while the hotkey can fire. Put it inside a `relative` element.
 */
export function HeldKeys({ hotkey, className }: { hotkey: AppHotkey; className?: string }) {
  const shown = useHotkeyHint(hotkey);
  if (!shown || !hotkey.hotkey) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-20 animate-in duration-100 fade-in-0 zoom-in-95",
        className,
      )}
    >
      <Keys hotkey={hotkey.hotkey} className="bg-foreground text-background shadow-sm" />
    </span>
  );
}
