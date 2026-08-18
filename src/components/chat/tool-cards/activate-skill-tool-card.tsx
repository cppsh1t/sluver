/**
 * Activate-skill tool card — a special-case renderer for the `activate_skill`
 * tool (ADR-0043 §3, progressive disclosure).
 *
 * The generic {@link ToolCard} path cannot shape this call: the bare tool name
 * doesn't parse to an action_entity pair, and the output is an activation
 * result whose `body` is the skill's SKILL.md instructions — model-directed
 * prose that can be several KB and must NOT be dumped into the chat stream.
 * This card instead surfaces the activation *summary*: skill name, install
 * location, instruction line count and the bundled-file listing — exactly what
 * the user needs to see at a glance, with `read_skill_file` left to the model.
 *
 * ## Source of truth
 *
 * Renders from the **Persisted Thread** (ADR-0028 invariant 1) via
 * {@link ToolBlockData}. The output contract (see `src/lib/tools/skill.ts`) is
 * a discriminated union:
 * - fresh activation `{ status: "activated", name, body, files, location }`
 * - deduped repeat  `{ status: "already_active", name }` (per-conversation
 *   dedup — the body is already in the thread, nothing is reloaded).
 *
 * Every field is narrowed defensively from `unknown` so the UI never crashes
 * on malformed data (absent/malformed output renders a muted fallback line,
 * never a throw). While running, the skill name from the parsed input
 * (`{ name }`) is echoed in the header — the grep-card pending-query pattern.
 *
 * ## Visual
 *
 * Mirrors the timeline/grep tool-card chrome (collapsible header + bordered
 * body, same oklch semantic tokens, max-h-64 + overflow-y-auto scroll
 * container for the bundled files). `consentLevel: "auto"` — no approval UI,
 * same as the other skill tools.
 *
 * @see TimelineToolCard — the template this card mirrors.
 * @see GrepToolCard — the polished reference for list rows + pending echo.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  BookOpen01Icon,
  Cancel01Icon,
  ChevronDownIcon,
} from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import type { ToolBlockData } from "../message-render";
import { asString, asStringArray, isRecord, unwrapToolOutput } from "../tool-summary";

// ─── Defensive activation narrowing ────────────────────────────────────────

/** The activation shape extracted from the tool output. */
interface ActivationView {
  readonly status: "activated" | "already_active";
  readonly name: string;
  /** SKILL.md instructions — counted, never rendered (several KB of model prose). */
  readonly body: string | null;
  readonly files: readonly string[];
  readonly location: string | null;
}

/**
 * Resolve the activation from the tool block's output.
 *
 * Returns `null` when the output is absent or malformed (e.g. still streaming,
 * or corrupted JSON) so the caller can render a pending / fallback state.
 * An unknown `status` yields `null` — the status drives the body branch, and
 * a wrong branch is worse than a fallback line.
 */
function resolveActivation(tool: ToolBlockData): ActivationView | null {
  const out = unwrapToolOutput(tool.output);
  if (!isRecord(out)) return null;
  const status =
    out.status === "activated" || out.status === "already_active" ? out.status : null;
  if (!status) return null;
  return {
    status,
    name: asString(out.name) ?? "",
    // body/files/location only exist on the fresh-activation branch; the
    // already_active short-circuit carries just the name.
    body: status === "activated" ? asString(out.body) ?? null : null,
    files: status === "activated" ? asStringArray(out.files) : [],
    location: status === "activated" ? asString(out.location) ?? null : null,
  };
}

// ─── Main component ────────────────────────────────────────────────────────

interface ActivateSkillToolCardProps {
  /** The unified tool block (persisted or live) for an `activate_skill` call. */
  readonly tool: ToolBlockData;
}

export function ActivateSkillToolCard({ tool }: ActivateSkillToolCardProps) {
  const { t } = useTranslation("chat");
  // Expanded while running (so the user sees the result land); collapsed when
  // done, consistent with the other tool-card special cases.
  const [open, setOpen] = useState(tool.status === "running");

  const activation = resolveActivation(tool);
  const isRunning = tool.status === "running";
  const isError = tool.status === "error" && tool.error != null;

  // The skill name while the call is still streaming (output not landed yet):
  // safely narrowed from the parsed input, else the loading label.
  const pendingName = isRecord(tool.input) ? asString(tool.input.name) : undefined;

  // Instruction size indicator — line count of the SKILL.md body (computed,
  // never rendered: the body is model instructions, not user prose).
  const instructionLines = activation?.body
    ? activation.body.split("\n").length
    : 0;

  // Right-aligned header status line — file count on a fresh activation,
  // the short "already active" tag on a deduped repeat.
  const statusLine = isError
    ? tool.error?.code || t("chat:tool.error")
    : isRunning
      ? pendingName
        ? t("chat:tool.nameQuote", { name: pendingName })
        : t("chat:tool.activateSkill.loading")
      : activation?.status === "already_active"
        ? t("chat:tool.activateSkill.alreadyActive")
        : activation?.status === "activated"
          ? t("chat:tool.activateSkill.filesCount", {
              count: activation.files.length,
            })
          : t("chat:tool.activateSkill.noResult");

  const titleBase = t("chat:tool.activateSkill.title");

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
            icon={BookOpen01Icon}
            strokeWidth={2}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        )}
        <span className="min-w-0 truncate text-xs font-semibold">{titleBase}</span>
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
          ) : activation?.status === "already_active" ? (
            // Deduped repeat (ADR-0043 §3) — the instructions are already in
            // the thread; nothing was reloaded, so nothing more to show.
            <div className="flex flex-col gap-1">
              {activation.name && (
                <span className="min-w-0 truncate text-[0.75rem] font-medium">
                  {activation.name}
                </span>
              )}
              <p className="text-[0.6875rem] text-muted-foreground">
                {t("chat:tool.activateSkill.alreadyActiveDetail")}
              </p>
            </div>
          ) : activation?.status === "activated" ? (
            <div className="flex flex-col gap-1.5">
              {activation.name && (
                <span className="min-w-0 truncate text-[0.75rem] font-medium">
                  {activation.name}
                </span>
              )}
              {activation.location && (
                <p className="flex min-w-0 items-baseline gap-1.5 text-[0.625rem] text-muted-foreground/70">
                  <span className="shrink-0">
                    {t("chat:tool.activateSkill.location")}
                  </span>
                  <code className="min-w-0 truncate font-mono text-xs text-foreground/80">
                    {activation.location}
                  </code>
                </p>
              )}
              {instructionLines > 0 && (
                <p className="text-[0.625rem] text-muted-foreground/70">
                  {t("chat:tool.activateSkill.instructionsLines", {
                    count: instructionLines,
                  })}
                </p>
              )}
              {activation.files.length > 0 ? (
                <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
                  {activation.files.map((file, idx) => (
                    <li
                      key={idx}
                      className="min-w-0 truncate font-mono text-[0.6875rem] text-foreground/80"
                    >
                      {file}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[0.6875rem] italic text-muted-foreground">
                  {t("chat:tool.activateSkill.noFiles")}
                </p>
              )}
            </div>
          ) : isRunning ? (
            // No output yet (streaming) — show the loading label.
            <p className="text-[0.6875rem] text-muted-foreground">
              {t("chat:tool.activateSkill.loading")}
            </p>
          ) : (
            // Done with no (or an unparseable) result — muted fallback, never
            // a crash on malformed data.
            <p className="text-[0.6875rem] italic text-muted-foreground">
              {t("chat:tool.activateSkill.noResult")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
