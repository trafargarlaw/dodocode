// The parts every palette page shares, so they all read the same way.

import type { ComponentProps, ReactNode } from "react";
import type { Hotkey } from "@tanstack/react-hotkeys";
import { ArrowLeft01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@dodocode/ui/lib/utils";
import { Keys } from "../keys";

/** The classes for a page's cmdk root and list, which fill the palette below the header. */
export const PALETTE_COMMAND = "min-h-0 flex-1 rounded-none! bg-transparent p-0";
export const PALETTE_LIST = "max-h-none min-h-0 flex-1 scroll-py-1.5 p-1.5";

/** The top row: back (or a search mark on the first page), the page's field, and its action. */
export function PaletteHeader({
  onBack,
  children,
  action,
}: {
  /** Unset on a page with nothing before it. */
  onBack?: () => void;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-13 shrink-0 items-center gap-1.5 border-b px-2.5">
      {onBack ? (
        <button
          type="button"
          aria-label="Back"
          onClick={onBack}
          className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="size-4" />
        </button>
      ) : (
        <span className="grid size-7 shrink-0 place-items-center text-muted-foreground">
          <HugeiconsIcon icon={Search01Icon} strokeWidth={2} className="size-4" />
        </span>
      )}
      {children}
      {action}
    </div>
  );
}

/** The class for the field in the header, typed or from cmdk. */
export const HEADER_INPUT =
  "h-full min-w-0 flex-1 bg-transparent px-1 text-[14px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60";

/** A field in the header, which the palette focuses when the page opens. */
export function HeaderInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-palette-input
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the palette is opened to type in it.
      autoFocus
      spellCheck={false}
      autoComplete="off"
      className={cn(HEADER_INPUT, className)}
      {...props}
    />
  );
}

/** The header's button for the page's main action, with the keys that do it too. */
export function HeaderAction({
  children,
  hotkey,
  disabled,
  busy,
  onClick,
  title,
}: {
  children: ReactNode;
  hotkey: Hotkey;
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
      className="inline-flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-lg border bg-background pr-1 pl-2.5 text-[12.5px] font-medium text-foreground shadow-xs transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45"
    >
      <span className="min-w-0 truncate">{children}</span>
      <Keys hotkey={hotkey} />
    </button>
  );
}

/** The bottom row: the keys the page answers to, and a way out on the right. */
export function PaletteFooter({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3.5 border-t bg-muted/40 px-3 text-[12px] text-muted-foreground">
      {children}
      {end && <div className="ml-auto flex items-center">{end}</div>}
    </div>
  );
}

export function KeyHint({ keys, children }: { keys: Hotkey[]; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-flex items-center gap-0.5">
        {keys.map((key) => (
          <Keys key={String(key)} hotkey={key} />
        ))}
      </span>
      {children}
    </span>
  );
}

/** A heading over a list, like "Sources" or "Folders". */
export function ListHeading({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("px-2 pt-2.5 pb-1.5 text-xs font-medium text-muted-foreground", className)}>
      {children}
    </div>
  );
}
