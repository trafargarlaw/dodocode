import type { ComponentProps, SubmitEvent } from "react";
import type { ApprovalItem, ApprovalOption, QuestionItem } from "@dodocode/protocol";
import {
  Cancel01Icon,
  MessageQuestionIcon,
  SecurityCheckIcon,
  Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@dodocode/ui/components/questionnaire";
import {
  Trace,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@dodocode/ui/components/trace";
import { cn } from "@dodocode/ui/lib/utils";
import { respondApproval, respondQuestion } from "../server/thread-data";
import { Code, FileDiff } from "./code";

/** A card that waits for the person. */
function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-3.5 text-card-foreground shadow-xs",
        className,
      )}
      {...props}
    />
  );
}

const OPTION_VARIANT: Record<ApprovalOption["id"], "default" | "secondary" | "outline"> = {
  allow: "default",
  allow_session: "secondary",
  deny: "outline",
};

/** Deny first and Allow last, whatever order the provider sent. */
const OPTION_ORDER: ApprovalOption["id"][] = ["deny", "allow_session", "allow"];

export function ApprovalCard({ item }: { item: ApprovalItem }) {
  if (item.status !== "pending") return <ResolvedApproval item={item} />;

  const options = item.options.toSorted(
    (a, b) => OPTION_ORDER.indexOf(a.id) - OPTION_ORDER.indexOf(b.id),
  );
  const diffs = item.changes?.filter((change) => change.diff) ?? [];

  return (
    <Card aria-label="Approval needed" className="border-amber-500/40">
      <header className="flex items-start gap-2">
        <HugeiconsIcon
          icon={Shield01Icon}
          strokeWidth={1.8}
          className="mt-px size-4 shrink-0 text-amber-600 dark:text-amber-400"
        />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="font-medium">{item.title}</h3>
          {item.reason && <p className="text-muted-foreground">{item.reason}</p>}
        </div>
      </header>
      {diffs.length > 0 ? (
        diffs.map((change) => <FileDiff key={change.path} change={change} />)
      ) : item.detail.trim() ? (
        <Code
          value={item.detail}
          language={item.kind === "command" ? "bash" : looksLikeJson(item.detail) ? "json" : "text"}
          title={item.kind === "command" ? "Command" : item.kind === "edit" ? "Files" : "Input"}
          wrap
          contentClassName="max-h-72"
        />
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        {options.map((option) => (
          <Button
            key={option.id}
            size="sm"
            variant={OPTION_VARIANT[option.id]}
            onClick={() => respondApproval(item.threadId, item.id, option.id)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </Card>
  );
}

function ResolvedApproval({ item }: { item: ApprovalItem }) {
  const label =
    item.status === "denied"
      ? "Denied"
      : item.status === "cancelled"
        ? "Cancelled"
        : item.decision === "allow_session"
          ? "Allowed for this session"
          : "Allowed";
  return (
    <Trace>
      <div>
        <TraceLine status={item.status === "denied" ? "error" : undefined}>
          <TraceIcon>
            <HugeiconsIcon
              icon={item.status === "allowed" ? SecurityCheckIcon : Shield01Icon}
              strokeWidth={1.8}
            />
          </TraceIcon>
          <TraceTitle>{item.title}</TraceTitle>
          <TraceDescription>{label}</TraceDescription>
        </TraceLine>
      </div>
    </Trace>
  );
}

function looksLikeJson(text: string): boolean {
  const start = text.trimStart()[0];
  return start === "{" || start === "[";
}

export function QuestionCard({ item }: { item: QuestionItem }) {
  if (item.status !== "pending") return <ResolvedQuestion item={item} />;

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const answers: Record<string, string[]> = {};
    for (const question of item.questions) {
      const values = data
        .getAll(question.id)
        .map((value) => String(value).trim())
        .filter(Boolean);
      if (values.length > 0) answers[question.id] = values;
    }
    respondQuestion(item.threadId, item.id, answers);
  };

  return (
    <Card aria-label="The agent has a question" className="border-primary/30 p-4">
      <Questionnaire onSubmit={submit} shortcuts="numbers">
        {item.questions.length > 1 && <QuestionnaireProgress />}
        {item.questions.map((question) => (
          <QuestionnaireItem key={question.id} name={question.id} multiple={question.multiSelect}>
            <QuestionnaireTitle>{question.question}</QuestionnaireTitle>
            {question.header && question.header !== question.question && (
              <QuestionnaireDescription>{question.header}</QuestionnaireDescription>
            )}
            {question.options.length > 0 && (
              <QuestionnaireChoices>
                {question.options.map((option) => (
                  <QuestionnaireChoice key={option.label} value={option.label}>
                    {option.label}
                    {option.description && (
                      <QuestionnaireChoiceDescription>
                        {option.description}
                      </QuestionnaireChoiceDescription>
                    )}
                  </QuestionnaireChoice>
                ))}
              </QuestionnaireChoices>
            )}
            <QuestionnaireInput
              placeholder={
                question.options.length > 0 ? "Or answer in your own words" : "Your answer"
              }
            />
          </QuestionnaireItem>
        ))}
        <QuestionnaireActions>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => respondQuestion(item.threadId, item.id, null)}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} data-icon="inline-start" />
              Dismiss
            </Button>
            <QuestionnairePrevious size="sm" />
          </div>
          <QuestionnaireSkip size="sm" />
          <QuestionnaireNext size="sm" />
          <QuestionnaireSubmit size="sm">
            {item.questions.length > 1 ? "Send answers" : "Send answer"}
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </Card>
  );
}

function ResolvedQuestion({ item }: { item: QuestionItem }) {
  const cancelled = item.status === "cancelled";
  return (
    <Trace>
      <div>
        <TraceLine>
          <TraceIcon>
            <HugeiconsIcon icon={MessageQuestionIcon} strokeWidth={1.8} />
          </TraceIcon>
          <TraceTitle>
            {cancelled
              ? "Dismissed the agent's questions"
              : item.questions.length === 1
                ? "Answered the agent's question"
                : "Answered the agent's questions"}
          </TraceTitle>
        </TraceLine>
      </div>
      {!cancelled && (
        <dl className="ml-[calc(--spacing(2)-1px)] flex flex-col gap-2 border-l pl-4 text-[13px]">
          {item.questions.map((question) => {
            const answer = item.answers?.[question.id];
            return (
              <div key={question.id} className="flex flex-col gap-0.5">
                <dt className="text-muted-foreground">{question.question}</dt>
                <dd className={cn(!answer?.length && "text-muted-foreground italic")}>
                  {answer?.length ? answer.join(", ") : "Skipped"}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </Trace>
  );
}
