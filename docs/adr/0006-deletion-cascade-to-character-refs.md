# Phase / Character deletion cascades to CharacterRefs, with pre-delete disclosure

When a `CharacterPhase` or a `Character` is deleted, any `CharacterRef` rows that depend on it are removed by the database via `ON DELETE CASCADE` foreign keys (`event_character_refs.phase_id`, `scene_character_refs.phase_id`, and the `character_id` columns all cascade). The cascade itself happens at the SQLite level — the application does not manually clean up junction rows.

This is the only referentially consistent option. A `CharacterRef` is a `{ character_id, phase_id }` pair in which **both** columns are `NOT NULL` (ADR-0002 makes the pair, including `phase_id`, the primary key). Deleting a Phase invalidates every ref pinned to that Phase, and the model offers no legal "phase-less appearance" to fall back to — there is nothing to preserve. "Rewriting" dangling refs to another Phase is not viable either: with zero-Phase Characters permitted, there may be no candidate Phase to rewrite to, and auto-picking one would silently misrepresent the author's intent. So the refs must go.

What is **not** acceptable is doing this silently. Deleting the "黑化" Phase could strip a Character's appearances from several Events and Scenes without any warning — a silent, hard-to-notice data loss. The application therefore **discloses the blast radius before deleting a referenced Phase or Character**: it counts the affected Events and Scenes and asks the user to confirm before proceeding. The cascade then runs as usual. Unreferenced Phases/Characters delete with no extra prompt.

Rejected alternatives:
- **Silent cascade** (DB-only, no UI): referentially safe but a data-loss trap for the author.
- **Block deletion while referenced**: forces the user to manually remove each ref from every Event/Scene first — correct but prohibitively tedious for a Phase referenced across many Scenes.
- **Rewrite refs to another Phase**: no consistent target (zero-Phase Characters may have none), and silently re-pinning an appearance to a different Phase falsifies the narrative record.

Implementation note: the disclosure requires a read before the delete (e.g. a `count_phase_refs` command). It lands with the Event slice (Slice 3), since that is the first slice in which `CharacterRef` rows can exist. Until then, deleting a Phase has nothing to cascade and needs no change.
