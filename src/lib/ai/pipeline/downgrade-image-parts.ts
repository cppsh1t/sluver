/**
 * Image-part downgrader — Derived Model Input transform for chat image
 * attachments on non-vision models (ADR-0028, ADR-0044 D9).
 *
 * Image FileParts pass through unchanged for vision-capable models. When the
 * catalog (models.dev `modalities.input`) CONFIRMS the bound model does not
 * accept image input, this transform replaces each image FilePart in USER
 * messages with a filename-bearing TextPart marker:
 *
 * ```
 * [image attachment: "sunset.png" — image content NOT delivered: the bound model does not accept image input]
 * ```
 *
 * The marker carries the FILENAME (model-facing metadata), never the
 * attachment id — the future `look_at` tool resolves by filename within the
 * conversation. A missing provider error would be less informative than an
 * honest "not delivered" note the model can reason about.
 *
 * ## Tri-state `imageInputSupported`
 *
 * - `false` (catalog-confirmed non-vision) → downgrade.
 * - `true` → pass through unchanged.
 * - `undefined` (unknown — custom model id, catalog miss) → pass through
 *   UNCHANGED: custom OpenAI-compatible endpoints are usually deliberate
 *   vision setups; a provider error is more informative than silent
 *   degradation (D9 §3). The capability is resolved per-run in the app
 *   layer (ADR-0019 keeps this library free of catalog access); switching
 *   models mid-conversation just works because the transform re-runs on the
 *   whole input every turn.
 *
 * ## Purity (CRITICAL — ADR-0028 invariant 2, ADR-0019)
 *
 * PURE: same `{ messages, imageInputSupported }` input always produces the
 * same output. No React, no IPC, no logger, no I/O. The input array and
 * every element are treated as immutable; freshly constructed message
 * objects are emitted only where a rewrite was required. When the flag is
 * not `false`, or nothing matches, the input array reference is returned
 * verbatim (zero allocation). Message count and order are strictly
 * preserved (parts are mapped WITHIN messages — the invariant the
 * `Agent.run` `inputLength` slicing relies on).
 *
 * Related: ADR-0028 (three-layer model), ADR-0044 D9 (catalog-driven
 * downgrade).
 */

import type {
  FilePart,
  ImagePart,
  ModelMessage,
  TextPart,
} from "ai";

// ─── Marker formatting ───────────────────────────────────────────────────

/**
 * Build the downgrade marker TextPart for one image FilePart. The filename
 * is model-facing metadata and carried VERBATIM (no escaping — the marker is
 * prose, not markup); a missing filename falls back to `"unnamed"`.
 */
function toMarkerPart(part: FilePart): TextPart {
  const filename = part.filename ?? "unnamed";
  return {
    type: "text",
    text: `[image attachment: "${filename}" — image content NOT delivered: the bound model does not accept image input]`,
  };
}

/** A user-content array element eligible for downgrading. */
function isDowngradableImagePart(
  part: TextPart | ImagePart | FilePart,
): part is FilePart {
  return part.type === "file" && part.mediaType.startsWith("image/");
}

// ─── Core transform ───────────────────────────────────────────────────────

/**
 * Replace image FileParts in USER messages with downgrade markers when the
 * bound model is CONFIRMED to lack image input support (ADR-0044 D9).
 *
 * @param messages             The Derived Model Input, treated as immutable.
 * @param imageInputSupported  Tri-state capability flag. Only an explicit
 *                             `false` downgrades; `true` and `undefined`
 *                             (unknown / custom model) return the input
 *                             array reference unchanged.
 * @returns A new array with matching image FileParts replaced by marker
 *          TextParts. Message count and order are preserved. When the flag
 *          is not `false`, or nothing matched, the input array reference is
 *          returned verbatim.
 */
export function downgradeImageParts(
  messages: ModelMessage[],
  imageInputSupported: boolean | undefined,
): ModelMessage[] {
  // Pass-through for vision models AND for unknown capability (D9 §3).
  if (imageInputSupported !== false) return messages;

  // Pass 1: fast scan — bail out with the input reference when no user
  // message carries an image FilePart (text-only conversations).
  let found = false;
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const { content } = msg;
    if (typeof content === "string" || !Array.isArray(content)) continue;
    for (const part of content) {
      if (isDowngradableImagePart(part)) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) return messages;

  // Pass 2: rebuild — rewrite only the user messages that contain a match;
  // every other message (and every non-matching part) keeps its identity.
  const out: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") {
      out.push(msg);
      continue;
    }
    const { content } = msg;
    if (typeof content === "string" || !Array.isArray(content)) {
      out.push(msg);
      continue;
    }
    let touched = false;
    const rewritten = content.map((part) => {
      if (isDowngradableImagePart(part)) {
        touched = true;
        return toMarkerPart(part);
      }
      return part;
    });
    out.push(touched ? { ...msg, content: rewritten } : msg);
  }
  return out;
}
