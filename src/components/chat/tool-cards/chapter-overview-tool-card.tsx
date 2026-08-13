/**
 * Chapter-overview tool card — a special-case renderer for the
 * `get_chapter_overview` tool.
 *
 * The generic {@link ToolCard} cannot derive a structured preview for this tool
 * (`parseToolName` sees entity segment `chapter_overview`, which is not a
 * recognized entity), so without this dedicated renderer the call would fall
 * back to raw JSON. This card instead surfaces the chapter's title + summary
 * and a per-scene reference matrix (character / item / event counts + whether
 * a location is set), which is exactly what the agent asked the tool for: a
 * quick survey of what happens in the chapter and which worldbook entities it
 * touches — without the prose.
 *
 * ## Source of truth
 *
 * Renders from the **Persisted Thread** (ADR-0028 invariant 1) via
 * {@link ToolBlockData}. The output contract is
 * `{ chapter: Chapter, scenes: SceneOverview[] }` — every field is narrowed
 * defensively from `unknown` so the UI never crashes on malformed data.
 *
 * ## Visual
 *
 * Mirrors the generic tool-card chrome (collapsible header + bordered body,
 * same oklch semantic tokens) but replaces the snake_case code badge with a
 * chapter glyph + "章节概览「title」" headline, and shows a scene-count status
 * line on the right. The body lists each scene as a row (title + a ref-count
 * meta line), giving the user a scannable matrix of the chapter's references.
 *
 * @see PlanToolCard — the precedent for special-case dispatch in ToolCard.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  ChevronDownIcon,
  Layers02Icon,
} from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import type { ToolBlockData } from "../message-render";
import { asString, isRecord, unwrapToolOutput } from "../tool-summary";

// ─── Defensive overview narrowing ──────────────────────────────────────────

/** A single scene's display-relevant fields (counts only — no IDs/prose). */
interface SceneOverviewView {
  readonly title: string;
  readonly characterCount: number;
  readonly itemCount: number;
  readonly eventCount: number;
  readonly hasLocation: boolean;
}

/** The chapter-overview shape extracted from the tool output. */
interface ChapterOverviewView {
  readonly chapterTitle: string;
  readonly chapterSummary: string;
  readonly scenes: readonly SceneOverviewView[];
}

/**
 * Resolve the chapter overview from the tool block's output.
 *
 * Returns `null` when the output is absent or malformed (e.g. still streaming,
 * or corrupted JSON) so the caller can render a pending / fallback state.
 */
function resolveOverview(tool: ToolBlockData): ChapterOverviewView | null {
  const out = unwrapToolOutput(tool.output);
  if (!isRecord(out)) return null;
  const chapter = isRecord(out.chapter) ? out.chapter : null;
  if (!chapter) return null;

  const rawScenes = Array.isArray(out.scenes) ? out.scenes : [];
  const scenes: SceneOverviewView[] = [];
  for (const s of rawScenes) {
    if (!isRecord(s)) continue;
    scenes.push({
      title: asString(s.title) ?? "",
      characterCount: Array.isArray(s.characterRefs) ? s.characterRefs.length : 0,
      itemCount: Array.isArray(s.itemIds) ? s.itemIds.length : 0,
      eventCount: Array.isArray(s.eventIds) ? s.eventIds.length : 0,
      hasLocation: asString(s.locationId) != null,
    });
  }

  return {
    chapterTitle: asString(chapter.title) ?? "",
    chapterSummary: asString(chapter.summary) ?? "",
    scenes,
  };
}

/**
 * Build the per-scene reference meta line from non-zero counts.
 *
 * Only includes entity kinds that actually have references, joined by a
 * middot — a scene with no refs renders no line at all (cleaner than showing
 * "0 角色 · 0 物品 · 0 事件"). Reuses the existing entity labels so the
 * vocabulary stays consistent with the rest of the tool-card surface.
 */
function sceneRefParts(
  scene: SceneOverviewView,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string[] {
  const parts: string[] = [];
  if (scene.characterCount > 0) {
    parts.push(`${scene.characterCount} ${t("chat:tool.entity.character")}`);
  }
  if (scene.itemCount > 0) {
    parts.push(`${scene.itemCount} ${t("chat:tool.entity.item")}`);
  }
  if (scene.eventCount > 0) {
    parts.push(`${scene.eventCount} ${t("chat:tool.entity.event")}`);
  }
  if (scene.hasLocation) {
    parts.push(t("chat:tool.chapterOverview.hasLocation"));
  }
  return parts;
}

// ─── Main component ────────────────────────────────────────────────────────

interface ChapterOverviewToolCardProps {
  /** The unified tool block (persisted or live) for a `get_chapter_overview` call. */
  readonly tool: ToolBlockData;
}

export function ChapterOverviewToolCard({ tool }: ChapterOverviewToolCardProps) {
  const { t } = useTranslation("chat");
  // Expanded while running (so the user sees the result land); collapsed when
  // done, consistent with other read tools (get_chapter / list_scenes).
  const [open, setOpen] = useState(tool.status === "running");

  const overview = resolveOverview(tool);
  const isRunning = tool.status === "running";
  const isError = tool.status === "error" && tool.error != null;
  const sceneCount = overview?.scenes.length ?? 0;

  // Right-aligned header status line.
  const statusLine = isError
    ? t("chat:tool.error")
    : isRunning
      ? t("chat:tool.chapterOverview.loading")
      : t("chat:tool.chapterOverview.sceneCount", { count: sceneCount });

  // Header title: "章节概览" + quoted chapter title when available.
  const titleBase = t("chat:tool.chapterOverview.title");
  const headerTitle = overview?.chapterTitle
    ? titleBase + t("chat:tool.nameQuote", { name: overview.chapterTitle })
    : titleBase;

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
            icon={Layers02Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        )}
        <span className="min-w-0 truncate text-xs font-semibold">
          {headerTitle}
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

      {open && (
        <div className="border-t border-border/60 px-2.5 py-2">
          {isError ? (
            <pre className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 p-2 font-mono text-[0.6875rem] leading-relaxed text-destructive">
              {tool.error?.message || tool.error?.code || t("chat:tool.error")}
            </pre>
          ) : overview && sceneCount > 0 ? (
            <div className="flex flex-col gap-1.5">
              {overview.chapterSummary && (
                <p className="line-clamp-2 text-xs text-muted-foreground">
                  {overview.chapterSummary}
                </p>
              )}
              <ul className="flex flex-col gap-1">
                {overview.scenes.map((scene, idx) => {
                  const refParts = sceneRefParts(scene, t);
                  return (
                    <li key={idx} className="flex flex-col gap-0.5">
                      <span className="truncate text-[0.75rem] font-medium">
                        {scene.title || t("chat:tool.chapterOverview.untitledScene")}
                      </span>
                      {refParts.length > 0 && (
                        <span className="text-[0.625rem] text-muted-foreground/70">
                          {refParts.join(" · ")}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : overview && sceneCount === 0 ? (
            <p className="text-[0.6875rem] italic text-muted-foreground">
              {t("chat:tool.chapterOverview.noScenes")}
            </p>
          ) : (
            // No output yet (streaming) — show the loading label.
            <p className="text-[0.6875rem] text-muted-foreground">
              {t("chat:tool.chapterOverview.loading")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
