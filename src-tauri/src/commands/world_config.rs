// Per-World key-value config commands (ADR-0026: TimeMapper).
//
// `world_config` is a simple KV table inside each World's `world.db`
// (mirroring `space_config` in `space.db`). Currently the only key is
// `"time_mapper"`, holding a `TimeMapperConfig` (`{ code: string }`) — the
// user-authored JavaScript function that renders ISO timestamps into the
// World's custom time representation at display time. Identity is implicit
// in which DB file is connected (no `world_id` column), per ADR-0007.
//
// World-scoped, taking `(space_id, world_id)` first per the house style
// (see commands/character.rs / commands/conversation.rs).

use rusqlite::params;
use rusqlite::OptionalExtension;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::TimeMapperConfig;

/// Constant key under which the TimeMapper config is stored in `world_config`.
const TIME_MAPPER_KEY: &str = "time_mapper";

/// Read this World's TimeMapper config. Returns `None` when no row exists
/// (the World has never had a mapper set) OR when the stored value fails to
/// deserialize as `TimeMapperConfig` (corrupt / old format) — the latter is
/// logged at WARN and treated as "no mapper" so the UI falls back to raw
/// ISO, matching ADR-0026's fault-tolerance contract. Never throws for a
/// missing or corrupt row; only infrastructure (SQLite) errors propagate.
#[tracing::instrument(skip(state), fields(entity_id = %world_id))]
#[tauri::command]
pub fn get_time_mapper(
    space_id: String,
    world_id: String,
    state: State<'_, DbManager>,
) -> Result<Option<TimeMapperConfig>, DbError> {
    state.with_world(&space_id, &world_id, |conn| {
        // `.optional()` collapses only `QueryReturnedNoRows` (the "never set"
        // case) to `None`; all other SQLite errors propagate as `DbError::Sqlite`.
        let value: Option<String> = conn
            .query_row(
                "SELECT value FROM world_config WHERE key = ?1",
                params![TIME_MAPPER_KEY],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        match value {
            None => Ok(None),
            Some(json) => match serde_json::from_str::<TimeMapperConfig>(&json) {
                Ok(cfg) => Ok(Some(cfg)),
                Err(e) => {
                    // Fault-tolerant: a corrupt/old-format value is treated
                    // as "no mapper" rather than failing the command. The UI
                    // falls back to raw ISO (ADR-0026).
                    tracing::warn!(
                        world_id = %world_id,
                        error = %e,
                        "world_config.time_mapper failed to deserialize, returning None"
                    );
                    Ok(None)
                }
            },
        }
    })
}

/// Set (upsert) this World's TimeMapper config. The mapper `code` is
/// user-authored JavaScript; it is stored verbatim — the frontend executes
/// it in an isolated Web Worker (ADR-0026). `code` is deliberately NOT
/// logged (creative content — see ADR-0014 redaction policy); it is added
/// to the `skip` set so `#[tracing::instrument]` does not capture it.
#[tracing::instrument(skip(state, code), fields(entity_id = %world_id))]
#[tauri::command]
pub fn set_time_mapper(
    space_id: String,
    world_id: String,
    code: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    let value = serde_json::to_string(&TimeMapperConfig { code })?;
    state.with_world(&space_id, &world_id, |conn| {
        conn.execute(
            "INSERT INTO world_config (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![TIME_MAPPER_KEY, value],
        )?;
        Ok(())
    })
}
