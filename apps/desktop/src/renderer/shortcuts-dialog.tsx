import { useState } from "react";
import {
  HotkeysProvider,
  useAppHotkeyList,
  useAppHotkeys,
  useCustomHotkeys,
  useFormatForDisplay,
  useHotkey,
  useHotkeyRecorder,
  type AppHotkey,
  type AppHotkeyListItem,
  type Hotkey,
  type RecorderRejection,
} from "@tanstack/react-hotkeys";
import { Undo02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@dodocode/ui/components/dialog";
import { cn } from "@dodocode/ui/lib/utils";
import { Keys, Tip } from "./keys";

type Item = ReturnType<typeof useAppHotkeyList>[number];

/** Every shortcut in the app, grouped, with a way to press new keys for each. */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-md">
        {/* While the dialog is open, its keys are the only ones that run. */}
        <HotkeysProvider scope="shortcuts" exclusive>
          <ShortcutList onClose={() => onOpenChange(false)} />
        </HotkeysProvider>
      </DialogContent>
    </Dialog>
  );
}

function ShortcutList({ onClose }: { onClose: () => void }) {
  const items = useAppHotkeyList();
  const { customHotkeys, resetCustomHotkeys } = useCustomHotkeys();
  // The keys that opened the dialog close it too.
  useHotkey(useAppHotkeys()["shortcuts.open"], onClose);

  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const group = item.appHotkey.meta?.group ?? "Other";
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>
          Click a shortcut, then press the keys you want instead.
        </DialogDescription>
      </DialogHeader>
      <div className="-mx-1 flex max-h-[min(60vh,480px)] flex-col gap-3 overflow-y-auto px-1">
        {[...groups].map(([group, rows]) => (
          <section key={group} aria-label={group}>
            <h3 className="pb-1 text-xs font-medium text-muted-foreground">{group}</h3>
            <ul className="flex flex-col">
              {rows.map((item) => (
                <ShortcutRow key={item.appHotkey.id} item={item} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      {Object.keys(customHotkeys).length > 0 && (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={resetCustomHotkeys}>
            Restore every default
          </Button>
        </div>
      )}
    </>
  );
}

function ShortcutRow({ item }: { item: AppHotkeyListItem<AppHotkey> }) {
  const { appHotkey, isCustom } = item;
  const id = appHotkey.id as keyof ReturnType<typeof useAppHotkeys> & string;
  const { setCustomHotkey, resetCustomHotkey, findConflicts } = useCustomHotkeys();
  const format = useFormatForDisplay();
  const [problem, setProblem] = useState<string>();
  const defaultHotkey = appHotkey.defaultHotkey;
  const isSequence = Array.isArray(defaultHotkey);

  const recorder = useHotkeyRecorder({
    // A sequence can be rebound to two presses; a chord to one.
    maxSteps: isSequence ? 2 : 1,
    // Keys bound by their place on the keyboard are recorded by place; the rest by what they type.
    recordBy: isPhysical(defaultHotkey) ? "code" : "key",
    // Keys already registered elsewhere in the app, other than this shortcut's own.
    detectConflicts: { exclude: (registration) => registration.options.appHotkeyId === id },
    // Every declared shortcut, mounted or not, such as the theme's while it is closed.
    validate: (hotkey) => {
      const names = findConflicts(id, hotkey).map(nameOf);
      return names.length === 0 || `${format(hotkey)} is already ${listOf(names)}.`;
    },
    onReject: (rejection) => setProblem(rejectionMessage(rejection, format)),
    onRecord: (hotkey) => {
      const names = setCustomHotkey(id, hotkey).map(nameOf);
      setProblem(names.length ? `${format(hotkey)} is already ${listOf(names)}.` : undefined);
    },
    // Backspace with nothing pressed yet takes the shortcut away.
    onClear: () => {
      setCustomHotkey(id, null);
      setProblem(undefined);
    },
    onCancel: () => setProblem(undefined),
  });

  const name = appHotkey.meta?.name ?? id;
  const live = recorder.steps.length > 0 ? recorder.steps : undefined;

  return (
    <li className="flex flex-col gap-1 border-b border-border/60 py-1.5 last:border-b-0">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate">{name}</div>
          {appHotkey.meta?.description && (
            <div className="truncate text-xs text-muted-foreground">
              {appHotkey.meta.description}
            </div>
          )}
        </div>
        {isCustom && !recorder.isRecording && (
          <Tip label="Restore the default" side="top">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Restore the default for ${name}`}
              onClick={() => {
                resetCustomHotkey(id);
                setProblem(undefined);
              }}
              className="text-muted-foreground"
            >
              <HugeiconsIcon icon={Undo02Icon} strokeWidth={2} />
            </Button>
          </Tip>
        )}
        <button
          type="button"
          aria-label={
            recorder.isRecording
              ? `Recording keys for ${name}`
              : `${name}: ${appHotkey.hotkey ? format(appHotkey.hotkey) : "no keys"}. Change`
          }
          data-recording={recorder.isRecording || undefined}
          onClick={() =>
            recorder.isRecording ? recorder.cancelRecording() : recorder.startRecording()
          }
          className={cn(
            "flex h-7 min-w-24 items-center justify-end gap-1 rounded-md px-1.5 text-xs text-muted-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
            recorder.isRecording && "bg-muted text-foreground",
          )}
        >
          {recorder.isRecording ? (
            live ? (
              <Keys hotkey={live} />
            ) : (
              "Press keys…"
            )
          ) : appHotkey.hotkey ? (
            <Keys hotkey={appHotkey.hotkey} />
          ) : (
            "Not set"
          )}
        </button>
      </div>
      {recorder.isRecording && (
        <p className="text-right text-xs text-muted-foreground">
          Esc cancels · Backspace removes the shortcut
          {isSequence && " · Enter keeps one press"}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-right text-xs text-destructive">
          {problem}
        </p>
      )}
    </li>
  );
}

const isPhysical = (hotkey: Hotkey | null) =>
  hotkey !== null &&
  (typeof hotkey === "string" ? [hotkey] : hotkey).some((step) => step.includes("["));

const nameOf = (appHotkey: AppHotkey) => appHotkey.meta?.name ?? appHotkey.id;

const listOf = (names: string[]) => `used by ${names.join(", ")}`;

function rejectionMessage(
  rejection: RecorderRejection,
  format: ReturnType<typeof useFormatForDisplay>,
): string {
  switch (rejection.reason) {
    case "validation":
      return rejection.message ?? "Those keys can't be used.";
    case "conflict": {
      const names = (rejection.conflicts ?? []).map(
        ({ registration }) => registration.options.meta?.name ?? format(registration.hotkey),
      );
      return `${rejection.hotkey ? format(rejection.hotkey) : "Those keys"} is already ${listOf(names)}.`;
    }
    case "alt-graph":
      return "AltGr can't start a shortcut. Try Ctrl or Alt.";
    case "whitespace":
      return "Space can't be a shortcut on its own.";
    case "missing-code":
      return "That key can't be recorded.";
  }
}
