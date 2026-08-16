/**
 * Markdown renderer for Notes — the notes-density sibling of
 * `chat/markdown.tsx` (same GFM + highlight pipeline, adapted component map).
 *
 * Where the chat variant is bubble-tight, this one is prose-first: generous
 * margins, comfortable line-height, `font-article` paragraphs — the reading
 * surface for outlines, foreshadowing, and working material (CONTEXT.md:
 * Notes are a writing-family surface, so the density follows the novel read
 * mode, not the chat transcript).
 *
 * The `pre`/`code` handling is identical to the chat variant and carries the
 * same rationale (react-markdown v10 dropped the `inline` prop; un-highlighted
 * fenced blocks must not render as inline chips) — see chat/markdown.tsx for
 * the full comment.
 */

import { isValidElement, memo, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

import { cn } from "@/lib/utils";

/** Monospace stack used for code (no `--font-mono` token is defined). */
const MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** True when a `code` className carries highlight.js block markers. */
function isHighlightedCode(className: string | undefined): boolean {
  return (
    className != null && (className.includes("hljs") || className.includes("language-"))
  );
}

const components: Components = {
  h1: ({ children }) => (
    <h1 className="mb-3 mt-8 font-heading text-2xl font-semibold leading-snug text-foreground first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-2 mt-8 font-heading text-xl font-semibold leading-snug text-foreground first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-2 mt-6 text-lg font-semibold leading-snug text-foreground first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1.5 mt-5 text-base font-semibold leading-snug text-foreground first:mt-0">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-1.5 mt-4 text-sm font-semibold leading-snug text-foreground first:mt-0">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1.5 mt-4 text-sm font-semibold leading-snug text-muted-foreground first:mt-0">
      {children}
    </h6>
  ),
  p: ({ children }) => (
    <p className="my-3 font-article text-base leading-8 text-foreground first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  ul: ({ children }) => (
    <ul className="my-3 list-disc space-y-1.5 pl-6 font-article text-base leading-8 text-foreground">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-3 list-decimal space-y-1.5 pl-6 font-article text-base leading-8 text-foreground">
      {children}
    </ol>
  ),
  li: ({ className, children }) => {
    // remark-gfm tags task-list items with `task-list-item`; hide their bullet.
    const isTask = className?.includes("task-list-item");
    return (
      <li
        className={cn(
          "font-article text-base leading-8 text-foreground",
          isTask && "list-none pl-0",
        )}
      >
        {children}
      </li>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-border pl-4 font-article text-base leading-8 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-4 hover:opacity-80"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-8 border-border" />,
  img: ({ src, alt }) => (
    <img
      src={typeof src === "string" ? src : undefined}
      alt={alt ?? ""}
      className="my-4 max-w-full rounded-lg"
    />
  ),
  table: ({ children }) => (
    <table className="my-4 w-full border-collapse text-sm [&_tr:last-child_td]:border-b-0">
      {children}
    </table>
  ),
  th: ({ children }) => (
    <th className="border-b border-border pb-1.5 pt-0 text-left font-medium align-top">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/50 px-1.5 py-1.5 align-top">{children}</td>
  ),
  pre: ({ children }) => {
    // `children` is the `<code>` element produced by the `code` override.
    // Reconstruct it so plain (un-highlighted) blocks don't keep the
    // inline-chip styling, while highlighted blocks keep their `hljs` classes.
    let codeClass: string | undefined;
    let codeBody: ReactNode = children;
    if (isValidElement(children)) {
      const childProps = children.props as {
        className?: string;
        children?: ReactNode;
      };
      codeClass = childProps.className;
      codeBody = childProps.children;
    }
    return (
      <pre
        className="my-4 overflow-x-auto rounded-lg bg-zinc-900 p-4 text-[0.8125rem] leading-relaxed dark:bg-zinc-950/80"
        style={{ fontFamily: MONO_STACK }}
      >
        <code className={isHighlightedCode(codeClass) ? codeClass : undefined}>
          {codeBody}
        </code>
      </pre>
    );
  },
  code: ({ className, children }) => {
    if (isHighlightedCode(className)) {
      return <code className={className}>{children}</code>;
    }
    return (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.8125rem] text-foreground">
        {children}
      </code>
    );
  },
  // remark-gfm task-list checkboxes: replace the raw disabled `<input>` with a
  // clean non-interactive indicator that reflects the checked state.
  input: ({ checked }) => (
    <span
      aria-hidden
      className={cn(
        "mr-1.5 inline-flex size-3.5 translate-y-[1px] items-center justify-center rounded-[3px] border text-[0.625rem] font-bold leading-none",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-muted-foreground/40 bg-transparent",
      )}
    >
      {checked ? "\u2713" : ""}
    </span>
  ),
};

function NoteMarkdownImpl({ content }: { readonly content: string }): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}

/**
 * Render note `content` as rich markdown. `memo`'d so re-renders only
 * re-parse when the `content` string actually changes (shallow prop compare).
 */
export const NoteMarkdown = memo(NoteMarkdownImpl);
