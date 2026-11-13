// The composer's settings under the box, in the quiet row with the rest of where the work
// happens: how much the agent may do without asking. The agent and its model are picked in the
// box, with the picker in model-picker.tsx.

import type { AccessMode, ProviderId, ThreadSettings } from "@dodocode/protocol";
import { Shield01Icon, ZapIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@dodocode/ui/components/dropdown-menu";
import { cn } from "@dodocode/ui/lib/utils";
import { Tip } from "../keys";

/** A control in the row under the box: small, quiet text until it is pointed at. */
export const QUIET =
  "h-6 min-w-0 gap-1 rounded-md border-transparent bg-transparent px-1.5 text-[12px] font-normal text-muted-foreground shadow-none hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground dark:bg-transparent dark:hover:bg-muted [&_svg:not([class*='size-'])]:size-3.5";

/** Two lines in a menu item: what it is, and what that means. */
function Described({ label, description }: { label: string; description?: string }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span>{label}</span>
      {description && (
        <span className="text-xs whitespace-normal text-muted-foreground">{description}</span>
      )}
    </span>
  );
}

const ACCESS: { value: AccessMode; label: string; description: string }[] = [
  {
    value: "supervised",
    label: "Supervised",
    description: "Asks before each command and edit",
  },
  {
    value: "full",
    label: "Full access",
    description: "Runs commands and edits files without asking",
  },
];

/** How much the agent may do without asking. Full access stands out, so it is never missed. */
export function AccessPicker({
  settings,
  onChange,
}: {
  settings: ThreadSettings;
  onChange: (settings: ThreadSettings) => void;
}) {
  const current = ACCESS.find((entry) => entry.value === settings.access) ?? ACCESS[0]!;
  const full = settings.access === "full";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Access: ${current.label}`}
            className={cn(QUIET, "shrink-0", full && "text-amber-700 dark:text-amber-400")}
          />
        }
      >
        <HugeiconsIcon icon={full ? ZapIcon : Shield01Icon} strokeWidth={1.8} />
        {current.label}
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-64">
        <DropdownMenuRadioGroup
          value={settings.access}
          onValueChange={(value: AccessMode) => onChange({ ...settings, access: value })}
        >
          {ACCESS.map((entry) => (
            <DropdownMenuRadioItem key={entry.value} value={entry.value} closeOnClick>
              <Described label={entry.label} description={entry.description} />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** How each agent keeps a reviewer to reading. */
const REVIEWER_LIMIT: Record<ProviderId, string> = {
  codex: "A reviewer reads and reports. It runs in a read-only sandbox, so it can't change files.",
  claude:
    "A reviewer reads and reports. It can't edit files, and it's told not to change any with commands.",
};

/** What a reviewer may do, where the access picker would be: read. Nothing to pick. */
export function ReviewerAccess({ provider }: { provider: ProviderId }) {
  return (
    <Tip label={REVIEWER_LIMIT[provider]} side="top">
      <Button variant="ghost" size="sm" className={cn(QUIET, "shrink-0 cursor-default")}>
        <HugeiconsIcon icon={Shield01Icon} strokeWidth={1.8} />
        Reads only
      </Button>
    </Tip>
  );
}
