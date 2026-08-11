/**
 * Event domain tools — full CRUD.
 *
 * Events have a participation set (characterRefs: { characterId, phaseId }[])
 * and an optional locationId. These junction fields are full-replacement on
 * update (delete-all + re-insert in a transaction on the backend).
 *
 * Consent levels: list/get → `auto`, create → `configurable`, update/delete → `always`.
 */

import { z } from "zod";

import {
  createEvent,
  deleteEvent,
  getEvent,
  listEventSummaries,
  searchEvents,
  updateEvent,
} from "@/api/event";
import type { ToolDef } from "../types";

// ─── Shared schemas ───────────────────────────────────────────────────────

const characterRefSchema = z.object({
  characterId: z.string().describe("The character's UUID."),
  phaseId: z.string().describe("The specific phase UUID the character is in during this event."),
});

const createSchema = z.object({
  name: z.string().min(1).describe("Event name (must be unique within the world)."),
  description: z.string().optional().describe("What happens in this event."),
  startAt: z.string().datetime({ offset: true }).optional().describe("ISO 8601 timestamp (e.g. 2026-01-15T10:30:00Z) for when the event starts. Free-form text like \"midnight\" is rejected."),
  endAt: z.string().datetime({ offset: true }).optional().describe("ISO 8601 timestamp (e.g. 2026-01-15T10:30:00Z) for when the event ends. Free-form text like \"midnight\" is rejected."),
  characterRefs: z.array(characterRefSchema).optional().describe("Characters participating, each pinned to a phase."),
  locationId: z.string().optional().describe("UUID of the location where the event takes place."),
  notes: z.string().optional().describe("Author-only notes."),
  tags: z.array(z.string()).optional().describe("Categorization tags."),
});

const updateSchema = createSchema.extend({
  id: z.string().describe("The event's UUID."),
});

export function eventTools(): Record<string, ToolDef> {
  return {
    list_events: {
      description:
        "List all events in the current world. Returns summary fields (id, name, tags, startAt, endAt) only — call get_event for participants, location, description, and notes.",
      inputSchema: z.object({}),
      consentLevel: "auto",
      execute: async (_input, ctx) => listEventSummaries(ctx.spaceId, ctx.worldId),
    },

    search_events: {
      description:
        "Search events by substring match across name, description, notes, tags, start time, and end time. Returns matching event summaries (id, name, tags, startAt, endAt) — call get_event for full fields on specific hits.",
      inputSchema: z.object({
        query: z.string().min(1).describe("Substring to search for (case-insensitive)."),
      }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { query } = input as { query: string };
        return searchEvents(ctx.spaceId, ctx.worldId, query);
      },
    },

    get_event: {
      description: "Get a single event by ID, including participants and location.",
      inputSchema: z.object({ id: z.string().describe("The event's UUID.") }),
      consentLevel: "auto",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        return getEvent(ctx.spaceId, ctx.worldId, id as never);
      },
    },

    create_event: {
      description:
        "Create a new event. The name must be unique. Pass characterRefs to record who participated and in which phase.",
      inputSchema: createSchema,
      consentLevel: "configurable",
      execute: async (input, ctx) => {
        return createEvent(ctx.spaceId, ctx.worldId, input as never);
      },
    },

    update_event: {
      description:
        "Update an existing event. Only provided fields are changed. NOTE: characterRefs is full-replacement — provide the COMPLETE desired array, not just additions.",
      inputSchema: updateSchema,
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id, ...changes } = input as {
          id: string;
          name?: string;
          description?: string;
          startAt?: string;
          endAt?: string;
          characterRefs?: unknown[];
          locationId?: string;
          notes?: string;
          tags?: string[];
        };
        const current = await getEvent(ctx.spaceId, ctx.worldId, id as never);
        return updateEvent(ctx.spaceId, ctx.worldId, id as never, {
          name: changes.name ?? current.name,
          description: changes.description ?? current.description,
          startAt: changes.startAt ?? current.startAt,
          endAt: changes.endAt ?? current.endAt,
          characterRefs: (changes.characterRefs ?? current.characterRefs) as never,
          locationId: (changes.locationId ?? current.locationId) as never,
          notes: changes.notes ?? current.notes,
          tags: changes.tags ?? current.tags,
        });
      },
    },

    delete_event: {
      description: "Delete an event. This also removes the event from any scenes that reference it.",
      inputSchema: z.object({ id: z.string().describe("The event's UUID.") }),
      consentLevel: "always",
      execute: async (input, ctx) => {
        const { id } = input as { id: string };
        await deleteEvent(ctx.spaceId, ctx.worldId, id as never);
        return { deleted: true, id };
      },
    },
  };
}
