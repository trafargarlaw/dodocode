import {
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { ImageRef, OutgoingMessage, ProviderInfo, ThreadSettings } from "@dodocode/protocol";
import { ArrowUp02Icon, Cancel01Icon, ImageAdd01Icon, StopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import { Spinner } from "@dodocode/ui/components/spinner";
import { cn } from "@dodocode/ui/lib/utils";
import { Keys, Tip } from "../keys";
import { providers as providerRows, reportError } from "../server/app-data";
import { uploadImage } from "./images";
import { ModelPicker } from "./model-picker";
import { AccessPicker } from "./pickers";

const isMac = window.dodocode.platform === "darwin";

// Unsent words and images, kept per thread while the app runs, so switching threads loses
// nothing. An upload that finishes after its thread was left still lands in its draft.

interface DraftImage {
  /** The draft's own name for the image, until the server has kept it. */
  key: string;
  name: string;
  /** An object URL for the thumbnail. */
  preview: string;
  ref?: ImageRef;
}

interface Draft {
  text: string;
  images: DraftImage[];
}

const EMPTY: Draft = { text: "", images: [] };
const drafts = new Map<string, Draft>();
const draftListeners = new Set<() => void>();

function getDraft(key: string): Draft {
  return drafts.get(key) ?? EMPTY;
}

function setDraft(key: string, update: (draft: Draft) => Draft): void {
  const next = update(getDraft(key));
  if (!next.text && next.images.length === 0) drafts.delete(key);
  else drafts.set(key, next);
  for (const listener of Array.from(draftListeners)) listener();
}

/**
 * What is ready to send in a draft: its words, and the images that finished uploading. Nothing
 * when it holds nothing.
 */
export function readyDraft(key: string): OutgoingMessage | undefined {
  const draft = getDraft(key);
  const text = draft.text.trim();
  const images = draft.images.flatMap((image) => (image.ref ? [image.ref] : []));
  return text || images.length > 0 ? { text, images } : undefined;
}

/** Empties a draft, once what was in it went some other way. */
export function clearDraft(key: string): void {
  for (const image of getDraft(key).images) URL.revokeObjectURL(image.preview);
  setDraft(key, () => EMPTY);
}

function useDraft(key: string): Draft {
  return useSyncExternalStore(
    (listener) => {
      draftListeners.add(listener);
      return () => draftListeners.delete(listener);
    },
    () => getDraft(key),
  );
}

export interface ComposerProps {
  /** Which draft the words go in: the thread's id, or one for a new thread. */
  draftKey: string;
  settings: ThreadSettings;
  onSettingsChange: (settings: ThreadSettings) => void;
  /** While a turn runs, Enter queues the message and Mod+Enter steers the turn with it. */
  running: boolean;
  /** Why the message can't go yet. */
  blocked?: string;
  placeholder: string;
  /** Sends the message. Resolves false when it did not go, so the draft comes back. */
  onSend: (message: OutgoingMessage, mode?: "queue" | "steer") => Promise<boolean>;
  onStop?: () => void;
  inputRef?: Ref<HTMLTextAreaElement>;
  /** Puts the cursor in the box when it first shows. */
  focusOnMount?: boolean;
  /**
   * Where the work happens, at the start of the row under the box: the project, and whether it
   * runs in the project's folder or a worktree.
   */
  where?: ReactNode;
  /** The branch it works on, at the end of that row, before the access it has. */
  branch?: ReactNode;
  /** What the send button says it does, when it does more than send. */
  sendLabel?: string;
  /** Lets the button send with nothing written, as when it starts a task. */
  allowEmpty?: boolean;
  /** A second way to send, on its own button and on Alt+Enter, such as adding it to To do. */
  alternate?: {
    label: string;
    /** Why it can't go that way now. */
    blocked?: string;
    onSend: (message: OutgoingMessage) => Promise<boolean>;
  };
}

export function Composer({
  draftKey,
  settings,
  onSettingsChange,
  running,
  blocked,
  placeholder,
  onSend,
  onStop,
  inputRef,
  focusOnMount,
  where,
  branch,
  sendLabel,
  allowEmpty,
  alternate,
}: ComposerProps) {
  const draft = useDraft(draftKey);
  const files = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { data: providerList = [] } = useLiveQuery({
    query: (q) => q.from({ provider: providerRows }),
  });
  const provider = providerList.find((entry) => entry.id === settings.provider);
  const reason = blocked ?? providerBlock(provider, settings.provider);
  const uploading = draft.images.some((image) => !image.ref);
  const empty = !draft.text.trim() && draft.images.length === 0;
  const canSend = (!empty || allowEmpty === true) && !uploading && !reason;
  const canAlternate = !empty && !uploading && !reason && !alternate?.blocked;

  const addImages = (list: Iterable<File>) => {
    for (const file of list) {
      if (!file.type.startsWith("image/")) continue;
      const key = crypto.randomUUID();
      const preview = URL.createObjectURL(file);
      const name = file.name || "Pasted image";
      setDraft(draftKey, (current) => ({
        ...current,
        images: [...current.images, { key, name, preview }],
      }));
      uploadImage(file).then(
        (ref) =>
          setDraft(draftKey, (current) => ({
            ...current,
            images: current.images.map((image) => (image.key === key ? { ...image, ref } : image)),
          })),
        (error: unknown) => {
          URL.revokeObjectURL(preview);
          setDraft(draftKey, (current) => ({
            ...current,
            images: current.images.filter((image) => image.key !== key),
          }));
          reportError(`Could not attach ${name}`, error);
        },
      );
    }
  };

  const removeImage = (key: string) => {
    const image = getDraft(draftKey).images.find((entry) => entry.key === key);
    if (image) URL.revokeObjectURL(image.preview);
    setDraft(draftKey, (current) => ({
      ...current,
      images: current.images.filter((entry) => entry.key !== key),
    }));
  };

  const send = async (mode?: "queue" | "steer", via?: "alternate") => {
    const sent = getDraft(draftKey);
    const text = sent.text.trim();
    if (via === "alternate" ? !canAlternate : !canSend) return;
    if (!text && sent.images.length === 0 && !allowEmpty) return;
    const images = sent.images.flatMap((image) => (image.ref ? [image.ref] : []));
    // The box empties at once. When the message does not go, it comes back, unless the person
    // has started a new one.
    setDraft(draftKey, () => EMPTY);
    const ok =
      via === "alternate" && alternate
        ? await alternate.onSend({ text, images })
        : await onSend({ text, images }, mode);
    if (ok) {
      for (const image of sent.images) URL.revokeObjectURL(image.preview);
      return;
    }
    setDraft(draftKey, (current) => (current.text || current.images.length > 0 ? current : sent));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && event.altKey && !event.shiftKey && alternate) {
      event.preventDefault();
      void send(undefined, "alternate");
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      const mod = isMac ? event.metaKey : event.ctrlKey;
      void send(running ? (mod ? "steer" : "queue") : undefined);
      return;
    }
    if (event.key === "Escape" && running && onStop) {
      event.preventDefault();
      onStop();
    }
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    event.preventDefault();
    addImages(images);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          setDragging(false);
          addImages(event.dataTransfer.files);
        }}
        className={cn(
          "flex flex-col rounded-2xl border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.12)] transition-colors focus-within:border-ring/70 dark:bg-input/20",
          dragging && "border-primary ring-3 ring-primary/20",
        )}
      >
        {draft.images.length > 0 && (
          <ul aria-label="Images to send" className="flex flex-wrap gap-2 px-3 pt-3">
            {draft.images.map((image) => (
              <li key={image.key} className="group/image relative">
                <img
                  src={image.preview}
                  alt={image.name}
                  className={cn(
                    "size-14 rounded-lg border object-cover",
                    !image.ref && "opacity-60",
                  )}
                />
                {!image.ref && (
                  <span className="absolute inset-0 grid place-items-center">
                    <Spinner className="size-4" />
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${image.name}`}
                  onClick={() => removeImage(image.key)}
                  className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity outline-none group-hover/image:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={inputRef}
          value={draft.text}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(draftKey, (current) => ({ ...current, text }));
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={placeholder}
          aria-label="Message"
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the box is where a new thread starts.
          autoFocus={focusOnMount}
          rows={1}
          // The scrollbar's track stops short of the box's rounded corner.
          className="field-sizing-content max-h-[40vh] min-h-13 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[13.5px] leading-relaxed outline-none placeholder:text-muted-foreground [&::-webkit-scrollbar-track]:mt-2"
        />
        <div className="flex min-w-0 items-center gap-1 px-2 pt-1 pb-2">
          <Tip label="Attach images">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Attach images"
              className="text-muted-foreground"
              onClick={() => files.current?.click()}
            >
              <HugeiconsIcon icon={ImageAdd01Icon} strokeWidth={1.8} />
            </Button>
          </Tip>
          <input
            ref={files}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              if (event.target.files) addImages(event.target.files);
              event.target.value = "";
            }}
          />
          <div className="ml-auto flex min-w-0 items-center gap-1">
            <ModelPicker settings={settings} providers={providerList} onChange={onSettingsChange} />
            {running && onStop && (
              <Tip label="Stop the agent">
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label="Stop the agent"
                  onClick={onStop}
                >
                  <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
                </Button>
              </Tip>
            )}
            {alternate && (
              <Tip
                label={alternate.blocked ?? alternate.label}
                hotkey={alternate.blocked ? undefined : "Alt+Enter"}
              >
                <span className="inline-flex shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canAlternate}
                    onClick={() => void send(undefined, "alternate")}
                    className="rounded-full"
                  >
                    {alternate.label}
                  </Button>
                </span>
              </Tip>
            )}
            <Tip
              label={
                reason ??
                (uploading
                  ? "The images are still uploading"
                  : running
                    ? "Queue the message"
                    : (sendLabel ?? "Send"))
              }
            >
              {/* A disabled button gets no pointer events, so its tip hangs on a wrapper. */}
              <span className="inline-flex shrink-0">
                <Button
                  size="icon-sm"
                  aria-label={running ? "Queue the message" : (sendLabel ?? "Send")}
                  disabled={!canSend}
                  onClick={() => void send(running ? "queue" : undefined)}
                  className="rounded-full"
                >
                  <HugeiconsIcon icon={ArrowUp02Icon} strokeWidth={2.2} />
                </Button>
              </span>
            </Tip>
          </div>
        </div>
      </div>
      {/* Where the work happens, out of the way of the message. */}
      <div className="flex min-w-0 items-center gap-2 px-1.5">
        <div className="flex min-w-0 items-center gap-0.5">{where}</div>
        <div className="ml-auto flex min-w-0 items-center gap-0.5">
          {branch}
          <AccessPicker settings={settings} onChange={onSettingsChange} />
        </div>
      </div>
      <ComposerHints running={running && !empty} reason={reason} />
    </div>
  );
}

/** Why the message can't go, or while a turn runs and there is a message, what the keys do. */
function ComposerHints({ running, reason }: { running: boolean; reason: string | undefined }) {
  const mod = isMac ? "Meta" : "Control";
  if (reason) {
    return <p className="px-3 text-[11.5px] text-muted-foreground">{reason}</p>;
  }
  if (!running) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 text-[11.5px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <Keys hotkey="Enter" /> queues for the next turn
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Keys hotkey={`${mod}+Enter`} /> sends it now
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Keys hotkey="Escape" /> stops
      </span>
    </p>
  );
}

/** Why a provider can't take a message, or nothing when it can. */
function providerBlock(provider: ProviderInfo | undefined, id: string): string | undefined {
  const label = provider?.label ?? (id === "codex" ? "Codex" : "Claude");
  switch (provider?.status) {
    case "ready":
      return undefined;
    case undefined:
    case "checking":
      return `Checking ${label}…`;
    case "missing":
      return provider.message ?? `${label} is not installed.`;
    case "error":
      return provider.message ?? `${label} did not start.`;
  }
}

function hasFiles(event: DragEvent): boolean {
  return event.dataTransfer.types.includes("Files");
}
