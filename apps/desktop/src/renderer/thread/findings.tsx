// What a review found, and what became of each finding. The same card shows in the review's
// thread and in the task's, and stays current as the task's agent and the person answer.

import { eq, useLiveQuery } from "@tanstack/react-db";
import {
  disputesWaiting,
  findingCounts,
  type Finding,
  type Review,
  type UserItem,
} from "@dodocode/protocol";
import {
  Alert02Icon,
  ArrowUpRight01Icon,
  InspectCodeIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import {
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@dodocode/ui/components/trace";
import { Tip } from "../keys";
import { decideFinding, threads } from "../server/app-data";
import { openThread } from "../view";
import { Images } from "./image-view";
import { Markdown } from "./markdown";

/**
 * A review's findings, by axis, in the order the reviewer reported them: findings are never
 * ranked across axes. In the task's thread it links to the review.
 */
export function FindingsCard({ reviewId, inTask = false }: { reviewId: string; inTask?: boolean }) {
  const { data: thread } = useLiveQuery({
    queryKey: ["review", reviewId],
    query: (q) =>
      q
        .from({ row: threads })
        .where(({ row }) => eq(row.id, reviewId))
        .findOne(),
  });
  const review = thread?.review;
  if (!review) {
    return (
      <p className="rounded-xl border px-3.5 py-2.5 text-[13px] text-muted-foreground">
        A review's findings went to the agent here. The review is gone.
      </p>
    );
  }
  const waiting = disputesWaiting(review).length;

  return (
    <section aria-label="What the review found" className="flex flex-col rounded-xl border bg-card">
      <header className="flex min-h-10 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3.5 py-2">
        <HugeiconsIcon
          icon={InspectCodeIcon}
          strokeWidth={1.8}
          aria-hidden
          className="size-4 shrink-0 text-violet-600 dark:text-violet-400"
        />
        <h2 className="text-[13px] font-medium">{inTask ? "What the review found" : "Findings"}</h2>
        <span className="text-[12.5px] text-muted-foreground">{countLine(review)}</span>
        {waiting > 0 && (
          <span className="rounded-full bg-amber-500/15 px-1.5 text-[11.5px] leading-4.5 font-medium text-amber-700 dark:text-amber-400">
            {waiting === 1 ? "1 dispute waits for you" : `${waiting} disputes wait for you`}
          </span>
        )}
        {inTask && (
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto text-muted-foreground"
            onClick={() => openThread(reviewId)}
          >
            Open the review
            <HugeiconsIcon icon={ArrowUpRight01Icon} strokeWidth={2} data-icon="inline-end" />
          </Button>
        )}
      </header>
      {findingCounts(review).map(({ group, count }) => (
        <div key={group} className="border-t">
          <h3 className="px-3.5 pt-2 text-[12px] font-medium text-muted-foreground">
            {group} <span className="font-normal tabular-nums">{count}</span>
          </h3>
          <ul className="flex flex-col divide-y">
            {review.findings
              .filter((finding) => finding.group === group)
              .map((finding) => (
                <FindingRow
                  key={finding.id}
                  reviewId={reviewId}
                  finding={finding}
                  sent={review.sentAt !== undefined}
                />
              ))}
          </ul>
        </div>
      ))}
      <p className="border-t px-3.5 py-2 text-[12px] text-muted-foreground">{stateLine(review)}</p>
    </section>
  );
}

function FindingRow({
  reviewId,
  finding,
  sent,
}: {
  reviewId: string;
  finding: Finding;
  sent: boolean;
}) {
  const place = finding.file
    ? `${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""}`
    : undefined;
  return (
    <li className="flex flex-col gap-1.5 px-3.5 py-2.5">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0 rounded-md bg-muted px-1.5 text-[11.5px] leading-4.5 text-muted-foreground">
          {finding.kind}
        </span>
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed">{finding.summary}</p>
      </div>
      {(place || finding.id) && (
        <p className="flex min-w-0 items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
          {place && <span className="min-w-0 truncate">{place}</span>}
          {/* The agents name findings by id, so a reply can be matched to its finding. */}
          <span className="ml-auto shrink-0 opacity-70">{finding.id}</span>
        </p>
      )}
      {finding.quote && (
        <pre className="max-h-32 overflow-auto rounded-md bg-muted/60 px-2.5 py-1.5 font-mono text-[12px] whitespace-pre-wrap text-foreground/80">
          {finding.quote}
        </pre>
      )}
      <Answer reviewId={reviewId} finding={finding} sent={sent} />
    </li>
  );
}

/** What the task's agent did about a finding, and the person's call on a dispute. */
function Answer({
  reviewId,
  finding,
  sent,
}: {
  reviewId: string;
  finding: Finding;
  sent: boolean;
}) {
  const answer = finding.answer;
  if (!answer) {
    return sent ? (
      <p className="text-[12px] text-muted-foreground">Waiting for the agent's answer</p>
    ) : null;
  }
  if (answer.outcome === "fixed") {
    return (
      <p className="flex items-start gap-1.5 text-[12.5px]">
        <HugeiconsIcon
          icon={Tick02Icon}
          strokeWidth={2}
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
        />
        <span className="min-w-0">
          <span className="font-medium text-emerald-700 dark:text-emerald-400">
            {finding.decision === "fix" ? "Fixed, as you asked" : "Fixed"}
          </span>
          {answer.note && <span className="text-muted-foreground">: {answer.note}</span>}
        </span>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <p className="flex items-start gap-1.5 text-[12.5px]">
        <HugeiconsIcon
          icon={Alert02Icon}
          strokeWidth={1.8}
          aria-hidden
          className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <span className="min-w-0">
          <span className="font-medium text-amber-700 dark:text-amber-400">
            The agent says it's intended
          </span>
          {answer.note && <span className="text-muted-foreground">: {answer.note}</span>}
        </span>
      </p>
      {finding.decision === "agree" ? (
        <p className="pl-5 text-[12px] text-muted-foreground">You agreed to leave it.</p>
      ) : finding.decision === "fix" ? (
        <p className="pl-5 text-[12px] text-muted-foreground">
          You asked for it fixed anyway. Waiting for the agent.
        </p>
      ) : (
        <div className="flex items-center gap-1 pl-4">
          <Tip label="Send it back to the agent to fix">
            <Button
              variant="outline"
              size="xs"
              onClick={() => decideFinding(reviewId, finding.id, "fix")}
            >
              Fix it anyway
            </Button>
          </Tip>
          <Tip label="Leave it as it is">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => decideFinding(reviewId, finding.id, "agree")}
            >
              Agree
            </Button>
          </Tip>
        </div>
      )}
    </div>
  );
}

/** How many findings each axis has, side by side: `Standards 2 · Spec 1`. */
export function countLine(review: Review): string {
  const counts = findingCounts(review);
  if (counts.length === 0) return "Nothing to change";
  return counts.map(({ group, count }) => `${group} ${count}`).join(" · ");
}

/** Where the findings are: with the reviewer, with the task's agent, or answered. */
function stateLine(review: Review): string {
  if (review.findings.length === 0) {
    return review.sentAt === undefined
      ? "The task hears it once the review's turn ends."
      : "The task heard there was nothing to change.";
  }
  if (review.sentAt === undefined) {
    return "They go to the task's agent once the review's turn ends.";
  }
  const fixed = review.findings.filter((finding) => finding.answer?.outcome === "fixed").length;
  const disputed = review.findings.filter((finding) => finding.answer?.outcome === "disputed");
  const open = review.findings.length - fixed - disputed.length;
  if (open > 0) {
    return "The task's agent has them. It fixes each one, or says why it's as intended.";
  }
  const parts = [`${fixed} fixed`];
  if (disputed.length > 0) parts.push(`${disputed.length} said to be intended`);
  return `Answered: ${parts.join(", ")}.`;
}

/** What the reviewer was asked, folded: it is long, and written for the agent. */
export function ReviewBriefMessage({ item }: { item: UserItem }) {
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon>
            <HugeiconsIcon icon={InspectCodeIcon} strokeWidth={1.8} />
          </TraceIcon>
          <TraceTitle>Asked to review the task's work</TraceTitle>
          <TraceDescription>What it was told</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">
        <Markdown text={item.text} className="text-[13px]" />
        {item.images.length > 0 && <Images images={item.images} align="start" />}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}
