/**
 * Image-part handler — Derived Model Input transform for chat image
 * attachments (ADR-0028, ADR-0044 D9, ADR-0048).
 *
 * User-message image FileParts are handled per the bound model's confirmed
 * image-input capability:
 *
 * - `false` (catalog-confirmed non-vision) → each image FilePart is
 *   REPLACED with a filename-bearing downgrade marker TextPart:
 *
 *   ```
 *   [image attachment: "sunset.png" — image content NOT delivered: the bound model does not accept image input]
 *   ```
 *
 * - `true` / `undefined` (vision-capable, or unknown — custom model id,
 *   catalog miss) → the image pixels PASS THROUGH untouched, and each
 *   image FilePart with a defined filename is FOLLOWED by a companion
 *   annotation TextPart:
 *
 *   ```
 *   [image attachment: "sunset.png" — image content delivered in this message]
 *   ```
 *
 * The companion exists because provider mappings DROP `FilePart.filename`
 * for image content (OpenAI `image_url` / Anthropic `source` carry only the
 * media type and bytes) — a TextPart is the only reliable filename channel.
 * It gives vision models the SAME filename handle non-vision models get via
 * the downgrade marker, so filename-addressed tools (`look_at`,
 * `set_*_image_from_attachment`, `add_scene_image_from_attachment` —
 * ADR-0045/0048) work identically on both paths; the shared
 * `[image attachment: "..."` prefix keeps tool teachings substring-
 * compatible across the two markers.
 *
 * In both branches the marker/annotation carries the FILENAME
 * (model-facing metadata), never the attachment id — the future `look_at`
 * tool resolves by filename within the conversation. A missing provider
 * error would be less informative than an honest note the model can reason
 * about.
 *
 * ## Tri-state `imageInputSupported`
 *
 * - `false` (catalog-confirmed non-vision) → downgrade.
 * - `true` → pass through WITH filename companion annotation.
 * - `undefined` (unknown — custom model id, catalog miss) → same as `true`:
 *   custom OpenAI-compatible endpoints are usually deliberate vision
 *   setups; a provider error is more informative than silent degradation
 *   (D9 §3). The capability is resolved per-run in the app layer (ADR-0019
 *   keeps this library free of catalog access); switching models
 *   mid-conversation just works because the transform re-runs on the whole
 *   input every turn.
 *
 * ## Purity (CRITICAL — ADR-0028 invariant 2, ADR-0019)
 *
 * PURE: same `{ messages, imageInputSupported }` input always produces the
 * same output. No React, no IPC, no logger, no I/O. The input array and
 * every element are treated as immutable; freshly constructed message
 * objects are emitted only where a rewrite was required. When no user
 * message contains a part eligible for the active mode (any image for the
 * downgrade; a filename-bearing image for the companion), the input array
 * reference is returned verbatim (zero allocation) — the invariant that
 * keeps text-only conversations allocation-free. Message count and order
 * are strictly preserved in both branches (parts change WITHIN messages —
 * the invariant the `Agent.run` `inputLength` slicing relies on).
 *
 * Related: ADR-0028 (three-layer model), ADR-0044 D9 (catalog-driven
 * downgrade), ADR-0048 (filename companion on the vision path).
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

/**
 * Build the companion annotation TextPart for one PASS-THROUGH image
 * FilePart. Filename verbatim, same rules as the downgrade marker — the
 * shared `[image attachment: "..."` prefix is what tool teachings point the
 * model at, so both texts must format identically up to the suffix. The
 * `"unnamed"` fallback is defensive only: eligibility requires a defined
 * filename (a companion with no name would be pure noise next to pixels
 * the model already sees).
 */
function toAnnotationPart(part: FilePart): TextPart {
  const filename = part.filename ?? "unnamed";
  return {
    type: "text",
    text: `[image attachment: "${filename}" — image content delivered in this message]`,
  };
}

/** A user-content array element eligible for downgrading. */
function isDowngradableImagePart(
  part: TextPart | ImagePart | FilePart,
): part is FilePart {
  return part.type === "file" && part.mediaType.startsWith("image/");
}

/**
 * A pass-through image eligible for the filename companion annotation.
 * Filename-less parts are skipped — there is nothing for the companion to
 * reference (unlike the `false` branch, whose downgrade marker still says
 * something useful via the `"unnamed"` fallback).
 */
function isAnnotatableImagePart(
  part: TextPart | ImagePart | FilePart,
): part is FilePart {
  return isDowngradableImagePart(part) && part.filename !== undefined;
}

// ─── Core transform ───────────────────────────────────────────────────────

/**
 * Handle image FileParts in USER messages per the bound model's confirmed
 * image-input capability (ADR-0044 D9, ADR-0048).
 *
 * @param messages             The Derived Model Input, treated as immutable.
 * @param imageInputSupported  Tri-state capability flag. `false` replaces
 *                             each image FilePart with a downgrade marker
 *                             TextPart; `true` and `undefined` (unknown /
 *                             custom model) pass the pixels through and
 *                             insert a filename companion annotation
 *                             TextPart immediately after each image that
 *                             HAS a filename.
 * @returns A new array when any user message was rewritten (downgraded or
 *          annotated); otherwise the input array reference verbatim.
 *          Message count and order are preserved in every case.
 */
export function downgradeImageParts(
  messages: ModelMessage[],
  imageInputSupported: boolean | undefined,
): ModelMessage[] {
  // Which parts this run acts on: every image (downgrade) or only images
  // carrying a filename (companion annotation). Selected once so both
  // passes agree on the fast-path bail-out condition.
  const eligible =
    imageInputSupported === false
      ? isDowngradableImagePart
      : isAnnotatableImagePart;

  // Pass 1: fast scan — bail out with the input reference when no user
  // message carries an eligible part (text-only conversations).
  let found = false;
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const { content } = msg;
    if (typeof content === "string" || !Array.isArray(content)) continue;
    for (const part of content) {
      if (eligible(part)) {
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
    if (imageInputSupported === false) {
      // Downgrade: image → marker, 1:1 (part count within the message is
      // unchanged).
      let touched = false;
      const rewritten = content.map((part) => {
        if (isDowngradableImagePart(part)) {
          touched = true;
          return toMarkerPart(part);
        }
        return part;
      });
      out.push(touched ? { ...msg, content: rewritten } : msg);
    } else {
      // Pass-through + companion: the image keeps its identity and gains a
      // trailing annotation TextPart (parts grow WITHIN the message —
      // message count, and every existing part's identity, are preserved).
      let touched = false;
      const rewritten = content.flatMap(
        (part): Array<TextPart | ImagePart | FilePart> => {
          if (isAnnotatableImagePart(part)) {
            touched = true;
            return [part, toAnnotationPart(part)];
          }
          return [part];
        },
      );
      out.push(touched ? { ...msg, content: rewritten } : msg);
    }
  }
  return out;
}
