/**
 * Token-usage footer rendered beneath an assistant message that carries
 * persisted usage (ADR-0030).
 *
 * Shape: `↑500 (180 cached)  ↓120`
 * - `↑` input (model read), `↓` output (model produced). Unicode glyphs, not
 *   icons — these are data readouts, not actions, so text glyphs read cleaner
 *   at the 11px metadata size than stroked icons.
 * - `null` ⇒ em-dash "—" (provider reported unknown); `0` ⇒ "0" (real zero).
 *   The distinction must survive end to end (ADR-0030 §4).
 * - The `(N cached)` paren annotates the cache-read HIT count and qualifies
 *   the input (cache hits lower the input cost). Shown only when there is a
 *   real hit (`> 0`) on the most recent turn's last assistant message — cache
 *   breakdown is ephemeral and not persisted (§5), so historical footers and
 *   zero-hit turns render no paren.
 * - `cacheWriteTokens` (Anthropic-only) is a secondary detail, surfaced as a
 *   native `title` tooltip on the cache paren — never a primary display.
 */

import { useTranslation } from "react-i18next";

import { formatTokenCount } from "@/lib/format";

interface MessageTokenFooterProps {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export function MessageTokenFooter({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
}: MessageTokenFooterProps) {
  const { t } = useTranslation("chat");

  // Only annotate when there is a real cache hit. A zero / undefined read is
  // not worth the visual noise (no cache activity to report).
  const cacheReadText =
    cacheReadTokens !== undefined && cacheReadTokens > 0
      ? formatTokenCount(cacheReadTokens)
      : null;
  const cacheWriteTitle =
    cacheReadText !== null &&
    cacheWriteTokens !== undefined &&
    cacheWriteTokens > 0
      ? t("chat:token.cacheWriteHint", {
          count: formatTokenCount(cacheWriteTokens),
        })
      : undefined;

  return (
    <div className="flex items-center gap-3 pt-0.5 text-[0.6875rem] tabular-nums text-muted-foreground/70">
      <span aria-label={t("chat:token.input")} className="flex items-center gap-0.5">
        <span aria-hidden className="translate-y-[0.05em]">
          ↑
        </span>
        {inputTokens === null ? "—" : formatTokenCount(inputTokens)}
      </span>
      {cacheReadText !== null && (
        <span title={cacheWriteTitle} className="text-muted-foreground/55">
          {t("chat:token.cached", { count: cacheReadText })}
        </span>
      )}
      <span aria-label={t("chat:token.output")} className="flex items-center gap-0.5">
        <span aria-hidden className="translate-y-[0.05em]">
          ↓
        </span>
        {outputTokens === null ? "—" : formatTokenCount(outputTokens)}
      </span>
    </div>
  );
}
