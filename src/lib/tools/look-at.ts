/**
 * Look-at tool — `look_at` (ADR-0045, extended by ADR-0048).
 *
 * Lets chat models learn what an image contains when they cannot see it
 * themselves. Attached images always ride with an `[image attachment:
 * "filename" — …]` marker in the user's message — a NOT-delivered
 * downgrade marker for non-vision models (ADR-0044 D9), a delivered
 * companion annotation for vision models (ADR-0048) — and this tool
 * resolves a marker's filename (or a remote image URL, or an image stored
 * ON a worldbook entity) into a textual description produced by the
 * Space's dedicated seeded `vision` agent — a one-shot `generateText`
 * call over a vision-capable model (`@/lib/ai/look-at`).
 *
 * Inputs resolve the image via EXACTLY ONE of:
 *   - `filename` — an in-conversation attachment, matched by the EXACT
 *     filename printed in the downgrade marker (via
 *     `ctx.attachmentLookup`, zero IPC — hydrated FileParts already live in
 *     the Persisted Thread);
 *   - `url` — a direct https URL of an image file;
 *   - `entityKind` + `entityId` — a stored entity image (portrait, cover,
 *     illustration, or scene-gallery row), read back from the entity's
 *     `image_blob` column via `ctx.entityImageLookup` (one IPC read; null
 *     when the entity has no image set — ADR-0048). Exception: the world
 *     variant is context-implied — `entityKind: "world"` alone targets the
 *     CURRENT world's cover; the world's UUID is never model-facing (no
 *     tool surfaces it), so execute substitutes `ctx.worldId`, mirroring
 *     `set_world_image_from_url` / `clear_world_image` which likewise
 *     expose no world-id parameter.
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
import type { EntityImageKind, ToolDef } from "./types";

/**
 * Widened input shape re-asserted at the execute boundary — the SDK hands
 * `execute` a parsed-but-`unknown` input (same cast pattern as `grep.ts`).
 */
interface LookAtToolInput {
  filename?: string;
  url?: string;
  entityKind?: EntityImageKind;
  entityId?: string;
  question?: string;
}

/**
 * The 9 examinable entity kinds. Literal enum (not derived from the type)
 * so the schema's error messages and the model-facing description stay
 * stable regardless of type-level refactors.
 */
const ENTITY_KINDS = [
  "world",
  "character",
  "phase",
  "location",
  "item",
  "lore",
  "event",
  "novel",
  "scene_image",
] as const satisfies readonly EntityImageKind[];

const inputSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .optional()
      .describe(
        "EXACT filename of an image attached in this conversation, copied character-for-character from inside the `[image attachment: \"...\" — ...]` marker in the user's message (the marker appears whether the image reached you as pixels or not). Do not guess or shorten it.",
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
    entityKind: z
      .enum(ENTITY_KINDS)
      .optional()
      .describe(
        'Kind of entity whose STORED image to examine — e.g. "character" for a portrait, "novel" for a cover, "scene_image" for one row of a scene\'s gallery. Use together with entityId, except "world": the current world\'s cover needs NO id. Only examine entities whose hasImage is true (get_/list_ tools show it).',
      ),
    entityId: z
      .string()
      .min(1)
      .optional()
      .describe(
        'UUID of the entity holding the image — OMIT for entityKind "world" (the current world is implied). For entityKind "scene_image" this is the image\'s own id from list_scene_images — NOT the scene id.',
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
    // EXACTLY ONE source — the three resolution paths are mutually
    // exclusive by design (thread bytes vs remote fetch vs entity column).
    // entityKind + entityId count as ONE source and must arrive as a pair,
    // EXCEPT "world": that variant is context-implied (execute substitutes
    // `ctx.worldId` — the model never sees the world's UUID).
    const hasFilename = val.filename !== undefined;
    const hasUrl = val.url !== undefined;
    const isWorld = val.entityKind === "world";
    const hasEntitySource =
      val.entityKind !== undefined && (val.entityId !== undefined || isWorld);
    const sourceCount = [hasFilename, hasUrl, hasEntitySource].filter(
      Boolean,
    ).length;

    if (sourceCount !== 1) {
      // 0 or 2+ sources — when 2+ are present, attach the issue to a
      // field the caller actually PROVIDED (zod's error path then names
      // something concrete to drop, aiding model self-correction); when
      // none is present, point at `filename` (the most common source) as
      // the field to add.
      let issuePath: "filename" | "url" | "entityKind" = "filename";
      if (sourceCount > 1) {
        if (hasFilename) {
          issuePath = "filename";
        } else if (hasUrl) {
          issuePath = "url";
        } else {
          // Defensive: 2+ sources with neither filename nor url (only one
          // entity source exists, so this is unreachable in practice).
          issuePath = "entityKind";
        }
      }
      ctx.addIssue({
        code: "custom",
        path: [issuePath],
        message:
          "Provide EXACTLY ONE image source: filename (in-conversation attachment), url (remote image), or entityKind + entityId together (image stored on an entity) — not multiple, not none.",
      });
    }

    // Half of the entity pair without its partner is an input error even
    // when no other source is present — name the missing half explicitly
    // so the model can fix the call in one retry. "world" is exempt: it
    // carries no id by design.
    if (
      val.entityKind !== undefined &&
      val.entityId === undefined &&
      !isWorld
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["entityId"],
        message:
          'entityKind also requires entityId — pass both or neither (exception: entityKind "world" needs no id).',
      });
    }
    if (val.entityId !== undefined && val.entityKind === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["entityKind"],
        message: "entityId also requires entityKind — pass both or neither.",
      });
    }
  });

/** Look-at tool, keyed by `snake_case` name. */
export function lookAtTools(): Record<string, ToolDef> {
  return {
    look_at: {
      description:
        "Find out what an image shows when you cannot see it yourself. " +
        'Images the user attaches arrive with an `[image attachment: "..." — ...]` marker: when the marker says image content NOT delivered you cannot see the image (call this tool with the EXACT filename from the marker); when it says image content delivered in this message the pixels are already in the message (no look_at needed — the filename is the handle for the image tools); image URLs are plain text you cannot view directly (call look_at with the URL). ' +
        "Call this tool with the EXACT filename (in-conversation attachment), a direct image URL, " +
        "or entityKind + entityId for an image already stored on an entity (a character portrait, world/novel cover, or scene-gallery image — check hasImage / list_scene_images first; " +
        'entityKind "world" ALONE examines the current world\'s cover, no id needed), ' +
        "and it returns a description produced by a separate vision model. " +
        "Pass `question` to focus on what you need to know. " +
        "Always use this BEFORE answering questions about an image you cannot see.",
      inputSchema,
      consentLevel: "auto",
      execute: async (input, ctx, call) => {
        const { filename, url, entityKind, entityId, question } =
          input as LookAtToolInput;

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
        } else if (
          entityKind !== undefined &&
          (entityId !== undefined || entityKind === "world")
        ) {
          // The world variant is context-implied: no tool ever surfaces
          // the world's UUID to the model, so `ctx.worldId` is the
          // authoritative id — mirroring set_world_image_from_url /
          // clear_world_image, which likewise expose no world-id param.
          const effectiveId =
            entityKind === "world" ? ctx.worldId : entityId;
          // The schema guarantees entityId for every non-world kind; the
          // guard below is defensive for direct execute calls (tests).
          if (effectiveId === undefined) {
            return {
              error: "invalid_input",
              message: 'entityKind requires entityId (except "world").',
            };
          }
          const found = await ctx.entityImageLookup.findByEntity(
            entityKind,
            effectiveId,
          );
          if (!found) {
            // Structured not-found, NOT a throw — an entity without an
            // image is a normal state (hasImage=false), not an invocation
            // error. Point the model at the hasImage flag so it verifies
            // before retrying; the world has no get_/list_ surface, so it
            // gets a remediation that actually exists (set a cover).
            return {
              error: "entity_image_not_found",
              entityKind,
              entityId: effectiveId,
              message:
                entityKind === "world"
                  ? "the current world has no cover image set. One can be added via set_world_image_from_url or set_world_image_from_attachment."
                  : `no image is set on this ${entityKind} (${effectiveId}). Check the entity via the get_/list_ tools — only entities whose hasImage is true (or scene image ids from list_scene_images) can be examined.`,
            };
          }
          source = {
            kind: "entity",
            entityKind,
            entityId: effectiveId,
            dataUrl: found.dataUrl,
            mediaType: found.mediaType,
          };
        } else {
          // Unreachable via the schema (exactly-one-of), defensive for
          // direct execute calls.
          return {
            error: "invalid_input",
            message:
              "Provide exactly one of filename, url, or entityKind + entityId.",
          };
        }

        try {
          const description = await describeImage(
            ctx.visionConfig,
            source,
            question,
            call.abortSignal,
          );
          if (source.kind === "attachment") {
            return { filename: source.filename, description };
          }
          if (source.kind === "entity") {
            return {
              entityKind: source.entityKind,
              entityId: source.entityId,
              description,
            };
          }
          return { url: source.url, description };
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
