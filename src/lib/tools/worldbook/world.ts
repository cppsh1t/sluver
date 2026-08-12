/**
 * World image tool — cover image only.
 *
 * World is the root entity of a worldbook (Space contains Worlds, Worlds
 * contain everything else). Unlike other entity tools (characters, events,
 * etc.) there's no `create_world` / `delete_world` agent tool — those
 * operations live in the Space-management UI, not in the agent's sandbox.
 *
 * The one World-level operation the agent CAN do is set the cover image,
 * because that's an editorial concern (finding art for the world), not a
 * structural one. The world's own id is `ctx.worldId`, so no entity-id
 * parameter is exposed — the agent always operates on the current world.
 *
 * Consent level: `configurable` — image update is an edit (not a delete),
 * matching `set_<entity>_image_from_url` on the other entities.
 */

import { z } from "zod";

import { updateWorldImage } from "@/api/image";
import type { ToolDef } from "../types";
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
  };
}
