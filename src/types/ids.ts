import { z } from 'zod';

/**
 * Branded ID leaf module.
 *
 * Branded IDs declared here have **no dependencies on any domain schema** —
 * only on zod. Centralizing a branded ID here breaks import cycles that arise
 * when two domains reference each other's IDs (e.g. `Character` ↔ `Event`).
 *
 * Convention: keep this file to pure `z.string().brand<...>()` declarations.
 * Domain files re-export their IDs so the public import path is unchanged.
 */

/**
 * `EventId` lives here (not in `event.ts`) because `character.ts` must reference
 * it for `CharacterPhase.triggerEventId`, while `event.ts` references
 * `characterRefSchema` from `character.ts`. Declaring `EventId` in `event.ts`
 * would create a `character ↔ event` import cycle; declaring it in this leaf
 * module breaks that cycle.
 */
export const eventIdSchema = z.string().brand<'EventId'>();
export type EventId = z.infer<typeof eventIdSchema>;
