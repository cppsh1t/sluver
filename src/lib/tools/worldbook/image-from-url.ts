/**
 * Shared infra for the `set_<entity>_image_from_url` agent tools.
 *
 * Centralizes:
 *   - {@link ENTITY_IMAGE_CROP_SPEC} — per-entity crop dimensions (aspect +
 *     output width/height). MUST stay in sync with the per-form constants
 *     scattered across `*-form-dialog.tsx` (world 16/9 640×360, character
 *     3/4 300×400, etc.). When a form dialog changes its crop spec, update
 *     this table to match — both paths drive the same `image_blob` columns.
 *   - {@link imageUrlSchema} — the shared image-URL zod schema. Each entity
 *     tool extends it with its own id parameter (named per existing
 *     convention: `id` for most, `phaseId` for phase, `worldId` unused
 *     because World is keyed by `ctx.worldId`).
 *   - {@link executeSetImageFromUrl} — the common execute body: call
 *     `fetchAndPrepareImage` to download + center-crop + resize + WebP-encode,
 *     then forward the bytes to a per-entity mutator closure that performs
 *     the actual `update<Entity>Image` IPC write.
 *
 * Purity: imports only from `@/api/search` (IPC wrapper), `zod`, and the
 * local `../types`. No React, no logger — matches the rest of the
 * `tools/worldbook/` module's purity contract (ADR-0019).
 */

import { z } from "zod";

import { fetchAndPrepareImage } from "@/api/search";
import type { ToolContext } from "../types";

// ─── Per-entity crop specs ─────────────────────────────────────────────────

export interface EntityImageCropSpec {
  /** Target crop aspect (width / height), e.g. `16/9`, `3/4`, `1`. */
  readonly aspect: number;
  /** Export width in pixels. */
  readonly outputWidth: number;
  /** Export height in pixels. */
  readonly outputHeight: number;
}

/**
 * Per-entity crop specs for the agent's image-from-URL tools.
 *
 * Mirrors the form dialogs — each form passes these constants to
 * `ImageCropDialog`, which uses them for the user's interactive crop. For
 * the agent path we feed the same values into `fetchAndPrepareImage`'s
 * server-side center-crop, so a user-uploaded image and an agent-downloaded
 * image land in the same `image_blob` column at the same dimensions.
 *
 * Source of truth — keep aligned with:
 *   - `create-world-dialog.tsx` / `edit-world-dialog.tsx` (world: 16/9, 640×360)
 *   - `character-form-dialog.tsx`                (character: 3/4, 300×400)
 *   - `phase-card.tsx`                           (phase: 3/4, 300×400)
 *   - `element-form-dialog.tsx` → `ELEMENT_CROP_SPEC`
 *                                               (location: 4/3, 400×300)
 *                                               (item/lore: 1, 256×256)
 *   - `event-form-dialog.tsx`                    (event: 16/9, 640×360)
 *   - `novel-form-dialog.tsx`                    (novel: 2/3, 320×480)
 */
export const ENTITY_IMAGE_CROP_SPEC = {
  world: { aspect: 16 / 9, outputWidth: 640, outputHeight: 360 },
  character: { aspect: 3 / 4, outputWidth: 300, outputHeight: 400 },
  phase: { aspect: 3 / 4, outputWidth: 300, outputHeight: 400 },
  location: { aspect: 4 / 3, outputWidth: 400, outputHeight: 300 },
  item: { aspect: 1, outputWidth: 256, outputHeight: 256 },
  lore: { aspect: 1, outputWidth: 256, outputHeight: 256 },
  event: { aspect: 16 / 9, outputWidth: 640, outputHeight: 360 },
  novel: { aspect: 2 / 3, outputWidth: 320, outputHeight: 480 },
} as const satisfies Record<string, EntityImageCropSpec>;

// ─── Shared input schema ───────────────────────────────────────────────────

/**
 * Zod schema for the `imageUrl` parameter shared by every
 * `set_<entity>_image_from_url` tool. Description is intentionally prescriptive
 * — the most common agent failure mode is passing a page URL instead of a
 * direct image URL, or a landscape image where portrait is expected.
 */
export const imageUrlSchema = z
  .string()
  .url()
  .describe(
    "Direct http(s) URL of the image BYTES (e.g. \"https://example.com/pic.jpg\"), " +
      "NOT a page containing the image. Use a URL grabbed from web_search result " +
      "snippets or image-search results. Prefer portrait-orientation sources for " +
      "character/phase/novel/event — landscape sources get center-cropped and may " +
      "cut the subject.",
  );

// ─── Common execute body ───────────────────────────────────────────────────

/**
 * Standard success result for every `set_<entity>_image_from_url` tool.
 * Mirrors the `{ deleted: true, id }` shape used by the delete tools.
 */
export interface SetImageFromUrlResult {
  readonly updated: true;
}

/**
 * Build the execute body shared by all `set_<entity>_image_from_url` tools.
 *
 * Flow:
 *   1. `fetchAndPrepareImage(url, aspect, outputW, outputH)` → server downloads,
 *      decodes, center-crops, resizes, WebP-encodes, returns raw bytes.
 *   2. Hand the `Uint8Array` to the per-entity `mutator`, which performs the
 *      actual `update<Entity>Image` IPC write.
 *
 * The mutator is a thin closure over `ctx.spaceId` / `ctx.worldId` / the
 * entity's id — keeping this layer thin lets each entity file stay
 * self-contained (no giant switch statement, no entity-kind dispatch).
 *
 * @param ctx       The tool runtime context (carries spaceId / worldId).
 * @param imageUrl  The source URL (already validated by `imageUrlSchema`).
 * @param cropSpec  The entity's {@link ENTITY_IMAGE_CROP_SPEC} entry.
 * @param mutator   Per-entity IPC write closure.
 */
export async function executeSetImageFromUrl(
  ctx: ToolContext,
  imageUrl: string,
  cropSpec: EntityImageCropSpec,
  mutator: (bytes: Uint8Array, mime: "image/webp") => Promise<unknown>,
): Promise<SetImageFromUrlResult> {
  // ctx is currently unused directly here — it's reserved for future tools
  // that need it (e.g. a "fetch via WebView" fallback that needs the AppHandle
  // carried via ctx). Keeping it in the signature lets every entity tool
  // forward ctx uniformly without an a-la-carte parameter list.
  void ctx;

  const buffer = await fetchAndPrepareImage(
    imageUrl,
    cropSpec.aspect,
    cropSpec.outputWidth,
    cropSpec.outputHeight,
  );
  const bytes = new Uint8Array(buffer);
  // The Rust `fetch_and_prepare_image` command always outputs lossless WebP
  // — see `commands/search.rs`. The MIME is fixed; the mutator's signature
  // reflects that (no stringly-typed mime param).
  await mutator(bytes, "image/webp");
  return { updated: true };
}
