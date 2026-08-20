/**
 * Look-at tool — `look_at` (ADR-0045).
 *
 * Lets chat models WITHOUT image input learn what an image contains. The
 * downgrade pipeline (ADR-0044 D9) replaces image attachments with
 * `[image attachment: "filename" — image content NOT delivered…]` markers
 * for non-vision models; this tool resolves those markers (or a remote
 * image URL) into a textual description produced by the Space's dedicated
 * seeded `vision` agent — a one-shot `generateText` call over a
 * vision-capable model (`@/lib/ai/look-at`).
 *
 * Inputs resolve the image via EXACTLY ONE of:
 *   - `filename` — an in-conversation attachment, matched by the EXACT
 *     filename printed in the downgrade marker (via
 *     `ctx.attachmentLookup`, zero IPC — hydrated FileParts already live in
 *     the Persisted Thread);
 *   - `url` — a direct https URL of an image file.
 *
 * Consent level: `auto` (read-only observation — same classification as the
 * `search_*` / `web_fetch` tools, ADR-0025). Gated by REGISTRATION, not the
 * per-call approval gate: the tool only exists when the `"vision"`
 * AgentConfig is bound (`ctx.visionConfig != null` — "configured =
 * enabled", mirroring ADR-0040's namer and ADR-0042's shell gate).
 *
 * Abort semantics: a fired abort signal RE-THROWS so the run terminates
 * like other tools (ADR-0018); every other failure is returned as a
 * structured error result the model can recover from (same convention as
 * `context_read`'s `not_found` in `system.ts` — a throw would confuse the
 * model into thinking its call shape was wrong).
 */

import { z } from "zod";

import { describeImage, type ImageSource } from "@/lib/ai/look-at";
import type { ToolDef } from "./types";

/**
 * Widened input shape re-asserted at the execute boundary — the SDK hands
 * `execute` a parsed-but-`unknown` input (same cast pattern as `grep.ts`).
 */
interface LookAtToolInput {
  filename?: string;
  url?: string;
  question?: string;
}

const inputSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .optional()
      .describe(
        "EXACT filename of an image attached in this conversation, copied character-for-character from inside the `[image attachment: \"...\" — image content NOT delivered...]` marker in the user's message. Do not guess or shorten it.",
      ),
    url: z
      .string()
      .url()
      // https only — matches the description's promise and keeps provider
      // URL passthrough meaningful (see mediaTypeForImageUrl in the
      // one-shot module); data:/ftp:/plain-http links are rejected at the
      // schema instead of surfacing as a vision_failed result later.
      .refine((value) => value.startsWith("https://"), {
        message: "URL must start with https://",
      })
      .optional()
      .describe(
        'Direct https URL of an image FILE (e.g. "https://example.com/photo.jpg") — NOT a page containing the image. Use when the user references an image by link.',
      ),
    question: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional focus for the vision model: what to look for or answer about the image. Omit for a general description.",
      ),
  })
  .superRefine((val, ctx) => {
    // EXACTLY ONE of filename / url — the two resolution paths are mutually
    // exclusive by design (attachment bytes vs remote fetch).
    const hasFilename = val.filename !== undefined;
    const hasUrl = val.url !== undefined;
    if (hasFilename === hasUrl) {
      ctx.addIssue({
        code: "custom",
        path: [hasFilename ? "url" : "filename"],
        message:
          "Provide EXACTLY ONE of filename (in-conversation attachment) or url (remote image) — not both, not neither.",
      });
    }
  });

/** Look-at tool, keyed by `snake_case` name. */
export function lookAtTools(): Record<string, ToolDef> {
  return {
    look_at: {
      description:
        "Find out what an image shows when you cannot see it yourself — you do NOT receive image content directly. " +
        'Images the user attaches arrive as `[image attachment: "..." — image content NOT delivered...]` markers carrying only a filename, and image URLs are plain text. ' +
        "Call this tool with the EXACT filename from the marker (in-conversation attachment) or a direct image URL, and it returns a description produced by a separate vision model. " +
        "Pass `question` to focus on what you need to know. " +
        "Always use this BEFORE answering questions about an image's content.",
      inputSchema,
      consentLevel: "auto",
      execute: async (input, ctx, call) => {
        const { filename, url, question } = input as LookAtToolInput;

        // Defensive: the tool is only registered when visionConfig != null,
        // but execute may be invoked directly (tests) — keep the guard.
        if (!ctx.visionConfig) {
          return {
            error: "not_configured",
            message:
              'The vision agent is not configured for this Space, so images cannot be examined. Ask the user to bind a vision-capable model to the "vision" agent in Settings.',
          };
        }

        let source: ImageSource;
        if (filename !== undefined) {
          const found = ctx.attachmentLookup.findByFilename(filename);
          if (!found) {
            // Structured not-found, NOT a throw — the model may have
            // mis-copied the filename; suggest re-checking the marker so it
            // can retry with the exact string.
            return {
              error: "attachment_not_found",
              filename,
              message: `attachment not found in this conversation: ${filename}. Re-check the EXACT filename inside the [image attachment: "..."] marker in the user's message.`,
            };
          }
          source = {
            kind: "attachment",
            filename,
            dataUrl: found.dataUrl,
            mediaType: found.mediaType,
          };
        } else if (url !== undefined) {
          source = { kind: "url", url };
        } else {
          // Unreachable via the schema (exactly-one-of), defensive for
          // direct execute calls.
          return {
            error: "invalid_input",
            message: "Provide exactly one of filename or url.",
          };
        }

        try {
          const description = await describeImage(
            ctx.visionConfig,
            source,
            question,
            call.abortSignal,
          );
          return source.kind === "attachment"
            ? { filename: source.filename, description }
            : { url: source.url, description };
        } catch (e) {
          // Abort propagates — the run must terminate like other tools
          // (ADR-0018). Everything else is model-recoverable.
          if (call.abortSignal?.aborted) throw e;
          return {
            error: "vision_failed",
            message: `look_at failed: ${e instanceof Error ? e.message : String(e)}`,
          };
        }
      },
    },
  };
}
