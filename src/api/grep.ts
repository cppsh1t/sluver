/**
 * Grep IPC API (ADR-0035).
 *
 * Match-centric full-corpus retrieval: sweeps ALL author-written text in a
 * World — including the four CharacterPhase fields — for a substring,
 * returning field-grouped occurrence evidence (match counts + before/
 * match/after snippets). Computed on demand by the `grep` Rust command;
 * never persisted. See `@/types/grep` for the data contract.
 *
 * NOTE (ADR-0016 NEVER-log): the query may be verbatim prose and the
 * returned snippets are content fragments — neither is ever logged.
 */

import type { GrepEntityType, GrepResult, WorldId } from '@/types';
import { call } from './client';

/**
 * Grep the World's full text corpus for a substring (ASCII case folding).
 * Returns match groups (entity + field + matchCount + up to 3 snippets),
 * sorted by match count descending, capped at 50 groups (`truncated`
 * flags the cap). Omit `entityTypes` to sweep the full corpus; pass e.g.
 * `['scene']` to narrow to prose.
 *
 * @param spaceId     The Space owning the World.
 * @param worldId     The World to grep.
 * @param query       Substring to search for (non-empty).
 * @param entityTypes Optional scope filter; omit to search all 9 entity
 *                    types.
 */
export function grep(
  spaceId: string,
  worldId: WorldId,
  query: string,
  entityTypes?: readonly GrepEntityType[],
): Promise<GrepResult> {
  return call<GrepResult>('grep', { spaceId, worldId, query, entityTypes });
}
