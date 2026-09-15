/**
 * Character + Phase IPC API.
 *
 * All commands are scoped to a Space + World: `spaceId` selects the Space
 * registry, `worldId` selects the per-World DB within it.
 */

import type { Character, CharacterId, CharacterPhase, CharacterSummary, PhaseId, SummaryPage, WorldId } from '@/types';
import { call } from './client';
import type {
  CreateCharacterInput,
  CreatePhaseInput,
  UpdateCharacterInput,
  UpdatePhaseInput,
} from './types';

// ─── Character ──────────────────────────────────────────────────────────────

export function createCharacter(spaceId: string, worldId: WorldId, input: CreateCharacterInput): Promise<Character> {
  return call<Character>('create_character', { spaceId, worldId, input });
}

export function getCharacter(spaceId: string, worldId: WorldId, id: CharacterId): Promise<Character> {
  return call<Character>('get_character', { spaceId, worldId, id });
}

export function listCharacters(spaceId: string, worldId: WorldId): Promise<Character[]> {
  return call<Character[]>('list_characters', { spaceId, worldId });
}

/** Lightweight cast list — `id`, `name`, `tags` only (no phases or prose). */
export function listCharacterSummaries(spaceId: string, worldId: WorldId): Promise<CharacterSummary[]> {
  return call<CharacterSummary[]>('list_character_summaries', { spaceId, worldId });
}

/**
 * Substring search across name, aliases, description, notes, and tags.
 * Returns one PAGE of matching summaries — 50 per page (`totalCount`
 * carries the full match count; `truncated` reports further pages).
 * Deterministic name ordering makes offset pages stable — walk `offset`
 * 0, 50, 100, … while `truncated` is true.
 *
 * @param spaceId The Space owning the World.
 * @param worldId The World to search.
 * @param query   Substring to search for (case-insensitive).
 * @param offset  Pagination offset in results (0-based); omit for 0.
 */
export function searchCharacters(
  spaceId: string,
  worldId: WorldId,
  query: string,
  offset?: number,
): Promise<SummaryPage<CharacterSummary>> {
  return call<SummaryPage<CharacterSummary>>('search_characters', { spaceId, worldId, query, offset });
}

export function updateCharacter(
  spaceId: string,
  worldId: WorldId,
  id: CharacterId,
  input: UpdateCharacterInput,
): Promise<Character> {
  return call<Character>('update_character', { spaceId, worldId, id, input });
}

export function deleteCharacter(spaceId: string, worldId: WorldId, id: CharacterId): Promise<void> {
  return call<void>('delete_character', { spaceId, worldId, id });
}

// ─── Phase ──────────────────────────────────────────────────────────────────

export function addPhase(
  spaceId: string,
  worldId: WorldId,
  characterId: CharacterId,
  input: CreatePhaseInput,
): Promise<CharacterPhase> {
  return call<CharacterPhase>('add_phase', { spaceId, worldId, characterId, input });
}

export function updatePhase(
  spaceId: string,
  worldId: WorldId,
  phaseId: PhaseId,
  input: UpdatePhaseInput,
): Promise<CharacterPhase> {
  return call<CharacterPhase>('update_phase', { spaceId, worldId, phaseId, input });
}

export function deletePhase(spaceId: string, worldId: WorldId, phaseId: PhaseId): Promise<void> {
  return call<void>('delete_phase', { spaceId, worldId, phaseId });
}

export function reorderPhases(
  spaceId: string,
  worldId: WorldId,
  characterId: CharacterId,
  phaseIds: PhaseId[],
): Promise<void> {
  return call<void>('reorder_phases', { spaceId, worldId, characterId, phaseIds });
}

// ─── Ref counts (disclosure before delete) ──────────────────────────────────

export interface RefCounts {
  events: number;
  scenes: number;
}

export function countPhaseRefs(spaceId: string, worldId: WorldId, phaseId: PhaseId): Promise<RefCounts> {
  return call<RefCounts>('count_phase_refs', { spaceId, worldId, phaseId });
}

export function countCharacterRefs(spaceId: string, worldId: WorldId, characterId: CharacterId): Promise<RefCounts> {
  return call<RefCounts>('count_character_refs', { spaceId, worldId, characterId });
}
