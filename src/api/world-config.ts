/**
 * World-config IPC API — per-World key/value settings stored inside each
 * World's `world.db` (the `world_config` KV table, ADR-0026).
 *
 * Unlike world-scoped domain commands, these take `worldId` directly because
 * they operate within a single World's database file. The first (and currently
 * only) config key is `time_mapper`, whose value is `{ code: string }`.
 */

import type { SpaceId, WorldId } from "@/types";
import { call } from "@/api/client";

export interface TimeMapperConfig {
  code: string;
}

export function getTimeMapper(spaceId: SpaceId, worldId: WorldId): Promise<TimeMapperConfig | null> {
  return call<TimeMapperConfig | null>("get_time_mapper", { spaceId, worldId });
}

export function setTimeMapper(spaceId: SpaceId, worldId: WorldId, code: string): Promise<void> {
  return call<void>("set_time_mapper", { spaceId, worldId, code });
}
