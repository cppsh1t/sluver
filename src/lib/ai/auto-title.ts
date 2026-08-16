/**
 * Automatic conversation titling (ADR-0040).
 *
 * A pure, React-free module that produces a short conversation title from the
 * first user message + last assistant reply, via ONE one-shot `generateText`
 * call. It is driven by the dedicated `"namer"` agent config — resolved live
 * by the Provider — and is NEVER user-invokable from the chat UI.
 *
 * Contract:
 * - No tools, no `AgentLoop`, no session — a single `generateText` round trip.
 * - Low temperature (~0.3) for deterministic, label-like output.
 * - The title MUST be in the SAME LANGUAGE as the user's message.
 * - Post-processing is aggressive (quote stripping, whitespace collapsing,
 *   hard length clamp) and NEVER returns an empty string — an emptied result
 *   throws, which the caller treats as a silent failure (`logger.warn` only).
 *
 * Related: ADR-0017 (manual step loop — deliberately NOT used here),
 * ADR-0023 (model resolved live from AgentConfig), ADR-0040 (auto-titling).
 */

import { generateText } from "ai";

import { createLanguageModel, type ResolvedModelConfig } from "@/lib/ai";

// ─── Constants ────────────────────────────────────────────────────────────

/** Low temperature — a title is a label, not creative prose. */
const TITLE_TEMPERATURE = 0.3;

/** The assistant reply is truncated before entering the prompt. */
const ASSISTANT_CONTEXT_CHARS = 1500;

/** Hard ceiling applied AFTER post-processing (DB column is generous; UI is not). */
const MAX_TITLE_LENGTH = 60;

const TITLE_SYSTEM_PROMPT = [
  "You generate concise titles for chat conversations.",
  "Reply with the title ONLY — no preamble, no explanation, no quotation marks.",
  "Keep it short: aim for at most 20 characters for CJK scripts, at most 6 words for Latin scripts.",
  "Do not end with a period or any trailing punctuation mark.",
  "Write the title in the SAME LANGUAGE as the user's message.",
].join("\n");

/**
 * Wrapping quote pairs stripped from the model output. Models love to wrap
 * short labels in quotes despite instructions; straight + curly + guillemet
 * + CJK corner/white-corner brackets cover the common offenders.
 */
const WRAPPING_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["\u201C", "\u201D"], // “ ”
  ["'", "'"],
  ["\u2018", "\u2019"], // ‘ ’
  ["\u00AB", "\u00BB"], // « »
  ["\u300C", "\u300D"], // 「 」
  ["\u300E", "\u300F"], // 『 』
];

// ─── Post-processing ──────────────────────────────────────────────────────

/** Repeatedly strip one matching wrapping quote pair from both ends. */
function stripWrappingQuotes(input: string): string {
  let out = input;
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const [open, close] of WRAPPING_QUOTE_PAIRS) {
      if (out.length >= 2 && out.startsWith(open) && out.endsWith(close)) {
        out = out.slice(1, -1).trim();
        stripped = true;
      }
    }
  }
  return out;
}

/**
 * Normalize raw model output into a storable title: trim, strip wrapping
 * quotes, collapse ALL whitespace/newlines to single spaces, hard-clamp the
 * length. Returns `""` when nothing survives — the caller turns that into a
 * failure.
 */
export function cleanTitle(raw: string): string {
  let title = raw.trim();
  title = stripWrappingQuotes(title);
  title = title.replace(/\s+/g, " ").trim();
  if (title.length > MAX_TITLE_LENGTH) {
    title = title.slice(0, MAX_TITLE_LENGTH).trim();
  }
  return title;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Generate a conversation title via a single one-shot LLM call.
 *
 * @param config   The resolved `"namer"` agent model config (Provider gates
 *                 on it being ready before calling).
 * @param userText The FIRST user message of the conversation, in full.
 * @param assistantText The LAST assistant reply (truncated here to
 *                 {@link ASSISTANT_CONTEXT_CHARS} chars before prompting).
 * @returns The cleaned title (non-empty, ≤ 60 chars).
 * @throws When the model call fails or post-processing empties the output.
 *         Callers treat any throw as a silent failure — log + skip.
 */
export async function generateConversationTitle(
  config: ResolvedModelConfig,
  userText: string,
  assistantText: string,
): Promise<string> {
  const model = createLanguageModel(config);

  const truncatedAssistant = assistantText.slice(0, ASSISTANT_CONTEXT_CHARS);
  const prompt = [
    "User message:",
    userText,
    "",
    "Assistant reply (may be truncated):",
    truncatedAssistant,
    "",
    "Title:",
  ].join("\n");

  const { text } = await generateText({
    model,
    system: TITLE_SYSTEM_PROMPT,
    prompt,
    temperature: TITLE_TEMPERATURE,
  });

  const title = cleanTitle(text);
  if (title === "") {
    throw new Error(
      "auto-title: model output was empty after post-processing",
    );
  }
  return title;
}
