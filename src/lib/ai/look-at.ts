/**
 * One-shot image description for the `look_at` tool (ADR-0045).
 *
 * A pure, React-free module that asks a vision-capable model what an image
 * shows, via ONE one-shot `generateText` call. It is driven by the dedicated
 * seeded `"vision"` agent config — resolved live by the Provider, same
 * "configured = enabled, silent when unconfigured" lifecycle as the `"namer"`
 * (ADR-0040) — and exists so chat models WITHOUT image input can still learn
 * what an image contains (the downgrade pipeline replaced those bytes with a
 * filename marker — see `pipeline/downgrade-image-parts.ts`).
 *
 * Contract:
 * - No tools, no `AgentLoop`, no session — a single `generateText` round trip.
 * - The image rides as an AI SDK v7 `FilePart` (`ImagePart` is deprecated):
 *   `{ type: "file", mediaType, data }` where `data` is either a full
 *   `data:` URL string (in-conversation attachment) or an https URL string
 *   (remote image). Both are valid `DataContent` values — the SDK splits
 *   data URLs into inline base64 and leaves http(s) URLs for provider-side
 *   passthrough (see {@link mediaTypeForImageUrl} for why the URL variant
 *   MUST carry a full `type/subtype` media type).
 * - Low temperature (~0.2) — this is observation, not creative prose.
 * - `abortSignal` is forwarded so a user Stop cancels the vision call.
 * - Post-processing (trim, collapse >2 blank lines) NEVER returns an empty
 *   string — an emptied result throws, which the tool converts into a
 *   model-recoverable error result.
 *
 * Purity (ADR-0019): no React, no `@/api` imports, no logger, no i18n.
 *
 * Related: ADR-0017 (manual step loop — deliberately NOT used here),
 * ADR-0023 (model resolved live from AgentConfig), ADR-0044 D9 (the
 * downgrade markers this module compensates for), ADR-0045 (look_at tool).
 */

import { generateText, type FilePart } from "ai";

import {
  createLanguageModel,
  type ResolvedModelConfig,
} from "@/lib/ai/provider/provider-factory";

// ─── Constants ────────────────────────────────────────────────────────────

/** Low temperature — a description is observation, not creative prose. */
const VISION_TEMPERATURE = 0.2;

const LOOK_AT_SYSTEM_PROMPT = [
  "You describe images for a consumer that can only read text.",
  "Be factual and concise: name what is visible — subjects, setting, actions, colors, notable text or UI elements, and overall style.",
  "Do not speculate beyond what the image shows; when something is ambiguous, say so briefly.",
  "If the user asks a specific question about the image, answer that question directly instead of giving a general description.",
  "No markdown headings, no preamble, no closing remarks.",
].join("\n");

// ─── Image sources ────────────────────────────────────────────────────────

/**
 * Where the image to describe comes from.
 *
 * - `"attachment"` — an image attached earlier in the conversation, resolved
 *   by filename from the Persisted Thread (hydrated `data:` URL + media
 *   type, ADR-0044 D3).
 * - `"url"` — a direct https URL of an image file.
 */
export type ImageSource =
  | {
      readonly kind: "attachment";
      readonly filename: string;
      /** Full `data:{mime};base64,…` URL as stored in the thread. */
      readonly dataUrl: string;
      readonly mediaType: string;
    }
  | {
      readonly kind: "url";
      readonly url: string;
    };

// ─── URL media type derivation ────────────────────────────────────────────

/**
 * Derive a FULL (`type/subtype`) image media type from an image URL's file
 * extension, defaulting to `image/jpeg`.
 *
 * WHY the URL variant cannot just say `mediaType: "image"` (verified against
 * the installed `ai@7.0.34` `dist/index.js`, `isUrlSupported` +
 * `downloadAssets`): provider URL passthrough is matched by media-type
 * PREFIX — a `supportedUrls` pattern of `image/*` becomes the prefix
 * `"image/"`, which a top-level `"image"` does NOT satisfy
 * (`"image".startsWith("image/")` is false). An unsupported URL would force
 * the SDK's fallback download (fetching the bytes through this process),
 * losing the provider's native URL handling. A full subtype derived from the
 * extension matches `image/*` patterns and keeps the URL passthrough intact.
 */
function mediaTypeForImageUrl(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "image/jpeg";
  }
  const dot = pathname.lastIndexOf(".");
  if (dot === -1) return "image/jpeg";
  const ext = pathname.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

// ─── Post-processing ──────────────────────────────────────────────────────

/**
 * Normalize raw model output into a storable description: trim, collapse any
 * run of 3+ newlines (2+ blank lines) to a single blank line. Returns `""`
 * when nothing survives — the caller turns that into a failure.
 */
export function cleanDescription(raw: string): string {
  return raw
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Describe one image via a single one-shot vision-model call.
 *
 * @param config      The resolved `"vision"` agent model config (the tool
 *                    gates on it being non-null before calling).
 * @param image       The image source — in-conversation attachment (data URL)
 *                    or direct remote URL.
 * @param question    Optional focus — what to look for / answer about the
 *                    image. `undefined` (or blank) = general description.
 * @param abortSignal Optional abort signal — forwarded to `generateText` so
 *                    a user Stop cancels the vision call.
 * @returns The cleaned description (non-empty).
 * @throws When the model call fails, is aborted, or post-processing empties
 *         the output. The tool converts non-abort throws into recoverable
 *         error results and re-throws on abort.
 */
export async function describeImage(
  config: ResolvedModelConfig,
  image: ImageSource,
  question: string | undefined,
  abortSignal: AbortSignal | undefined,
): Promise<string> {
  const model = createLanguageModel(config);

  // AI SDK v7 FilePart (`ImagePart` is deprecated). Both a full data-URL
  // string and an https URL string are valid `data` values — the SDK splits
  // data URLs into inline base64 (keeping the URL's own media type) and
  // passes http(s) URLs through when the provider declares support.
  const filePart: FilePart =
    image.kind === "attachment"
      ? {
          type: "file",
          mediaType: image.mediaType,
          data: image.dataUrl,
        }
      : {
          type: "file",
          mediaType: mediaTypeForImageUrl(image.url),
          data: image.url,
        };

  const trimmedQuestion = question?.trim();
  const promptText =
    trimmedQuestion !== undefined && trimmedQuestion !== ""
      ? `Look at the attached image and answer this question: ${trimmedQuestion}`
      : "Describe the attached image.";

  const { text } = await generateText({
    model,
    system: LOOK_AT_SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: [filePart, { type: "text", text: promptText }],
      },
    ],
    temperature: VISION_TEMPERATURE,
    abortSignal,
  });

  const description = cleanDescription(text);
  if (description === "") {
    throw new Error("look-at: model output was empty");
  }
  return description;
}
