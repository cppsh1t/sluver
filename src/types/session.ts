import { z } from "zod";

import { spaceIdSchema } from "./space";

/**
 * 会话状态（Session state）— multi-window model (ADR-0011).
 *
 * Session state persists in `meta.db` settings KV across restarts. The
 * frontend mirrors it as a React Query cache keyed `['session']`.
 *
 * - `lastOpenedSpaceId` — the Space whose window was most recently opened.
 *   On startup, the backend auto-opens this Space's window. `null` when the
 *   user has never opened a Space (first run) or the last Space was deleted.
 * - `lockedSpaceIds` — Spaces whose `space.db` connection has been dropped
 *   and whose content is obscured by the password-gate overlay. Re-auth via
 *   `openSpace(id, password)` is required to unlock.
 */

export const sessionStateSchema = z.object({
  lastOpenedSpaceId: spaceIdSchema.nullable(),
  lockedSpaceIds: z.array(spaceIdSchema),
});

export type SessionState = z.infer<typeof sessionStateSchema>;
