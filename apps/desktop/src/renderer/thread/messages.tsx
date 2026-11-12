import { useEffect, useState } from "react";
import type { ImageRef, NoticeItem, TurnEndItem, UserItem } from "@dodocode/protocol";
import {
  Alert02Icon,
  AlertCircleIcon,
  InformationCircleIcon,
  SteeringIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Bubble, BubbleContent } from "@dodocode/ui/components/bubble";
import { Marker, MarkerContent, MarkerIcon } from "@dodocode/ui/components/marker";
import { Message, MessageContent, MessageFooter } from "@dodocode/ui/components/message";
import { cn } from "@dodocode/ui/lib/utils";
import { server } from "../server/connection";
import { duration } from "../time";
import type { Block } from "./blocks";
import { ApprovalCard, QuestionCard } from "./cards";
import { Markdown } from "./markdown";
import { compact, cost } from "./numbers";
import { StepsBlock } from "./steps";

export function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "user":
      return <UserMessage item={block.item} />;
    case "assistant":
      return block.item.text ? <Markdown text={block.item.text} className="text-[13.5px]" /> : null;
    case "steps":
      return <StepsBlock steps={block.steps} />;
    case "approval":
      return <ApprovalCard item={block.item} />;
    case "question":
      return <QuestionCard item={block.item} />;
    case "notice":
      return <Notice item={block.item} />;
    case "turn_end":
      return <TurnEnd item={block.item} />;
  }
}

function UserMessage({ item }: { item: UserItem }) {
  return (
    <Message align="end">
      <MessageContent>
        {item.images.length > 0 && <Images images={item.images} />}
        {item.text && (
          <Bubble variant="secondary" align="end">
            <BubbleContent className="text-[13.5px] whitespace-pre-wrap">{item.text}</BubbleContent>
          </Bubble>
        )}
        {item.steered && (
          <MessageFooter className="gap-1">
            <HugeiconsIcon icon={SteeringIcon} strokeWidth={1.8} className="size-3.5" />
            Sent while the agent worked
          </MessageFooter>
        )}
      </MessageContent>
    </Message>
  );
}

export function Images({ images, className }: { images: ImageRef[]; className?: string }) {
  return (
    <div className={cn("flex flex-wrap justify-end gap-2", className)}>
      {images.map((image) => (
        <a
          key={image.id}
          href={server.attachmentUrl(image.id)}
          target="_blank"
          rel="noreferrer"
          className="overflow-hidden rounded-xl border outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <img
            src={server.attachmentUrl(image.id)}
            alt={image.name}
            loading="lazy"
            className="max-h-48 max-w-64 object-cover"
          />
        </a>
      ))}
    </div>
  );
}

const NOTICE_ICON = {
  info: InformationCircleIcon,
  warning: Alert02Icon,
  error: AlertCircleIcon,
} as const;

function Notice({ item }: { item: NoticeItem }) {
  return (
    <Marker
      className={cn(
        "items-start",
        item.level === "warning" && "text-amber-700 dark:text-amber-400",
        item.level === "error" && "text-destructive",
      )}
    >
      <MarkerIcon className="mt-0.5">
        <HugeiconsIcon icon={NOTICE_ICON[item.level]} strokeWidth={1.8} />
      </MarkerIcon>
      <MarkerContent className="whitespace-pre-wrap">{item.text}</MarkerContent>
    </Marker>
  );
}

function TurnEnd({ item }: { item: TurnEndItem }) {
  if (item.status === "failed") {
    return (
      <div className="flex flex-col gap-1 rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-[13px]">
        <span className="flex items-center gap-1.5 font-medium text-destructive">
          <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={1.8} className="size-4" />
          The turn failed after {duration(item.durationMs)}
        </span>
        {item.error && <p className="whitespace-pre-wrap text-foreground/80">{item.error}</p>}
      </div>
    );
  }
  const parts = [
    item.status === "interrupted"
      ? `Stopped after ${duration(item.durationMs)}`
      : `Worked for ${duration(item.durationMs)}`,
  ];
  if (item.costUsd !== undefined && item.costUsd > 0) parts.push(cost(item.costUsd));
  const tokens = (item.inputTokens ?? 0) + (item.outputTokens ?? 0);
  if (tokens > 0) parts.push(`${compact(tokens)} tokens`);
  return (
    <Marker variant="separator" className="text-xs">
      <MarkerContent>{parts.join(" · ")}</MarkerContent>
    </Marker>
  );
}

/** Shown while the agent works and has nothing streaming to show. */
export function Working({ since, waiting }: { since: number | undefined; waiting: boolean }) {
  const now = useSecond();
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <span className={cn(!waiting && "shimmer motion-reduce:shimmer-none")}>
        {waiting ? "Waiting for you" : "Working"}
      </span>
      {since !== undefined && (
        <span className="tabular-nums text-muted-foreground/70">{elapsed(now - since)}</span>
      )}
    </div>
  );
}

/** A clock that ticks once a second shows whole seconds. */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}s` : duration(ms);
}

function useSecond(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
