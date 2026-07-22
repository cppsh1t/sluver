/**
 * Barrel re-export for the IPC API layer.
 *
 * All function names are prefixed with their entity name (createWorld,
 * listCharacters, updateScene, …) so there are no collisions — import flat:
 *
 * ```ts
 * import { createWorld, listCharacters, type CreateCharacterInput } from '@/api';
 * ```
 */

export { call } from './client';

export * from './world';
export * from './setting';
export * from './character';
export * from './element';
export * from './event';
export * from './novel';
export * from './space';
export * from './session';
export * from './ai';

export type * from './types';
