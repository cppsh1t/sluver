/**
 * Markdown renderer for AI assistant replies — rich GFM markdown (headings,
 * lists, tables, blockquotes, links, inline/block code) with `rehype-highlight`
 * syntax highlighting, styled for chat-bubble-tight density.
 *
 * Deliberately does NOT use `@tailwindcss/typography` / `prose` (not installed,
 * and article spacing is wrong for a chat surface). Every element type is given
 * explicit Tailwind classes via the `components` prop.
 *
 * ## Code handling (react-markdown v10)
 *
 * The `code` override no longer receives an `inline` prop in v10. Block code is
 * always wrapped in `<pre><code>`. `rehype-highlight` (with default
 * `detect: false`) only adds `hljs` + `language-*` classes to code blocks that
 * declare a language — plain fenced blocks get NO class and would otherwise be
 * misrendered as inline chips inside the dark `<pre>`. To stay robust without
 * enabling `detect` (which spuriously colorizes plain text blocks), the `pre`
 * override reconstructs its inner `<code>`: it preserves the highlight classes
 * when present, and drops the inline-chip styling otherwise.
 *
 * `rehype-highlight` emits `hljs-*` token classes but ships no CSS — token
 * colors live at the end of `src/index.css`, tuned for the always-dark code
 * surface (`bg-zinc-900`).
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
    <h1 className="mb-1 mt-3 text-base font-semibold leading-tight text-foreground first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1 mt-3 text-[0.9375rem] font-semibold leading-tight text-foreground first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1 mt-2.5 text-sm font-semibold leading-tight text-foreground first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-0.5 mt-2 text-sm font-semibold leading-tight text-foreground first:mt-0">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-0.5 mt-2 text-[0.8125rem] font-semibold leading-tight text-foreground first:mt-0">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-0.5 mt-2 text-[0.8125rem] font-semibold leading-tight text-muted-foreground first:mt-0">
      {children}
    </h6>
  ),
  p: ({ children }) => (
    <p className="my-1 text-sm leading-relaxed text-foreground first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  ul: ({ children }) => (
    <ul className="my-1 list-disc pl-5 text-sm leading-relaxed text-foreground">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 list-decimal pl-5 text-sm leading-relaxed text-foreground">
      {children}
    </ol>
  ),
  li: ({ className, children }) => {
    // remark-gfm tags task-list items with `task-list-item`; hide their bullet.
    const isTask = className?.includes("task-list-item");
    return (
      <li
        className={cn(
          "my-0.5 text-sm leading-relaxed text-foreground",
          isTask && "list-none pl-0",
        )}
      >
        {children}
      </li>
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="my-1 border-l-2 border-border pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-2 border-border" />,
  table: ({ children }) => (
    <table className="my-2 w-full border-collapse text-xs [&_tr:last-child_td]:border-b-0">
      {children}
    </table>
  ),
  th: ({ children }) => (
    <th className="border-b border-border pb-1 pt-0 text-left font-medium align-top">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/50 px-1.5 py-1 align-top">{children}</td>
  ),
  pre: ({ children }) => {
    // `children` is the `<code>` element produced by the `code` override.
    // Reconstruct it so plain (un-highlighted) blocks don't keep the inline-chip
    // styling, while highlighted blocks keep their `hljs` token classes.
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
        className="my-2 overflow-x-auto rounded-lg bg-zinc-900 p-3 text-[0.8125rem] leading-relaxed dark:bg-zinc-950/80"
        style={{ fontFamily: MONO_STACK }}
      >
        <code className={isHighlightedCode(codeClass) ? codeClass : undefined}>
          {codeBody}
        </code>
      </pre>
    );
  },
  code: ({ className, children }) => {
    // Highlighted block code: preserve `hljs`/`language-*` classes so the token
    // CSS in index.css applies (the `pre` override provides the container).
    if (isHighlightedCode(className)) {
      return <code className={className}>{children}</code>;
    }
    // Inline code (and un-highlighted block code, which the `pre` override
    // neutralizes): render as a compact chip.
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

function MarkdownImpl({ content }: { readonly content: string }): ReactNode {
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
 * Render `content` as rich markdown. `memo`'d so streaming re-renders only
 * re-parse when the `content` string actually changes (shallow prop compare).
 */
export const Markdown = memo(MarkdownImpl);
