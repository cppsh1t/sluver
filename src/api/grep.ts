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
 * Returns one PAGE of match groups (entity + field + matchCount + up to 3
 * snippets), sorted by match count descending — 50 groups per page
 * (`groupCount` carries the full total; `truncated` reports further
 * pages). Omit `entityTypes` to sweep the full corpus; pass e.g.
 * `['scene']` to narrow to prose.
 *
 * @param spaceId     The Space owning the World.
 * @param worldId     The World to grep.
 * @param query       Substring to search for (non-empty).
 * @param entityTypes Optional scope filter; omit to search all 9 entity
 *                    types.
 * @param offset      Pagination offset in groups (0-based). Deterministic
 *                    ordering makes pages stable — walk 0, 50, 100, … while
 *                    `truncated` is true.
 */
export function grep(
  spaceId: string,
  worldId: WorldId,
  query: string,
  entityTypes?: readonly GrepEntityType[],
  offset?: number,
): Promise<GrepResult> {
  return call<GrepResult>('grep', { spaceId, worldId, query, entityTypes, offset });
}
