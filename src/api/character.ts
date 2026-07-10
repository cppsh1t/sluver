/**
 * Character + Phase IPC API.
 *
 * All commands are scoped to a world DB via `worldId`.
 */

import type { Character, CharacterId, CharacterPhase, PhaseId, WorldId } from '@/types';
import { call } from './client';
import type {
  CreateCharacterInput,
  CreatePhaseInput,
  UpdateCharacterInput,
  UpdatePhaseInput,
} from './types';

// ─── Character ──────────────────────────────────────────────────────────────

export function createCharacter(worldId: WorldId, input: CreateCharacterInput): Promise<Character> {
  return call<Character>('create_character', { worldId, input });
}

export function getCharacter(worldId: WorldId, id: CharacterId): Promise<Character> {
  return call<Character>('get_character', { worldId, id });
}

export function listCharacters(worldId: WorldId): Promise<Character[]> {
  return call<Character[]>('list_characters', { worldId });
}

export function updateCharacter(
  worldId: WorldId,
  id: CharacterId,
  input: UpdateCharacterInput,
): Promise<Character> {
  return call<Character>('update_character', { worldId, id, input });
}

export function deleteCharacter(worldId: WorldId, id: CharacterId): Promise<void> {
  return call<void>('delete_character', { worldId, id });
}

// ─── Phase ──────────────────────────────────────────────────────────────────

export function addPhase(
  worldId: WorldId,
  characterId: CharacterId,
  input: CreatePhaseInput,
): Promise<CharacterPhase> {
  return call<CharacterPhase>('add_phase', { worldId, characterId, input });
}

export function updatePhase(
  worldId: WorldId,
  phaseId: PhaseId,
  input: UpdatePhaseInput,
): Promise<CharacterPhase> {
  return call<CharacterPhase>('update_phase', { worldId, phaseId, input });
}

export function deletePhase(worldId: WorldId, phaseId: PhaseId): Promise<void> {
  return call<void>('delete_phase', { worldId, phaseId });
}
