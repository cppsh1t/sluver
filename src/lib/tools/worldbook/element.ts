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
  listItems,
  listLocations,
  listLores,
  updateItem,
  updateLocation,
  updateLore,
} from "@/api/element";
import type { ToolDef } from "../types";

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

// ─── Location ─────────────────────────────────────────────────────────────

export function locationTools(): Record<string, ToolDef> {
  return {
    list_locations: {
      description: "List all locations in the current world.",
      inputSchema: z.object({}),
      consentLevel: "auto",
      execute: async (_input, ctx) => listLocations(ctx.spaceId, ctx.worldId),
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
  };
}

// ─── Item ─────────────────────────────────────────────────────────────────

export function itemTools(): Record<string, ToolDef> {
  return {
    list_items: {
      description: "List all items in the current world.",
      inputSchema: z.object({}),
      consentLevel: "auto",
      execute: async (_input, ctx) => listItems(ctx.spaceId, ctx.worldId),
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
  };
}

// ─── Lore ─────────────────────────────────────────────────────────────────

export function loreTools(): Record<string, ToolDef> {
  return {
    list_lores: {
      description: "List all lore entries in the current world.",
      inputSchema: z.object({}),
      consentLevel: "auto",
      execute: async (_input, ctx) => listLores(ctx.spaceId, ctx.worldId),
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
  };
}
