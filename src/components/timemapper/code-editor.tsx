import { useEffect, useRef } from "react";
import { basicSetup, EditorView } from "codemirror";
import { javascript } from "@codemirror/lang-javascript";

import { cn } from "@/lib/utils";

/**
 * Monospace stack shared with chat code blocks (no `--font-mono` token is
 * defined). Inlined here because `markdown.tsx` keeps its copy local — kept
 * verbatim so a future extraction lands on the same string.
 */
const MONO_STACK =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

/** Dark surface matching chat code blocks for visual consistency. */
const darkTheme = EditorView.theme({
  "&": {
    backgroundColor: "#18181b", // zinc-900
    color: "#e4e4e7", // zinc-200
    height: "100%",
  },
  ".cm-content": {
    fontFamily: MONO_STACK,
    caretColor: "#a1a1aa", // zinc-400
    padding: "0.75rem",
  },
  ".cm-gutters": {
    backgroundColor: "#18181b",
    color: "#52525b", // zinc-600
    border: "none",
  },
  "&.cm-focused": {
    outline: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "#27272a", // zinc-800
  },
  ".cm-activeLineGutter": {
    backgroundColor: "#27272a",
  },
});

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/**
 * Controlled CodeMirror 6 wrapper for the TimeMapper source editor (ADR-0026).
 *
 * The editor is created once on mount against a ref'd div. External `value`
 * changes (e.g. "reset to template") are reconciled by diffing the current
 * doc — only dispatching a change transaction when they actually diverge, so
 * caret jumps are avoided while the user is typing.
 *
 * Uses `view.dispatch` / `view.state` instead of importing `EditorState`
 * directly: under pnpm strict isolation only `@codemirror/lang-javascript` is
 * a direct dep, and `EditorState` offers nothing the live view doesn't expose.
 */
export function CodeEditor({ value, onChange, className }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest `onChange` so the updateListener closure (captured once at mount)
  // always invokes the freshest handler without recreating the editor.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const view = new EditorView({
      doc: value,
      extensions: [
        basicSetup,
        javascript(),
        EditorView.lineWrapping,
        darkTheme,
        EditorView.updateListener.of((vu) => {
          if (vu.docChanged) {
            onChangeRef.current(vu.state.doc.toString());
          }
        }),
      ],
      parent: host,
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally dep-free: the editor is built once per mount. `value` is
    // reconciled by the separate effect below; `onChange` via `onChangeRef`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconcile external `value` → editor doc. Skip when the editor already
  // holds the same text (the common case while the user is typing) so we
  // never fight the caret.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      ref={hostRef}
      className={cn(
        "min-h-[400px] overflow-auto rounded-md border border-border bg-zinc-900",
        className,
      )}
    />
  );
}
