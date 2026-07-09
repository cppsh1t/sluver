import { z } from "zod";
import { worldIdSchema } from "./world";
import { locationIdSchema } from "./location";
import { characterRefSchema } from "./character";
import { eventIdSchema } from "./ids";

// `eventIdSchema` is declared in `./ids` (a dependency-free leaf module) to
// break the `character ↔ event` import cycle. Re-exported here so the public
// import path (`@/types/event`) is unchanged.
export { eventIdSchema, type EventId } from "./ids";

/**
 * 事件（Event）— 记录对世界有影响的事件。
 *
 * Events capture meaningful occurrences in the world: battles, meetings,
 * discoveries, transformations, etc. They contain:
 * - 参与角色 (participating characters, referenced at specific phases)
 * - 地点 (location, referenced by ID — single location per event)
 * - 时间范围 (startAt / endAt — in-fiction dates, ISO 8601 strings)
 * - 描述 (description)
 *
 * Events also serve as **phase transition triggers** for characters
 * (see `CharacterPhase.triggerEventId`) and as nodes for the future Timeline UI.
 *
 * v0.1.0: events are stored but no Timeline UI is built.
 */

export const eventSchema = z.object({
  id: eventIdSchema,
  worldId: worldIdSchema,
  name: z.string(),
  /** What happened. */
  description: z.string(),
  /** Story timeline — when the event starts (ISO 8601). `null` if unspecified. */
  startAt: z.iso.datetime().nullable(),
  /** Story timeline — when the event ends (ISO 8601). `null` if unspecified. */
  endAt: z.iso.datetime().nullable(),
  /** Characters who participate in this event, pinned to their phase at the time. */
  characterRefs: z.array(characterRefSchema),
  /** ID of the location where the event takes place. `null` if unspecified. */
  locationId: locationIdSchema.nullable(),
  /** Free-form notes (markdown). */
  notes: z.string(),
  /** User-defined tags for categorization / filtering. */
  tags: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Event = z.infer<typeof eventSchema>;
