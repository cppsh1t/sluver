/**
 * Timeline-lookup tool card — a special-case renderer for the
 * `timeline_lookup` tool.
 *
 * The generic {@link ToolCard} cannot derive a structured preview for this
 * tool (`parseToolName` sees the unrecognized compound name `timeline_lookup`,
 * so the call falls back to raw JSON). This card instead surfaces the
 * in-world chronology as a scannable entry list — kind glyph, name, story-time
 * start, location and a participant preview — which is exactly what the agent
 * asked the tool for: a survey of what happens when, without the prose.
 *
 * ## Source of truth
 *
 * Renders from the **Persisted Thread** (ADR-0028 invariant 1) via
 * {@link ToolBlockData}. The output contract is
 * `{ entries: TimelineEntry[], total: number, truncated: boolean }` — every
 * field is narrowed defensively from `unknown` so the UI never crashes on
 * malformed data (malformed rows are skipped, never thrown).
 *
 * ## Visual
 *
 * Mirrors the generic tool-card chrome (collapsible header + bordered body,
 * same oklch semantic tokens). Entry start times render through
 * {@link FormattedTime} because timeline dates are in-world chronology
 * (mapped by the World's TimeMapper), NOT wall-clock time — dayjs must never
 * touch them. The entry list reuses the webSearch scroll-container precedent
 * (max-height + overflow-y-auto) so long timelines don't grow the card.
 *
 * @see ChapterOverviewToolCard — the template this card mirrors.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlignLeftIcon,
  Calendar03Icon,
  Cancel01Icon,
  ChevronDownIcon,
  Time04Icon,
} from "@hugeicons/core-free-icons";

import { FormattedTime } from "@/components/timemapper/formatted-time";
import { cn } from "@/lib/utils";
import type { ToolBlockData } from "../message-render";
import { asString, asStringArray, isRecord, unwrapToolOutput } from "../tool-summary";

// ─── Defensive timeline narrowing ──────────────────────────────────────────

/** A single timeline entry's display-relevant fields (no IDs / full prose). */
interface TimelineEntryView {
  readonly kind: "event" | "scene";
  readonly name: string;
  readonly startAt: string | null;
  readonly locationName: string | null;
  readonly participants: readonly string[];
}

/** The timeline shape extracted from the tool output. */
interface TimelineView {
  readonly entries: readonly TimelineEntryView[];
  readonly total: number;
  readonly truncated: boolean;
}

/**
 * Resolve the timeline from the tool block's output.
 *
 * Returns `null` when the output is absent or malformed (e.g. still streaming,
 * or corrupted JSON) so the caller can render a pending / fallback state.
 * Rows with an unknown `kind` are dropped rather than guessed at — the kind
 * drives the row glyph, and a wrong glyph is worse than a missing row.
 */
function resolveTimeline(tool: ToolBlockData): TimelineView | null {
  const out = unwrapToolOutput(tool.output);
  if (!isRecord(out)) return null;
  if (!Array.isArray(out.entries)) return null;

  const entries: TimelineEntryView[] = [];
  for (const e of out.entries) {
    if (!isRecord(e)) continue;
    const kind = e.kind === "event" || e.kind === "scene" ? e.kind : null;
    if (!kind) continue;
    entries.push({
      kind,
      name: asString(e.name) ?? "",
      startAt: asString(e.startAt) ?? null,
      locationName: asString(e.locationName) ?? null,
      participants: asStringArray(e.participants),
    });
  }

  return {
    entries,
    total: typeof out.total === "number" ? out.total : entries.length,
    truncated: out.truncated === true,
  };
}

/**
 * Build a timeline entry's meta line from its optional fields.
 *
 * Only includes fields that are actually present, joined by a middot — an
 * entry with no location and no participants renders no line at all. The
 * participant preview shows the first 2 names plus a "+N" overflow marker.
 */
function entryMetaParts(
  entry: TimelineEntryView,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string[] {
  const parts: string[] = [
    entry.kind === "event"
      ? t("chat:tool.timeline.kindEvent")
      : t("chat:tool.timeline.kindScene"),
  ];
  if (entry.locationName) parts.push(entry.locationName);
  if (entry.participants.length > 0) {
    const preview = entry.participants.slice(0, 2).join(", ");
    const rest = entry.participants.length - 2;
    parts.push(rest > 0 ? `${preview} +${rest}` : preview);
  }
  return parts;
}

// ─── Main component ────────────────────────────────────────────────────────

interface TimelineToolCardProps {
  /** The unified tool block (persisted or live) for a `timeline_lookup` call. */
  readonly tool: ToolBlockData;
}

export function TimelineToolCard({ tool }: TimelineToolCardProps) {
  const { t } = useTranslation("chat");
  // Expanded while running (so the user sees the result land); collapsed when
  // done, consistent with other read tools (get_chapter / list_scenes).
  const [open, setOpen] = useState(tool.status === "running");

  const timeline = resolveTimeline(tool);
  const isRunning = tool.status === "running";
  const isError = tool.status === "error" && tool.error != null;
  const entryCount = timeline?.entries.length ?? 0;

  // Right-aligned header status line.
  const statusLine = isError
    ? tool.error?.code || t("chat:tool.error")
    : isRunning
      ? t("chat:tool.timeline.loading")
      : t("chat:tool.timeline.entryCount", { count: timeline?.total ?? entryCount });

  const titleBase = t("chat:tool.timeline.title");

  return (
    <div className="overflow-hidden rounded-lg border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={titleBase}
        className={cn(
          "flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left outline-none transition-colors",
          "focus-visible:ring-2 focus-visible:ring-ring/30",
          "hover:bg-muted/50",
        )}
      >
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
            icon={Time04Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        )}
        <span className="min-w-0 truncate text-xs font-semibold">{titleBase}</span>
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

      {open && (
        <div className="border-t border-border/60 px-2.5 py-2">
          {isError ? (
            <pre className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 p-2 font-mono text-[0.6875rem] leading-relaxed text-destructive">
              {tool.error?.message || tool.error?.code || t("chat:tool.error")}
            </pre>
          ) : timeline && entryCount > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-[0.625rem] text-muted-foreground/70">
                {t("chat:tool.timeline.shownCount", {
                  shown: entryCount,
                  total: timeline.total,
                })}
                {timeline.truncated &&
                  ` · ${t("chat:tool.timeline.truncated", { total: timeline.total })}`}
              </p>
              <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto pr-1">
                {timeline.entries.map((entry, idx) => {
                  const metaParts = entryMetaParts(entry, t);
                  return (
                    <li key={idx} className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1">
                        <HugeiconsIcon
                          icon={entry.kind === "event" ? Calendar03Icon : AlignLeftIcon}
                          strokeWidth={2}
                          aria-hidden
                          className="size-3 shrink-0 text-muted-foreground/70"
                        />
                        {entry.name ? (
                          <span className="min-w-0 truncate text-[0.75rem] font-medium">
                            {entry.name}
                          </span>
                        ) : (
                          <span className="min-w-0 truncate text-[0.75rem] font-medium text-muted-foreground/60">
                            —
                          </span>
                        )}
                        <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground/70">
                          {entry.startAt ? (
                            <FormattedTime iso={entry.startAt} />
                          ) : (
                            t("chat:tool.timeline.undated")
                          )}
                        </span>
                      </div>
                      {metaParts.length > 0 && (
                        <span className="pl-4 text-[0.625rem] text-muted-foreground/70">
                          {metaParts.join(" · ")}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : isRunning ? (
            // No output yet (streaming) — show the loading label.
            <p className="text-[0.6875rem] text-muted-foreground">
              {t("chat:tool.timeline.loading")}
            </p>
          ) : (
            // Done with no (or an empty) result — nothing on the timeline.
            <p className="text-[0.6875rem] italic text-muted-foreground">
              {t("chat:tool.timeline.noEntries")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
