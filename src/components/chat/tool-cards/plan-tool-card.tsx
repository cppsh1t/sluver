/**
 * Plan tool card — a special-case renderer for the `plan` tool.
 *
 * Implements the **Q7.2(a)(i)** decision from the Plan-mode design grilling:
 * when the Agent calls the `plan` tool, the resulting card renders the Plan as
 * a read-only markdown-style checklist (pending items ☐, done items ☑), NOT as
 * generic JSON. The user never toggles items directly — they instruct the Agent
 * via chat, which rewrites the Plan wholesale on the next `plan` call (Q7.2(i):
 * strictly read-only UI, no interactive checkboxes).
 *
 * ## Source of truth
 *
 * This component renders from the **Persisted Thread** (ADR-0028 invariant 1).
 * It reads {@link ToolBlockData}, which the block builder (`buildBlocks`)
 * derives from the persisted `tool-result` part (when done) or the live
 * `StreamSegment` tool variant (while running). It never touches the Derived
 * Model Input — the user-visible Plan snapshot is exactly what was persisted.
 *
 * ## Plan resolution
 *
 * Prefers the tool OUTPUT's `plan` field — the post-execution snapshot written
 * by `src/lib/tools/system.ts` → `{ plan, pendingCount, doneCount }`. Falls
 * back to the tool INPUT's `items` while the call is still running (the result
 * has not arrived yet, so the input IS the Plan being set). Both shapes are
 * narrowed defensively from `unknown`: the tool output is a contract, but the
 * UI must not crash on malformed data (corrupted SQLite JSON, schema drift, a
 * model emitting unexpected fields).
 *
 * ## Visual
 *
 * Mirrors the generic {@link ToolCard} chrome (collapsible header + bordered
 * body, same oklch semantic tokens) but replaces the snake_case code badge with
 * a checklist glyph + "Plan" title, and swaps the generic status label for an
 * "X of Y done" progress subtitle. A hairline progress bar between header and
 * body makes the completion ratio tangible. Expanded by default because the
 * Plan is the Agent's persistent working agenda — unlike a transient CRUD call
 * (which collapses once done), the user benefits from seeing it at a glance.
 *
 * @see ADR-0028 — Persisted Thread is what the user sees.
 * @see ADR-0029 — `plan` tool + `planAccess` (Plan mode Phase 1).
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  CheckListIcon,
  CheckmarkSquare02Icon,
  ChevronDownIcon,
  Square01Icon,
} from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import type { ToolBlockData } from "../message-render";
import { isRecord, unwrapToolOutput } from "../tool-summary";

// ─── Defensive Plan narrowing ──────────────────────────────────────────────

/** A single normalized Plan item (defensive mirror of the library `PlanItem`). */
interface PlanItemView {
  readonly text: string;
  readonly status: "pending" | "done";
}

/**
 * Normalize a raw `items` value into a validated list of Plan items.
 *
 * Drops entries whose `text` is missing/empty (the `plan` tool schema requires
 * non-empty text, but a defensive UI assumes nothing about model output) and
 * coerces any unrecognized `status` to `"pending"`. Returns `null` when the
 * input is not a usable array, so the caller can render the empty/cleared state
 * rather than a confusing blank list.
 */
function normalizeItems(raw: unknown): PlanItemView[] | null {
  if (!Array.isArray(raw)) return null;
  const items: PlanItemView[] = [];
  for (const el of raw) {
    if (!isRecord(el)) continue;
    const text = typeof el.text === "string" ? el.text.trim() : "";
    if (text.length === 0) continue;
    const status: PlanItemView["status"] = el.status === "done" ? "done" : "pending";
    items.push({ text, status });
  }
  return items;
}

/**
 * Resolve the Plan items to render for a tool block.
 *
 * Prefers the OUTPUT's `plan.items` (the canonical post-execution snapshot);
 * falls back to the INPUT's `items` while the call is still running (the tool
 * result has not arrived, so the input is the Plan being set this turn).
 * Returns `null` when neither source yields a usable array.
 */
function resolvePlanItems(tool: ToolBlockData): PlanItemView[] | null {
  // Output may be wrapped in an AI SDK `{type:'json'|'text', value}` envelope
  // (persisted tool-result parts) or be the raw `{plan, pendingCount, …}` object
  // (live event). Unwrap uniformly, then dig into `.plan.items`.
  const out = unwrapToolOutput(tool.output);
  if (isRecord(out) && isRecord(out.plan)) {
    const fromOutput = normalizeItems(out.plan.items);
    if (fromOutput !== null) return fromOutput;
  }
  if (isRecord(tool.input)) {
    const fromInput = normalizeItems(tool.input.items);
    if (fromInput !== null) return fromInput;
  }
  return null;
}

// ─── Sub-components ────────────────────────────────────────────────────────

/**
 * A single read-only checklist row.
 *
 * Done items render a checked square + strikethrough muted text; pending items
 * render an empty square + full-color text. The icons are decorative — there is
 * no interactive control (Q7.2(i)).
 */
function PlanItemRow({ item }: { readonly item: PlanItemView }) {
  const done = item.status === "done";
  return (
    <li className="flex items-start gap-1.5">
      <HugeiconsIcon
        icon={done ? CheckmarkSquare02Icon : Square01Icon}
        strokeWidth={2}
        aria-hidden
        className={cn(
          "mt-[1px] size-3.5 shrink-0",
          done ? "text-foreground" : "text-muted-foreground/50",
        )}
      />
      <span
        className={cn(
          "text-[0.75rem] leading-relaxed",
          done ? "text-muted-foreground line-through" : "text-foreground",
        )}
      >
        {item.text}
      </span>
    </li>
  );
}

// ─── Main component ────────────────────────────────────────────────────────

interface PlanToolCardProps {
  /** The unified tool block (persisted or live) for a `plan` tool call. */
  readonly tool: ToolBlockData;
}

export function PlanToolCard({ tool }: PlanToolCardProps) {
  const { t } = useTranslation("chat");
  // Expanded by default: the Plan is the Agent's persistent working agenda, so
  // the user benefits from seeing it at a glance (unlike transient CRUD calls
  // which collapse when done). Still collapsible for long plans.
  const [open, setOpen] = useState(true);

  const items = resolvePlanItems(tool);
  const isRunning = tool.status === "running";
  const isError = tool.status === "error" && tool.error != null;
  const total = items?.length ?? 0;
  const doneCount = items?.filter((i) => i.status === "done").length ?? 0;
  const progressPct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  // Right-aligned header status line — completion ratio when done, the live
  // "updating" label while running, "Error" on failure, or "Plan cleared" for
  // an empty items array (the Agent set `items: []`).
  const statusLine = isError
    ? t("chat:tool.error")
    : isRunning
      ? t("chat:tool.plan.updating")
      : total === 0
        ? t("chat:tool.plan.empty")
        : t("chat:tool.plan.progress", { done: doneCount, total });

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={t("chat:tool.plan.title")}
        className={cn(
          "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring/30",
          "hover:bg-muted/50",
        )}
      >
        {/* Status-led: spinner / error / checklist glyph — reuses ToolCard vocabulary. */}
        {isRunning ? (
          <span className="relative flex size-3.5 shrink-0 items-center justify-center">
            <span className="absolute inline-flex size-3.5 animate-spin rounded-full border-[1.5px] border-muted-foreground/30 border-t-primary" />
          </span>
        ) : isError ? (
          <HugeiconsIcon
            icon={Cancel01Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0 text-destructive"
          />
        ) : (
          <HugeiconsIcon
            icon={CheckListIcon}
            strokeWidth={2}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        )}
        <span className="shrink-0 text-xs font-semibold">
          {t("chat:tool.plan.title")}
        </span>
        <span
          className={cn(
            "ml-auto shrink-0 text-[0.6875rem]",
            isError ? "text-destructive" : "text-muted-foreground",
            isRunning && "animate-pulse",
          )}
        >
          {statusLine}
        </span>
        <HugeiconsIcon
          icon={ChevronDownIcon}
          strokeWidth={2}
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Hairline progress bar — completion ratio at a glance. Hidden when the
          Plan has no items (an empty/cleared Plan has no meaningful ratio), and
          on error (the input items are only the Agent's intent, not persisted
          state — a bar would mislead the user into thinking the Plan landed). */}
      {total > 0 && !isError && (
        <div className="h-[2px] w-full bg-muted" role="progressbar" aria-label={statusLine}>
          <div
            className="h-full bg-primary transition-[width] duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {open && (
        <div className="border-t border-border/60 px-2.5 py-2">
          {isError ? (
            // Error: surface the failure (e.g. planAccess not wired, persistence
            // failure). Do not render the checklist — the Plan may not have been
            // written, and the input items are only the Agent's intent, not state.
            <pre className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 p-2 font-mono text-[0.6875rem] leading-relaxed text-destructive">
              {tool.error?.message || tool.error?.code || t("chat:tool.error")}
            </pre>
          ) : items !== null && items.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {items.map((item, idx) => (
                <PlanItemRow key={idx} item={item} />
              ))}
            </ul>
          ) : (
            // Empty / cleared Plan (the Agent set `items: []`).
            <p className="text-[0.6875rem] italic text-muted-foreground">
              {t("chat:tool.plan.empty")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
