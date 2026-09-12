/**
 * World image tools — cover image set (URL / attachment) and clear.
 *
 * World is the root entity of a worldbook (Space contains Worlds, Worlds
 * contain everything else). Unlike other entity tools (characters, events,
 * etc.) there's no `create_world` / `delete_world` agent tool — those
 * operations live in the Space-management UI, not in the agent's sandbox.
 *
 * The World-level operations the agent CAN do are cover-image concerns
 * (editorial, not structural): set from a URL, set from an in-conversation
 * attachment, or clear. The world's own id is `ctx.worldId`, so no
 * entity-id parameter is exposed — the agent always operates on the
 * current world.
 *
 * Consent levels: set → `configurable` (edit, matching
 * `set_<entity>_image_from_url` on the other entities); clear → `always`
 * (destructive, matching the `clear_<entity>_image` tools elsewhere).
 */

import { z } from "zod";

import { clearWorldImage, updateWorldImage } from "@/api/image";
import type { ToolDef } from "../types";
import {
  executeSetImageFromAttachment,
  filenameSchema,
} from "./image-from-attachment";
import {
  ENTITY_IMAGE_CROP_SPEC,
  executeSetImageFromUrl,
  imageUrlSchema,
} from "./image-from-url";

export function worldTools(): Record<string, ToolDef> {
  return {
    // ── Image from URL (configurable) ──────────────────────────────
    //
    // Center-crop to 16:9 landscape, resize to 640×360, lossless WebP.
    // World covers are typically wide establishing shots — maps, panoramas,
    // key city skylines — so the wide aspect suits them.

    set_world_image_from_url: {
      description:
        "Set the current world's cover image by downloading from a URL — " +
        "useful for attaching world art, a panorama, or a representative " +
        "landscape found via `web_search`. The image is downloaded, " +
        "center-cropped to 16:9 landscape, resized to 640×360, and re-encoded " +
        "as lossless WebP. Any previous cover is overwritten. Prefer wide " +
        "landscape sources — portrait images get center-cropped and may cut " +
        "the top/bottom of the scene.",
      inputSchema: z.object({
        imageUrl: imageUrlSchema,
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { imageUrl } = input as { imageUrl: string };
        // World is keyed by its own id, which IS ctx.worldId. No entity-id
        // parameter needed — the agent always operates on the current world.
        return executeSetImageFromUrl(
          ctx,
          imageUrl,
          ENTITY_IMAGE_CROP_SPEC.world,
          (bytes, mime) => updateWorldImage(ctx.spaceId, ctx.worldId, bytes, mime),
        );
      },
    },

    // ── Image from attachment (configurable) ─────────────────────────────
    //
    // Same 16:9 → 640×360 → lossless WebP pipeline, but the source bytes
    // come from an in-conversation attachment resolved by filename. The
    // `prepare_image` IPC compresses the ≤5 MiB attachment down to the
    // ≤1 MiB canonical cover (ADR-0048).

    set_world_image_from_attachment: {
      description:
        "Set the current world's cover image from an image the user " +
        "attached in this conversation. Pass the EXACT filename from the " +
        '`[image attachment: "..."]` marker — the attachment is fetched from ' +
        "the thread, center-cropped to 16:9 landscape, resized to 640×360, " +
        "and re-encoded as lossless WebP (large photos are compressed down " +
        "to the cover format automatically). Any previous cover is " +
        "overwritten. Use set_world_image_from_url instead when the image " +
        "lives at a link.",
      inputSchema: z.object({
        filename: filenameSchema,
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { filename } = input as { filename: string };
        // World is keyed by its own id, which IS ctx.worldId.
        return executeSetImageFromAttachment(
          ctx,
          filename,
          ENTITY_IMAGE_CROP_SPEC.world,
          (bytes, mime) => updateWorldImage(ctx.spaceId, ctx.worldId, bytes, mime),
        );
      },
    },

    // ── Clear (always) ────────────────────────────────────────────────────

    clear_world_image: {
      description:
        "Remove the current world's cover image. The world itself and all " +
        "its content are untouched — only the cover art is discarded, and " +
        "the stored bytes cannot be recovered afterwards. Confirm with the " +
        "user first if they did not explicitly ask for the removal.",
      inputSchema: z.object({}),
      consentLevel: "always",
      execute: async (_input, ctx) => {
        // World is keyed by its own id, which IS ctx.worldId.
        await clearWorldImage(ctx.spaceId, ctx.worldId);
        return { cleared: true, id: ctx.worldId };
      },
    },
  };
}
