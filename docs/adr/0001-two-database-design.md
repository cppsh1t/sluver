# Two-database design (meta.db + per-World files)

Each World is its own SQLite database file under `{app_data_dir}/worlds/{uuid}.db`. Only the World registry (`worlds` table) and app settings (`settings` KV table) live in the always-open `meta.db`. World-scoped tables have NO `world_id` column — identity is implicit in which file is connected.

Chosen over the alternative of a single database with `world_id` columns on every table, for:

- Cheap per-World backup/export (copy one file)
- File-system-level isolation between projects
- No global write lock across all Worlds (each World has its own WAL)

Tradeoffs:

- No cross-World references possible at any layer (see ADR-0004)
- Lazy connection caching required in `DbManager` with careful lock ordering: the `meta` lock must be released before acquiring the `worlds` lock, or deadlock results
- World registry operations and world-scoped operations go through different DB connections — no single transaction can span both
