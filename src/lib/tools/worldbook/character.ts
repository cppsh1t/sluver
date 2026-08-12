/**
 * Character domain tools — full CRUD, phase management, reorder, and ref counts.
 *
 * Consent levels:
 * - list / get / count → `auto`
 * - create / add_phase → `configurable`
 * - update / delete / reorder → `always`
 *
 * Update tools use a read-merge-write pattern: only provided fields are changed;
 * omitted fields keep their current values. This is safer than full-replacement
 * for AI-driven edits (the model may not know every field's current value).
 */

import { z } from "zod";

import {
  addPhase,
  countCharacterRefs,
  countPhaseRefs,
  createCharacter,
  deleteCharacter,
  deletePhase,
  getCharacter,
  listCharacterSummaries,
  listCharacters,
  reorderPhases,
  searchCharacters,
  updateCharacter,
  updatePhase,
} from "@/api/character";
import { updateCharacterImage, updatePhaseImage } from "@/api/image";
import type { ToolDef } from "../types";
import {
  ENTITY_IMAGE_CROP_SPEC,
  executeSetImageFromUrl,
  imageUrlSchema,
} from "./image-from-url";

/** All character-domain tools (character CRUD + phase management + ref counts). */
export function characterTools(): Record<string, ToolDef> {
  return {
    // ── Query (auto) ────────────────────────────────────────────
    list_characters: {
      description:
        "List all characters in the current world. Returns summary fields (id, name, tags) only — call get_character for aliases, description, phases, notes.",
      inputSchema: z.object({}),
      consentLevel: "auto",
      execute: async (_input, ctx) => listCharacterSummaries(ctx.spaceId, ctx.worldId),
    },

    search_characters: {
      description:
        "Search characters by substring match across name, aliases, description, notes, and tags. Returns matching character summaries (id, name, tags) — call get_character for full fields on specific hits.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Substring to search for (case-insensitive)."),
      }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { query } = input as { query: string };
        return searchCharacters(ctx.spaceId, ctx.worldId, query);
      },
    },

    get_character: {
      description:
        "Get a single character by ID, including all phases, appearance, and notes.",
      inputSchema: z.object({
        id: z.string().describe("The character's UUID."),
      }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        return getCharacter(ctx.spaceId, ctx.worldId, id as never);
      },
    },

    count_character_refs: {
      description:
        "Count how many events and scenes reference a character. Useful before deletion to assess impact.",
      inputSchema: z.object({
        characterId: z.string().describe("The character's UUID."),
      }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { characterId } = input as { characterId: string };
        return countCharacterRefs(ctx.spaceId, ctx.worldId, characterId as never);
      },
    },

    count_phase_refs: {
      description:
        "Count how many events and scenes reference a specific phase of a character. Useful before phase deletion.",
      inputSchema: z.object({
        phaseId: z.string().describe("The phase's UUID."),
      }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { phaseId } = input as { phaseId: string };
        return countPhaseRefs(ctx.spaceId, ctx.worldId, phaseId as never);
      },
    },

    // ── Create (configurable) ──────────────────────────────────
    create_character: {
      description:
        "Create a new character in the current world. The name must be unique. A new character starts with zero phases — call add_phase to define their appearance and life stages.",
      inputSchema: z.object({
        name: z.string().min(1).describe("The character's name (must be unique within the world)."),
        aliases: z.array(z.string()).optional().describe("Alternative names or nicknames."),
        description: z.string().optional().describe("Personality, background, and key traits."),
        notes: z.string().optional().describe("Author-only notes (not shown in prose)."),
        tags: z.array(z.string()).optional().describe("Categorization tags."),
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const i = input as {
          name: string;
          aliases?: string[];
          description?: string;
          notes?: string;
          tags?: string[];
        };
        return createCharacter(ctx.spaceId, ctx.worldId, i);
      },
    },

    add_phase: {
      description:
        "Add a new phase (life stage) to a character. Each phase has its own appearance, description, and conversation style. Position auto-appends to the end of the phase list.",
      inputSchema: z.object({
        characterId: z.string().describe("The character's UUID."),
        name: z.string().min(1).describe("Phase name (e.g. 'Before the Fall', 'In Exile'). Must be unique within the character."),
        appearance: z.string().min(1).describe("Physical description during this phase."),
        description: z.string().optional().describe("What defines this period (emotional/circumstantial state, identity, relationships, abilities)."),
        conversationStyle: z.string().optional().describe("How the character speaks and behaves in dialogue during this period (tone, vocabulary, mannerisms)."),
        triggerEventId: z.string().optional().describe("UUID of the event that triggered this phase, if any."),
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { characterId, ...rest } = input as {
          characterId: string;
          name: string;
          appearance: string;
          description?: string;
          conversationStyle?: string;
          triggerEventId?: string;
        };
        return addPhase(ctx.spaceId, ctx.worldId, characterId as never, rest as never);
      },
    },

    // ── Update (always) ────────────────────────────────────────
    update_character: {
      description:
        "Update an existing character. Only provided fields are changed; omitted fields keep their current values. Use get_character first to see current values.",
      inputSchema: z.object({
        id: z.string().describe("The character's UUID."),
        name: z.string().optional().describe("New name (if changing)."),
        aliases: z.array(z.string()).optional().describe("New aliases (replaces all current aliases)."),
        description: z.string().optional().describe("New description (replaces current)."),
        notes: z.string().optional().describe("New notes (replaces current)."),
        tags: z.array(z.string()).optional().describe("New tags (replaces all current tags)."),
      }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id, ...changes } = input as {
          id: string;
          name?: string;
          aliases?: string[];
          description?: string;
          notes?: string;
          tags?: string[];
        };
        const current = await getCharacter(ctx.spaceId, ctx.worldId, id as never);
        return updateCharacter(ctx.spaceId, ctx.worldId, id as never, {
          name: changes.name ?? current.name,
          aliases: changes.aliases ?? current.aliases,
          description: changes.description ?? current.description,
          notes: changes.notes ?? current.notes,
          tags: changes.tags ?? current.tags,
        });
      },
    },

    update_phase: {
      description:
        "Update an existing phase. Only provided fields are changed; omitted fields keep their current values. Use list_characters or get_character first to see current values.",
      inputSchema: z.object({
        phaseId: z.string().describe("The phase's UUID."),
        name: z.string().min(1).optional().describe("New phase name (if changing)."),
        appearance: z.string().min(1).optional().describe("New physical description (if changing)."),
        description: z.string().optional().describe("New description (replaces current). Omit to keep current."),
        conversationStyle: z.string().optional().describe("New conversation style (replaces current). Omit to keep current."),
        triggerEventId: z.string().nullable().optional().describe("UUID of the triggering event, or null to clear. Omit to keep current."),
      }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { phaseId, ...updates } = input as {
          phaseId: string;
          name?: string;
          appearance?: string;
          description?: string;
          conversationStyle?: string;
          triggerEventId?: string | null;
        };

        // Read current phase via listCharacters (phases are embedded in characters).
        const characters = await listCharacters(ctx.spaceId, ctx.worldId);
        let current: { name: string; appearance: string; description: string; conversationStyle: string; triggerEventId: string | null } | undefined;
        for (const char of characters) {
          const found = char.phases.find((p) => p.id === phaseId);
          if (found) {
            current = found;
            break;
          }
        }
        if (!current) {
          throw new Error(`Phase not found: ${phaseId}`);
        }

        // triggerEventId: undefined → keep current; null → clear; string → set.
        const triggerEventId =
          updates.triggerEventId !== undefined ? updates.triggerEventId : current.triggerEventId;

        return updatePhase(ctx.spaceId, ctx.worldId, phaseId as never, {
          name: updates.name ?? current.name,
          appearance: updates.appearance ?? current.appearance,
          description: updates.description ?? current.description,
          conversationStyle: updates.conversationStyle ?? current.conversationStyle,
          triggerEventId: triggerEventId as never,
        });
      },
    },

    // ── Delete (always) ────────────────────────────────────────
    delete_character: {
      description:
        "Delete a character and all their phases. This cascades to character references in events and scenes. Use count_character_refs first to assess impact.",
      inputSchema: z.object({
        id: z.string().describe("The character's UUID."),
      }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        await deleteCharacter(ctx.spaceId, ctx.worldId, id as never);
        return { deleted: true, id };
      },
    },

    delete_phase: {
      description:
        "Delete a phase from a character. Cascades to character references that use this phase. Use count_phase_refs first to assess impact.",
      inputSchema: z.object({
        phaseId: z.string().describe("The phase's UUID."),
      }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { phaseId } = input as { phaseId: string };
        await deletePhase(ctx.spaceId, ctx.worldId, phaseId as never);
        return { deleted: true, id: phaseId };
      },
    },

    // ── Reorder (always) ───────────────────────────────────────
    reorder_phases: {
      description:
        "Reorder phases within a character. Pass ALL phase IDs in the desired order. Call list_characters first to see current phase order.",
      inputSchema: z.object({
        characterId: z.string().describe("The character's UUID."),
        phaseIds: z.array(z.string()).describe("All phase UUIDs in the desired order (must include every phase)."),
      }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { characterId, phaseIds } = input as { characterId: string; phaseIds: string[] };
        await reorderPhases(ctx.spaceId, ctx.worldId, characterId as never, phaseIds as never);
        return { reordered: true, characterId, order: phaseIds };
      },
    },

    // ── Image from URL (configurable) ──────────────────────────────
    //
    // Center-crop pipeline runs server-side (`fetch_and_prepare_image`):
    // download → decode (JPEG/PNG/WebP) → center-crop to 3:4 → Lanczos3
    // resize to 300×400 → lossless WebP encode. Mirrors the user-side
    // `ImageCropDialog` flow minus the interactive crop rectangle.

    set_character_image_from_url: {
      description:
        "Set a character's portrait by downloading an image from a URL. " +
        "Use this after `web_search` to attach a portrait found online — the agent " +
        "cannot pick a file from disk, only fetch from a URL. The image is " +
        "automatically downloaded, center-cropped to 3:4 portrait, resized to " +
        "300×400, and re-encoded as lossless WebP. Any previous portrait is " +
        "overwritten. Common sources: Wikipedia / Baidu Baike / fandom wikis / " +
        "museum websites. Prefer portrait-orientation sources — landscape " +
        "images get center-cropped and may cut the subject's sides.",
      inputSchema: z.object({
        characterId: z.string().describe("The character's UUID."),
        imageUrl: imageUrlSchema,
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { characterId, imageUrl } = input as { characterId: string; imageUrl: string };
        return executeSetImageFromUrl(
          ctx,
          imageUrl,
          ENTITY_IMAGE_CROP_SPEC.character,
          (bytes, mime) =>
            updateCharacterImage(ctx.spaceId, ctx.worldId, characterId as never, bytes, mime),
        );
      },
    },

    set_phase_image_from_url: {
      description:
        "Set a phase's portrait by downloading an image from a URL. Use this " +
        "when a character has multiple life stages (phases) and each warrants " +
        "a distinct visual — e.g. 'Before the Fall' vs 'In Exile'. The image " +
        "is downloaded, center-cropped to 3:4 portrait, resized to 300×400, " +
        "and re-encoded as lossless WebP. Any previous phase portrait is " +
        "overwritten. Prefer portrait-orientation sources.",
      inputSchema: z.object({
        phaseId: z.string().describe("The phase's UUID (NOT the character's id)."),
        imageUrl: imageUrlSchema,
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { phaseId, imageUrl } = input as { phaseId: string; imageUrl: string };
        return executeSetImageFromUrl(
          ctx,
          imageUrl,
          ENTITY_IMAGE_CROP_SPEC.phase,
          (bytes, mime) =>
            updatePhaseImage(ctx.spaceId, ctx.worldId, phaseId as never, bytes, mime),
        );
      },
    },
  };
}
