import type { ReactNode } from "react";
import type { FileChange } from "@dodocode/protocol";
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@dodocode/ui/components/code-block";
import { useHighlightedCode } from "@dodocode/ui/hooks/use-highlighted-code";
import { cn } from "@dodocode/ui/lib/utils";
import { diffLines } from "./blocks";

/** Code, highlighted when the language is one the highlighter knows. */
export function Code({
  value,
  language,
  title,
  className,
  contentClassName,
  wrap,
}: {
  value: string;
  language: string;
  title?: ReactNode;
  className?: string;
  contentClassName?: string;
  wrap?: boolean;
}) {
  const lines = useHighlightedCode(value, language || "text");
  return (
    <CodeBlock size="sm" className={className}>
      <CodeBlockHeader>
        <CodeBlockTitle className="min-w-0 truncate">
          {title ?? (language || "text")}
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={value} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap={wrap} className={cn("text-[12.5px]", contentClassName)}>
        {lines.map((line, index) => (
          // Lines have no identity but their place.
          // oxlint-disable-next-line react/no-array-index-key
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}

/** What a tool printed, kept short enough to scroll past. */
export function Output({ value, title }: { value: string; title?: ReactNode }) {
  return (
    <Code
      value={value}
      language="ansi"
      title={title ?? "Output"}
      wrap
      contentClassName="max-h-72"
    />
  );
}

const CHANGE_LABEL: Record<FileChange["kind"], string> = {
  add: "Added",
  update: "Edited",
  delete: "Deleted",
  move: "Moved",
};

/** One file's change, with its diff when there is one. */
export function FileDiff({ change }: { change: FileChange }) {
  const parsed = change.diff ? diffLines(change.diff) : undefined;
  const title = (
    <span className="flex min-w-0 items-center gap-2">
      <span className="shrink-0 text-muted-foreground">{CHANGE_LABEL[change.kind]}</span>
      <span className="truncate font-mono text-foreground">
        {change.path}
        {change.movedTo ? ` → ${change.movedTo}` : ""}
      </span>
      {parsed && (
        <span className="shrink-0 tabular-nums">
          <span className="text-emerald-600 dark:text-emerald-400">+{parsed.added}</span>{" "}
          <span className="text-destructive">−{parsed.removed}</span>
        </span>
      )}
    </span>
  );
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle className="min-w-0">{title}</CodeBlockTitle>
        {change.diff && (
          <CodeBlockActions>
            <CodeBlockCopyButton value={change.diff} />
          </CodeBlockActions>
        )}
      </CodeBlockHeader>
      {parsed && parsed.lines.length > 0 && (
        <CodeBlockContent className="max-h-96 text-[12.5px]">
          {parsed.lines.map((line, index) => (
            <CodeBlockLine
              // oxlint-disable-next-line react/no-array-index-key
              key={index}
              variant={
                line.kind === "added"
                  ? "added"
                  : line.kind === "removed"
                    ? "removed"
                    : line.kind === "hunk"
                      ? "highlighted"
                      : "default"
              }
              className={cn(line.kind === "hunk" && "text-muted-foreground")}
            >
              {line.text}
            </CodeBlockLine>
          ))}
        </CodeBlockContent>
      )}
    </CodeBlock>
  );
}

/** How many lines a set of changes adds and removes. */
export function changeCounts(changes: readonly FileChange[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    if (!change.diff) continue;
    const parsed = diffLines(change.diff);
    added += parsed.added;
    removed += parsed.removed;
  }
  return { added, removed };
}
