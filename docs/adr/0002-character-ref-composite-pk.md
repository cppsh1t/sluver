# CharacterRef composite primary key includes phase_id

Junction tables `event_character_refs` and `scene_character_refs` use a three-column composite primary key `(parent_id, character_id, phase_id)` rather than the simpler `(parent_id, character_id)` with `phase_id` as a non-key attribute.

This makes the **(character, phase) pair** the unit of participation, not the character alone. The same Character MAY appear multiple times in the same Event or Scene with different Phases (e.g. flashback, timeskip, parallel-timeline narration). Each row is a distinct appearance — the display unit is the Phase-appearance, not the Character, so there is no duplication.

Rejected alternative: `(parent_id, character_id)` PK with `phase_id` as a non-key attribute, enforcing one-row-per-character-per-parent. This would block legitimate multi-Phase narration patterns and require UI-level workarounds for flashback/timeskip scenes.
