/**
 * Shared infra for the `set_<entity>_image_from_attachment` and
 * `add_scene_image_from_*` agent tools (ADR-0048).
 *
 * Mirrors {@link ./image-from-url.ts} for the attachment source: instead of
 * downloading from a URL, the bytes come from an in-conversation attachment
 * resolved by filename via `ctx.attachmentLookup` (the same zero-IPC reverse
 * channel the `look_at` tool uses — ADR-0045). The resolved bytes then go
 * through the Rust `prepare_image` command, which compresses them into the
 * entity's canonical form:
 *
 *   - entity portraits/covers → center-crop to the entity's
 *     {@link ENTITY_IMAGE_CROP_SPEC} aspect + exact dimensions, lossless
 *     WebP (the crop spec table lives in `./image-from-url.ts` — one table,
 *     both sources);
 *   - scene gallery images → fit-within {@link SCENE_IMAGE_MAX_DIMENSION}
 *     preserving aspect ratio (NO cropping — scenes keep whatever
 *     composition the source had), WebP.
 *
 * The routing through `prepare_image` is what reconciles the size budgets:
 * chat attachments may be up to 5 MiB, while entity image columns cap at
 * 1 MiB — every byte this module writes has been re-encoded under that
 * ceiling by the backend.
 *
 * Centralizes:
 *   - {@link filenameSchema} — the shared attachment-filename zod schema.
 *     Each entity tool extends it with its own id parameter (named per the
 *     matching `set_<entity>_image_from_url` convention).
 *   - {@link executeSetImageFromAttachment} — the common execute body for
 *     the 8 entity set tools.
 *   - {@link executeAddSceneImageFromUrl} / {@link executeAddSceneImageFromAttachment}
 *     — the scene-gallery add bodies (aspect-preserving downscale).
 *
 * Purity: imports only from `@/api/image` (IPC wrapper), `@/types` (the
 * `SceneImageMeta` result shape), `zod`, and the local `./image-from-url` +
 * `../types`. No React, no logger — matches the rest of the
 * `tools/worldbook/` module's purity contract (ADR-0019).
 */

import { z } from "zod";

import { prepareImage } from "@/api/image";
import type { SceneImageMeta } from "@/types";
import type { ToolContext } from "../types";
import type { EntityImageCropSpec } from "./image-from-url";

// ─── Shared input schema ───────────────────────────────────────────────────

/**
 * Zod schema for the `filename` parameter shared by every
 * `set_<entity>_image_from_attachment` / `add_scene_image_from_attachment`
 * tool. Description is intentionally prescriptive — the model's only
 * reliable handle on the exact filename is the `[image attachment: ...]`
 * marker riding next to the image in the user's message (a NOT-delivered
 * downgrade marker when the bound model cannot see images, a delivered
 * companion annotation when it can — the marker appears on both paths),
 * and a mis-copied filename is the #1 failure mode.
 */
export const filenameSchema = z
  .string()
  .min(1)
  .describe(
    "EXACT filename of an image attached in this conversation, copied character-for-character from inside the `[image attachment: \"...\" — ...]` marker in the user's message (the marker appears whether the image reached you as pixels or not). Do not guess or shorten it.",
  );

// ─── Results ───────────────────────────────────────────────────────────────

/**
 * Standard success result for every `set_<entity>_image_from_attachment`
 * tool. Mirrors the `{ updated: true }` shape of the from-URL tools.
 */
export interface SetImageFromAttachmentResult {
  readonly updated: true;
}

/**
 * Structured not-found result shared by every attachment-sourced tool.
 * Returned (NOT thrown) when `ctx.attachmentLookup.findByFilename` misses —
 * same convention as `look_at`'s `attachment_not_found`: the model may have
 * mis-copied the filename and should re-check the marker, not treat the
 * call shape as wrong.
 */
export interface AttachmentNotFoundResult {
  readonly error: "attachment_not_found";
  readonly filename: string;
  readonly message: string;
}

/** Build the structured {@link AttachmentNotFoundResult} for a miss. */
function attachmentNotFound(filename: string): AttachmentNotFoundResult {
  return {
    error: "attachment_not_found",
    filename,
    message: `attachment not found in this conversation: ${filename}. Re-check the EXACT filename inside the [image attachment: "..."] marker in the user's message.`,
  };
}

// ─── dataUrl → base64 payload ──────────────────────────────────────────────

/**
 * Strip a `data:{mime};base64,…` URL down to its base64 payload.
 *
 * Local helper — `@/lib/image-bytes` owns encode + sniff but has no decoder
 * (the only existing one, in `attachment-picker.ts`, decodes to TEXT).
 * Returns `""` for malformed input (no comma); the backend then rejects the
 * empty payload with a normal IPC error instead of this module throwing.
 */
function dataUrlBase64Payload(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma === -1 ? "" : dataUrl.slice(comma + 1);
}

// ─── Entity set: common execute body ───────────────────────────────────────

/**
 * Build the execute body shared by all `set_<entity>_image_from_attachment`
 * tools.
 *
 * Flow:
 *   1. `ctx.attachmentLookup.findByFilename(filename)` → hydrated bytes
 *      from the Persisted Thread (zero IPC). A miss returns a structured
 *      {@link AttachmentNotFoundResult} — NOT a throw.
 *   2. `prepareImage({ dataBase64, width, height })` → backend center-crops
 *      to the entity's canonical aspect, resizes to the exact dimensions,
 *      and re-encodes as lossless WebP under 1 MiB. This is the step that
 *      makes a ≤5 MiB attachment legal for the ≤1 MiB entity column.
 *   3. Hand the `Uint8Array` to the per-entity `mutator`, which performs
 *      the actual `update<Entity>Image` IPC write.
 *
 * Like {@link ./image-from-url.executeSetImageFromUrl}, the mutator is a
 * thin closure over `ctx.spaceId` / `ctx.worldId` / the entity's id — each
 * entity file stays self-contained.
 *
 * @param ctx       The tool runtime context (carries the attachment lookup).
 * @param filename  The attachment filename (validated by {@link filenameSchema}).
 * @param cropSpec  The entity's {@link ./image-from-url.ENTITY_IMAGE_CROP_SPEC} entry.
 * @param mutator   Per-entity IPC write closure.
 */
export async function executeSetImageFromAttachment(
  ctx: ToolContext,
  filename: string,
  cropSpec: EntityImageCropSpec,
  mutator: (bytes: Uint8Array, mime: "image/webp") => Promise<unknown>,
): Promise<SetImageFromAttachmentResult | AttachmentNotFoundResult> {
  const found = ctx.attachmentLookup.findByFilename(filename);
  if (!found) {
    return attachmentNotFound(filename);
  }

  const buffer = await prepareImage({
    dataBase64: dataUrlBase64Payload(found.dataUrl),
    width: cropSpec.outputWidth,
    height: cropSpec.outputHeight,
  });
  // `prepare_image`'s crop mode always outputs lossless WebP — same fixed
  // MIME contract as `fetch_and_prepare_image` (see commands/search.rs).
  await mutator(new Uint8Array(buffer), "image/webp");
  return { updated: true };
}

// ─── Scene gallery: aspect-preserving add bodies ───────────────────────────

/**
 * Longest-edge ceiling for scene gallery images. Unlike entity portraits
 * (fixed crop specs), gallery images keep their source aspect ratio and are
 * only downscaled to fit within this bound — mood-board material, not
 * avatars. 1600px comfortably covers the scene editor's display size while
 * keeping the WebP re-encode under the 1 MiB column ceiling.
 */
export const SCENE_IMAGE_MAX_DIMENSION = 1600;

/**
 * Execute body for `add_scene_image_from_url`: download + downscale.
 *
 * The mutator calls `addSceneImage`, so its result (the freshly appended
 * {@link SceneImageMeta}, including the backend-assigned position) is
 * returned to the model verbatim — the model needs the id for later
 * delete/look_at calls.
 */
export async function executeAddSceneImageFromUrl(
  ctx: ToolContext,
  url: string,
  mutator: (bytes: Uint8Array, mime: "image/webp") => Promise<SceneImageMeta>,
): Promise<SceneImageMeta> {
  // ctx is reserved for future per-call needs — same forward-compat note as
  // executeSetImageFromUrl.
  void ctx;

  const buffer = await prepareImage({
    url,
    maxDimension: SCENE_IMAGE_MAX_DIMENSION,
  });
  return mutator(new Uint8Array(buffer), "image/webp");
}

/**
 * Execute body for `add_scene_image_from_attachment`: resolve + downscale.
 *
 * Same not-found convention as {@link executeSetImageFromAttachment} — a
 * filename miss is a structured result, never a throw.
 */
export async function executeAddSceneImageFromAttachment(
  ctx: ToolContext,
  filename: string,
  mutator: (bytes: Uint8Array, mime: "image/webp") => Promise<SceneImageMeta>,
): Promise<SceneImageMeta | AttachmentNotFoundResult> {
  const found = ctx.attachmentLookup.findByFilename(filename);
  if (!found) {
    return attachmentNotFound(filename);
  }

  const buffer = await prepareImage({
    dataBase64: dataUrlBase64Payload(found.dataUrl),
    maxDimension: SCENE_IMAGE_MAX_DIMENSION,
  });
  return mutator(new Uint8Array(buffer), "image/webp");
}
