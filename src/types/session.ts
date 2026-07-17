import { z } from "zod";

import { spaceIdSchema } from "./space";

/**
 * 会话状态（Session state）— 当前打开的 Space 标签页与锁定状态。
 *
 * Session state persists in `meta.db` settings KV across restarts. The
 * frontend mirrors it as a React Query cache keyed `['session']`.
 *
 * - `openSpaceIds` — tabs currently open in the TitleBar (close-tab ≠ delete-Space).
 * - `activeSpaceId` — which tab is focused; `null` when none (e.g. landing tier).
 * - `lockedSpaceIds` — subset of `openSpaceIds` whose `space.db` connection has
 *   been dropped and whose content is obscured by the password-gate overlay.
 *   Re-auth via `openSpace(id, password)` is required to unlock.
 */

export const sessionStateSchema = z.object({
  openSpaceIds: z.array(spaceIdSchema),
  activeSpaceId: spaceIdSchema.nullable(),
  lockedSpaceIds: z.array(spaceIdSchema),
});

export type SessionState = z.infer<typeof sessionStateSchema>;
