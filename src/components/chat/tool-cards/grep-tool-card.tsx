/**
 * Grep tool card — a special-case renderer for the `grep` tool (ADR-0035).
 *
 * `grep` is match-centric retrieval: occurrence evidence (snippet + where)
 * across all author-written text fields of every entity type, grouped by
 * `(entityType, entityId, fieldName)`. The generic {@link ToolCard} path
 * cannot shape this — the bare tool name doesn't parse to an action_entity
 * pair and the output isn't a single entity object — so this card surfaces
 * the query, the per-group match rows and the highlighted snippets directly:
 * exactly what the agent asked the tool for, without follow-up `get_*` calls.
 *
 * ## Source of truth
 *
 * Renders from the **Persisted Thread** (ADR-0028 invariant 1) via
 * {@link ToolBlockData}. The output contract is
 * `{ query, groups: [{ entityType, entityId, entityTitle, characterId,
 * characterName, fieldName, matchCount, snippets: [{ before, match, after }] }],
 * groupCount, truncated }` — every field is narrowed defensively from
 * `unknown` so the UI never crashes on malformed data (malformed rows are
 * skipped, never thrown).
 *
 * ## Visual
 *
 * Mirrors the timeline-tool-card chrome (collapsible header + bordered body,
 * same oklch semantic tokens, max-h-64 + overflow-y-auto scroll container).
 * Groups render in tool-output order (`matchCount` desc, computed Rust-side)
 * — never re-sorted here. Phase rows prepend the owning character's name
 * ("艾琳 · 少年期") because phase titles alone are ambiguous. Snippet `match`
 * fragments highlight with `text-primary` + `bg-primary/10` — no new color
 * tokens. v1 is READ-ONLY: no click-through navigation to entity editors
 * (ADR-0035 §8) — rows already carry entity IDs, so navigation can be added
 * later without contract change.
 *
 * @see TimelineToolCard — the template this card mirrors.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  ChevronDownIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import type { ToolBlockData } from "../message-render";
import type { EntityType } from "../tool-summary";
import { asString, isRecord, unwrapToolOutput } from "../tool-summary";
import { ENTITY_ICONS } from "./entity-icons";

// ─── Defensive grep narrowing ──────────────────────────────────────────────

/** A single three-part snippet (context / hit / context). */
interface GrepSnippetView {
  readonly before: string;
  readonly match: string;
  readonly after: string;
}

/** A single group's display-relevant fields (group = entity × field). */
interface GrepGroupView {
  readonly entityType: EntityType;
  readonly entityTitle: string;
  readonly characterName: string | null;
  readonly fieldName: string;
  readonly matchCount: number;
  readonly snippets: readonly GrepSnippetView[];
}

/** The grep shape extracted from the tool output. */
interface GrepView {
  readonly query: string | null;
  readonly groups: readonly GrepGroupView[];
  readonly groupCount: number;
  readonly truncated: boolean;
}

/**
 * Narrow an unknown value to a known entity type.
 *
 * Rows with an unknown `entityType` are dropped by {@link resolveGrepView}
 * rather than guessed at — the type drives the row glyph, and a wrong glyph
 * is worse than a missing row.
 */
function asEntityType(v: unknown): EntityType | null {
  return typeof v === "string" && v in ENTITY_ICONS ? (v as EntityType) : null;
}

/**
 * Resolve the grep result from the tool block's output.
 *
 * Returns `null` when the output is absent or malformed (e.g. still streaming,
 * or corrupted JSON) so the caller can render a pending / fallback state.
 * Individual malformed groups / snippets are skipped, never thrown.
 */
function resolveGrep(tool: ToolBlockData): GrepView | null {
  const out = unwrapToolOutput(tool.output);
  if (!isRecord(out)) return null;
  if (!Array.isArray(out.groups)) return null;

  const groups: GrepGroupView[] = [];
  for (const g of out.groups) {
    if (!isRecord(g)) continue;
    const entityType = asEntityType(g.entityType);
    if (!entityType) continue;

    const snippets: GrepSnippetView[] = [];
    if (Array.isArray(g.snippets)) {
      for (const s of g.snippets) {
        if (!isRecord(s)) continue;
        const match = asString(s.match);
        if (!match) continue;
        snippets.push({
          before: asString(s.before) ?? "",
          match,
          after: asString(s.after) ?? "",
        });
      }
    }

    groups.push({
      entityType,
      entityTitle: asString(g.entityTitle) ?? "",
      characterName: asString(g.characterName) ?? null,
      fieldName: asString(g.fieldName) ?? "",
      matchCount: typeof g.matchCount === "number" ? g.matchCount : 0,
      snippets,
    });
  }

  return {
    query: asString(out.query) ?? null,
    groups,
    groupCount: typeof out.groupCount === "number" ? out.groupCount : groups.length,
    truncated: out.truncated === true,
  };
}

// ─── Main component ────────────────────────────────────────────────────────

interface GrepToolCardProps {
  /** The unified tool block (persisted or live) for a `grep` call. */
  readonly tool: ToolBlockData;
}

export function GrepToolCard({ tool }: GrepToolCardProps) {
  const { t } = useTranslation("chat");
  // Expanded while running (so the user sees the result land); collapsed when
  // done, consistent with the other read-tool special cases.
  const [open, setOpen] = useState(tool.status === "running");

  const grep = resolveGrep(tool);
  const isRunning = tool.status === "running";
  const isError = tool.status === "error" && tool.error != null;
  const groupCount = grep?.groupCount ?? grep?.groups.length ?? 0;

  // The query while the call is still streaming (output not landed yet):
  // safely narrowed from the parsed input, else the generic running label.
  const pendingQuery = isRecord(tool.input) ? asString(tool.input.query) : undefined;

  // Right-aligned header status line — the one-line summary
  // 「query」 · N 组命中 when done with a result.
  const statusLine = isError
    ? tool.error?.code || t("chat:tool.error")
    : isRunning
      ? (pendingQuery
          ? t("chat:tool.nameQuote", { name: pendingQuery })
          : t("chat:tool.running"))
      : [
          grep?.query ? t("chat:tool.nameQuote", { name: grep.query }) : null,
          t("chat:tool.grepGroups", { count: groupCount }),
        ]
          .filter((part) => part !== null)
          .join(" · ");

  const titleBase = t("chat:tool.grepTitle");

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
            icon={Search01Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        )}
        <span className="min-w-0 shrink truncate text-xs font-semibold">{titleBase}</span>
        <span
          className={cn(
            "ml-auto min-w-0 shrink truncate text-[0.6875rem]",
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
          ) : grep && grep.groups.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto pr-1">
                {grep.groups.map((group, idx) => {
                  // Phase titles alone are ambiguous — prepend the owning
                  // character's name ("艾琳 · 少年期") when the group carries one.
                  const title =
                    group.entityType === "phase" && group.characterName
                      ? t("chat:tool.grepPhaseContext", {
                          name: group.characterName,
                          phase: group.entityTitle,
                        })
                      : group.entityTitle;
                  return (
                    <li key={idx} className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1">
                        <HugeiconsIcon
                          icon={ENTITY_ICONS[group.entityType]}
                          strokeWidth={2}
                          aria-hidden
                          className="size-3 shrink-0 text-muted-foreground/70"
                        />
                        {title ? (
                          <span className="min-w-0 truncate text-[0.75rem] font-medium">
                            {title}
                          </span>
                        ) : (
                          <span className="min-w-0 truncate text-[0.75rem] font-medium text-muted-foreground/60">
                            —
                          </span>
                        )}
                        {group.fieldName && (
                          <code className="ml-auto shrink-0 rounded bg-secondary px-1 py-0.5 font-mono text-[0.625rem] text-secondary-foreground">
                            {group.fieldName}
                          </code>
                        )}
                        <span className="shrink-0 text-[0.625rem] text-muted-foreground/70">
                          ×{group.matchCount}
                        </span>
                      </div>
                      {group.snippets.length > 0 && (
                        <div className="flex flex-col gap-0.5 pl-4">
                          {group.snippets.slice(0, 3).map((snippet, sIdx) => (
                            <p
                              key={sIdx}
                              className="break-all text-[0.6875rem] leading-relaxed"
                            >
                              {snippet.before && (
                                <span className="text-muted-foreground">
                                  {snippet.before}
                                </span>
                              )}
                              <span className="rounded bg-primary/10 px-0.5 font-medium text-primary">
                                {snippet.match}
                              </span>
                              {snippet.after && (
                                <span className="text-muted-foreground">
                                  {snippet.after}
                                </span>
                              )}
                            </p>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              {grep.truncated && (
                <p className="text-[0.625rem] text-muted-foreground/70">
                  {t("chat:tool.grepTruncated", {
                    count: grep.groupCount,
                    shown: grep.groups.length,
                  })}
                </p>
              )}
            </div>
          ) : isRunning ? (
            // No output yet (streaming) — show the running label.
            <p className="text-[0.6875rem] text-muted-foreground">
              {t("chat:tool.running")}
            </p>
          ) : (
            // Done with no (or an empty / unparseable) result — no matches.
            <p className="text-[0.6875rem] italic text-muted-foreground">
              {t("chat:tool.grepNoMatch")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
