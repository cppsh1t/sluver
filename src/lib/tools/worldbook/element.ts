/**
 * Element domain tools — Location, Item, Lore.
 *
 * The three element types share an identical schema (name, description, notes,
 * tags) and API shape. This file defines shared input schemas and exports one
 * factory per entity type.
 *
 * Consent levels: list/get → `auto`, create → `configurable`, update/delete → `always`.
 */

import { z } from "zod";

import {
  createItem,
  createLocation,
  createLore,
  deleteItem,
  deleteLocation,
  deleteLore,
  getItem,
  getLocation,
  getLore,
  listItemSummaries,
  listLocationSummaries,
  listLoreSummaries,
  searchItems,
  searchLocations,
  searchLores,
  updateItem,
  updateLocation,
  updateLore,
} from "@/api/element";
import {
  updateItemImage,
  updateLocationImage,
  updateLoreImage,
} from "@/api/image";
import type { ToolDef } from "../types";
import {
  ENTITY_IMAGE_CROP_SPEC,
  executeSetImageFromUrl,
  imageUrlSchema,
} from "./image-from-url";

// ─── Shared schemas ───────────────────────────────────────────────────────

const createSchema = z.object({
  name: z.string().min(1).describe("Name (must be unique within the world)."),
  description: z.string().optional().describe("Description."),
  notes: z.string().optional().describe("Author-only notes (not shown in prose)."),
  tags: z.array(z.string()).optional().describe("Categorization tags."),
});

const updateSchema = createSchema.extend({
  id: z.string().describe("The element's UUID."),
});

const idSchema = z.object({ id: z.string().describe("The element's UUID.") });

// ─── Search input (shared) ────────────────────────────────────────────────

const searchSchema = z.object({
  query: z.string().min(1).describe("Substring to search for (case-insensitive)."),
});

// ─── Location ─────────────────────────────────────────────────────────────

export function locationTools(): Record<string, ToolDef> {
  return {
    list_locations: {
      description:
        "List all locations in the current world. Returns summary fields (id, name, tags) only — call get_location for description and notes.",
      inputSchema: z.object({}),
      consentLevel: "auto",
      execute: async (_input, ctx) => listLocationSummaries(ctx.spaceId, ctx.worldId),
    },
    search_locations: {
      description:
        "Search locations by substring match across name, description, notes, and tags. Returns matching location summaries (id, name, tags) — call get_location for full fields on specific hits.",
      inputSchema: searchSchema,
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { query } = input as { query: string };
        return searchLocations(ctx.spaceId, ctx.worldId, query);
      },
    },
    get_location: {
      description: "Get a single location by ID.",
      inputSchema: idSchema,
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        return getLocation(ctx.spaceId, ctx.worldId, id as never);
      },
    },
    create_location: {
      description: "Create a new location in the current world. The name must be unique.",
      inputSchema: createSchema,
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        return createLocation(ctx.spaceId, ctx.worldId, input as never);
      },
    },
    update_location: {
      description:
        "Update an existing location. Only provided fields are changed; omitted fields keep their current values.",
      inputSchema: updateSchema,
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id, ...changes } = input as { id: string; name?: string; description?: string; notes?: string; tags?: string[] };
        const current = await getLocation(ctx.spaceId, ctx.worldId, id as never);
        return updateLocation(ctx.spaceId, ctx.worldId, id as never, {
          name: changes.name ?? current.name,
          description: changes.description ?? current.description,
          notes: changes.notes ?? current.notes,
          tags: changes.tags ?? current.tags,
        });
      },
    },
    delete_location: {
      description: "Delete a location.",
      inputSchema: idSchema,
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        await deleteLocation(ctx.spaceId, ctx.worldId, id as never);
        return { deleted: true, id };
      },
    },

    // ── Image from URL (configurable) ──────────────────────────────
    //
    // Center-crop pipeline: download → decode → center-crop to 4:3 landscape
    // → Lanczos3 resize to 400×300 → lossless WebP encode. Matches the
    // user-side `ImageCropDialog` flow for locations.

    set_location_image_from_url: {
      description:
        "Set a location's image by downloading from a URL — useful for " +
        "attaching a map, panorama, or scenery photo found via `web_search`. " +
        "The image is downloaded, center-cropped to 4:3 landscape, resized " +
        "to 400×300, and re-encoded as lossless WebP. Any previous image is " +
        "overwritten. Prefer landscape or square sources — tall portrait " +
        "images get center-cropped and may cut the top/bottom.",
      inputSchema: z.object({
        id: z.string().describe("The location's UUID."),
        imageUrl: imageUrlSchema,
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { id, imageUrl } = input as { id: string; imageUrl: string };
        return executeSetImageFromUrl(
          ctx,
          imageUrl,
          ENTITY_IMAGE_CROP_SPEC.location,
          (bytes, mime) =>
            updateLocationImage(ctx.spaceId, ctx.worldId, id as never, bytes, mime),
        );
      },
    },
  };
}

// ─── Item ─────────────────────────────────────────────────────────────────

export function itemTools(): Record<string, ToolDef> {
  return {
    list_items: {
      description:
        "List all items in the current world. Returns summary fields (id, name, tags) only — call get_item for description and notes.",
      inputSchema: z.object({}),
      consentLevel: "auto",
      execute: async (_input, ctx) => listItemSummaries(ctx.spaceId, ctx.worldId),
    },
    search_items: {
      description:
        "Search items by substring match across name, description, notes, and tags. Returns matching item summaries (id, name, tags) — call get_item for full fields on specific hits.",
      inputSchema: searchSchema,
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { query } = input as { query: string };
        return searchItems(ctx.spaceId, ctx.worldId, query);
      },
    },
    get_item: {
      description: "Get a single item by ID.",
      inputSchema: idSchema,
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        return getItem(ctx.spaceId, ctx.worldId, id as never);
      },
    },
    create_item: {
      description: "Create a new item in the current world. The name must be unique.",
      inputSchema: createSchema,
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        return createItem(ctx.spaceId, ctx.worldId, input as never);
      },
    },
    update_item: {
      description:
        "Update an existing item. Only provided fields are changed; omitted fields keep their current values.",
      inputSchema: updateSchema,
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id, ...changes } = input as { id: string; name?: string; description?: string; notes?: string; tags?: string[] };
        const current = await getItem(ctx.spaceId, ctx.worldId, id as never);
        return updateItem(ctx.spaceId, ctx.worldId, id as never, {
          name: changes.name ?? current.name,
          description: changes.description ?? current.description,
          notes: changes.notes ?? current.notes,
          tags: changes.tags ?? current.tags,
        });
      },
    },
    delete_item: {
      description: "Delete an item.",
      inputSchema: idSchema,
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        await deleteItem(ctx.spaceId, ctx.worldId, id as never);
        return { deleted: true, id };
      },
    },

    // ── Image from URL (configurable) ──────────────────────────────
    //
    // Center-crop to 1:1 square, resize to 256×256, lossless WebP. Square
    // or near-square sources survive center-crop intact.

    set_item_image_from_url: {
      description:
        "Set an item's image by downloading from a URL — useful for " +
        "attaching a product shot, artifact photo, or weapon illustration " +
        "found via `web_search`. The image is downloaded, center-cropped to " +
        "a 1:1 square, resized to 256×256, and re-encoded as lossless WebP. " +
        "Any previous image is overwritten. Square sources survive intact; " +
        "off-aspect sources get center-cropped.",
      inputSchema: z.object({
        id: z.string().describe("The item's UUID."),
        imageUrl: imageUrlSchema,
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { id, imageUrl } = input as { id: string; imageUrl: string };
        return executeSetImageFromUrl(
          ctx,
          imageUrl,
          ENTITY_IMAGE_CROP_SPEC.item,
          (bytes, mime) =>
            updateItemImage(ctx.spaceId, ctx.worldId, id as never, bytes, mime),
        );
      },
    },
  };
}

// ─── Lore ─────────────────────────────────────────────────────────────────

export function loreTools(): Record<string, ToolDef> {
  return {
    list_lores: {
      description:
        "List all lore entries in the current world. Returns summary fields (id, name, tags) only — call get_lore for description and notes.",
      inputSchema: z.object({}),
      consentLevel: "auto",
      execute: async (_input, ctx) => listLoreSummaries(ctx.spaceId, ctx.worldId),
    },
    search_lores: {
      description:
        "Search lore entries by substring match across name, description, notes, and tags. Returns matching lore summaries (id, name, tags) — call get_lore for full fields on specific hits.",
      inputSchema: searchSchema,
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { query } = input as { query: string };
        return searchLores(ctx.spaceId, ctx.worldId, query);
      },
    },
    get_lore: {
      description: "Get a single lore entry by ID.",
      inputSchema: idSchema,
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        return getLore(ctx.spaceId, ctx.worldId, id as never);
      },
    },
    create_lore: {
      description: "Create a new lore entry in the current world. The name must be unique.",
      inputSchema: createSchema,
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        return createLore(ctx.spaceId, ctx.worldId, input as never);
      },
    },
    update_lore: {
      description:
        "Update an existing lore entry. Only provided fields are changed; omitted fields keep their current values.",
      inputSchema: updateSchema,
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id, ...changes } = input as { id: string; name?: string; description?: string; notes?: string; tags?: string[] };
        const current = await getLore(ctx.spaceId, ctx.worldId, id as never);
        return updateLore(ctx.spaceId, ctx.worldId, id as never, {
          name: changes.name ?? current.name,
          description: changes.description ?? current.description,
          notes: changes.notes ?? current.notes,
          tags: changes.tags ?? current.tags,
        });
      },
    },
    delete_lore: {
      description: "Delete a lore entry.",
      inputSchema: idSchema,
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        await deleteLore(ctx.spaceId, ctx.worldId, id as never);
        return { deleted: true, id };
      },
    },

    // ── Image from URL (configurable) ──────────────────────────────
    //
    // Same 1:1 → 256×256 pipeline as `set_item_image_from_url`.

    set_lore_image_from_url: {
      description:
        "Set a lore entry's image by downloading from a URL — useful for " +
        "attaching an illustration, symbol, or artwork found via `web_search`. " +
        "The image is downloaded, center-cropped to a 1:1 square, resized to " +
        "256×256, and re-encoded as lossless WebP. Any previous image is " +
        "overwritten. Square sources survive intact.",
      inputSchema: z.object({
        id: z.string().describe("The lore entry's UUID."),
        imageUrl: imageUrlSchema,
      }),
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        const { id, imageUrl } = input as { id: string; imageUrl: string };
        return executeSetImageFromUrl(
          ctx,
          imageUrl,
          ENTITY_IMAGE_CROP_SPEC.lore,
          (bytes, mime) =>
            updateLoreImage(ctx.spaceId, ctx.worldId, id as never, bytes, mime),
        );
      },
    },
  };
}
