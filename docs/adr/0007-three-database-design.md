# Three-database design (meta.db + per-Space + per-World)

**Status**: accepted — supersedes ADR-0001.

Introducing the Space layer (see `CONTEXT.md`) above World requires three isolation tiers, not two. We use three SQLite file tiers with a symmetric structure:

- `meta.db` (always open) — `spaces` registry (`id`, `name`, `password_hash`, …) + global `settings` KV.
- `spaces/{spaceId}/space.db` (opened when the Space is unlocked) — that Space's `worlds` registry + the reserved `space_config` KV. No `space_id` column — identity is implicit in which file is connected, exactly as ADR-0001 did for worlds.
- `spaces/{spaceId}/worlds/{worldId}.db` — a World's content (schema unchanged from the former `WORLD_SQL`).

Chosen over a two-tier alternative (`meta.db` holding a single `worlds` table with a `space_id` column) for the same reasons ADR-0001 rejected `world_id` columns: file-system-level isolation, cheap per-unit backup (copying `spaces/{spaceId}/` exports a whole Space self-contained), and no global write lock. The Space password hash lives in `meta.db` so the Space-select screen can show lock state and verify a password *before* opening `space.db` (no bootstrapping chicken-and-egg).

Consequences: `DbManager` grows from two lock layers to three (meta → space → world); the established lock-ordering rule (resolve path via the outer lock, release it, then acquire the inner cache lock) generalises linearly. ADR-0001's deadlock caveat applies at each boundary. `World.name` uniqueness is now naturally per-Space (an index inside each `space.db`).
