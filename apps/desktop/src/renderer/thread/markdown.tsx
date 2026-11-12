import { Children, isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@dodocode/ui/lib/utils";
import { Code } from "./code";

const components: Components = {
  // A fenced block reaches `pre` with its `code` inside: show it as a code block.
  pre: ({ children }) => {
    const code = Children.toArray(children).find(isValidElement) as
      | { props: { className?: string; children?: ReactNode } }
      | undefined;
    const language = /language-(\S+)/.exec(code?.props.className ?? "")?.[1] ?? "";
    const value = String(code?.props.children ?? "").replace(/\n$/, "");
    return <Code value={value} language={language} className="my-3" />;
  },
  code: ({ className, children }) => (
    <code
      className={cn(
        "rounded-[5px] bg-muted px-1 py-px font-mono text-[0.88em] [overflow-wrap:anywhere]",
        className,
      )}
    >
      {children}
    </code>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
    >
      {children}
    </a>
  ),
  p: ({ children }) => <p className="my-2.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-2.5 list-disc space-y-1 pl-5 marker:text-muted-foreground">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2.5 list-decimal space-y-1 pl-5 marker:text-muted-foreground">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  h1: ({ children }) => (
    <h3 className="mt-5 mb-2 text-[1.15em] font-semibold first:mt-0">{children}</h3>
  ),
  h2: ({ children }) => (
    <h3 className="mt-5 mb-2 text-[1.08em] font-semibold first:mt-0">{children}</h3>
  ),
  h3: ({ children }) => <h4 className="mt-4 mb-1.5 font-semibold first:mt-0">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-4 mb-1.5 font-semibold first:mt-0">{children}</h5>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 pl-3 text-muted-foreground">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-border" />,
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-left text-[0.95em]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b bg-muted/50 px-2.5 py-1.5 font-medium">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b px-2.5 py-1.5 align-top [tr:last-child_&]:border-b-0">{children}</td>
  ),
  input: ({ checked, type }) =>
    type === "checkbox" ? (
      <input
        type="checkbox"
        checked={checked}
        readOnly
        className="mr-1.5 translate-y-px accent-primary"
      />
    ) : null,
};

const plugins = [remarkGfm];

/** The agent's words, in Markdown. */
export const Markdown = memo(function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 leading-relaxed wrap-break-word", className)}>
      <ReactMarkdown remarkPlugins={plugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
