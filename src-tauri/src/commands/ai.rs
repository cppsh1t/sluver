// AI config commands (ADR-0012: Space-scoped AI provider config).
//
// Two concerns live here:
//   1. `provider_credentials` + `agent_configs` — Space-scoped CRUD against
//      the `space.db` file (uses `DbManager::with_space` exactly like other
//      Space-scoped commands). Provider credentials are UPSERT-by-provider_id;
//      deleting a provider cascades a NULL-out of any agent config whose
//      `model_id` is rooted at that provider (semantic cascade, NOT a SQL FK
//      — the `model_id` column is a free-form composite string).
//   2. `catalog` — global (not Space-scoped) fetch of the models.dev catalog.
//      These two commands are `async` because they drive `reqwest`. The
//      fetched JSON is cached at `data_dir/models-dev.json` with a sibling
//      `models-dev.meta.json` recording the fetch time; a 24h TTL gates
//      refresh. On fetch failure the last good copy is returned with
//      `is_stale: true`; only when no copy exists does the command surface
//      `CatalogFetchFailed`. User-authored custom providers (ADR-0046),
//      stored as a raw JSON string in the meta.db `settings` table under
//      `ai.customProviders`, are parsed and merged into every read (custom
//      wins on provider-id collision). `get_custom_providers` /
//      `set_custom_providers` manage that setting, with save-time
//      validation reported through `CustomProvidersReport`.
//
// All command bodies are thin wrappers over `do_*` helpers that take
// `&DbManager` (sync) or `&Path` (async) — this split makes the helpers
// unit-testable without spinning up the Tauri runtime.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::params;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::agent_config::{AgentConfig, ContextCompaction};
use crate::models::catalog::{
    CatalogMeta, CatalogModel, CatalogProvider, CustomProviderEntryError, CustomProvidersReport,
    ModelsDevCatalog, RawCatalog, RawModel, RawProvider,
};
use crate::models::provider_credential::{ProviderCredential, SetProviderCredentialInput};
use crate::util::{new_id, now_iso};

// ─── models.dev catalog constants ───────────────────────────────────────────

const MODELS_DEV_URL: &str = "https://models.dev/api.json";
/// 24h in seconds. Exceeded (or no meta) → trigger a refresh attempt.
const CATALOG_TTL_SECS: i64 = 24 * 60 * 60;
const CATALOG_FILE: &str = "models-dev.json";
const CATALOG_META_FILE: &str = "models-dev.meta.json";
const CATALOG_FETCH_TIMEOUT_SECS: u64 = 10;

// ═══════════════════════════════════════════════════════════════════════════
// provider_credentials
// ═══════════════════════════════════════════════════════════════════════════

fn row_to_credential(row: &rusqlite::Row) -> rusqlite::Result<ProviderCredential> {
    Ok(ProviderCredential {
        id: row.get("id")?,
        provider_id: row.get("provider_id")?,
        api_key: row.get("api_key")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn row_to_agent_config(row: &rusqlite::Row) -> rusqlite::Result<AgentConfig> {
    Ok(AgentConfig {
        id: row.get("id")?,
        name: row.get("name")?,
        model_id: row.get("model_id")?,
        auto_execute_dangerous_tools: row.get("auto_execute_dangerous_tools")?,
        shell_tool_enabled: row.get("shell_tool_enabled")?,
        context_compaction: ContextCompaction {
            enabled: row.get("context_compaction_enabled")?,
            turn_age: row.get("context_compaction_turn_age")?,
        },
        system_prompt: row.get("system_prompt")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_provider_credentials(
    space_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<ProviderCredential>, DbError> {
    do_list_provider_credentials(&state, &space_id)
}

pub(crate) fn do_list_provider_credentials(
    mgr: &DbManager,
    space_id: &str,
) -> Result<Vec<ProviderCredential>, DbError> {
    mgr.with_space(space_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, provider_id, api_key, created_at, updated_at
             FROM provider_credentials ORDER BY created_at",
        )?;
        let rows = stmt
            .query_map([], row_to_credential)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

#[tracing::instrument(skip(state, input))]
#[tauri::command]
pub fn set_provider_credential(
    space_id: String,
    input: SetProviderCredentialInput,
    state: State<'_, DbManager>,
) -> Result<ProviderCredential, DbError> {
    do_set_provider_credential(&state, &space_id, input)
}

pub(crate) fn do_set_provider_credential(
    mgr: &DbManager,
    space_id: &str,
    input: SetProviderCredentialInput,
) -> Result<ProviderCredential, DbError> {
    let id = new_id();
    let now = now_iso();
    mgr.with_space(space_id, |conn| {
        // UPSERT by provider_id (UNIQUE). `id` is only set on first insert;
        // on conflict the existing row keeps its id (we don't UPDATE it).
        conn.execute(
            "INSERT INTO provider_credentials (id, provider_id, api_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(provider_id) DO UPDATE SET
               api_key = excluded.api_key,
               updated_at = excluded.updated_at",
            params![id, input.provider_id, input.api_key, now],
        )?;
        // Read back the canonical row (handles both insert + update paths).
        conn.query_row(
            "SELECT id, provider_id, api_key, created_at, updated_at
             FROM provider_credentials WHERE provider_id = ?1",
            params![input.provider_id],
            row_to_credential,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                DbError::ProviderCredentialNotFound(input.provider_id.clone())
            }
            other => DbError::Sqlite(other),
        })
    })
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn delete_provider_credential(
    space_id: String,
    id: String,
    state: State<'_, DbManager>,
) -> Result<(), DbError> {
    do_delete_provider_credential(&state, &space_id, &id)
}

pub(crate) fn do_delete_provider_credential(
    mgr: &DbManager,
    space_id: &str,
    id: &str,
) -> Result<(), DbError> {
    let now = now_iso();
    mgr.with_space(space_id, |conn| {
        // Single transaction: read provider_id → delete row → NULL-out
        // dependent agent configs. Wrapping all three in one tx guarantees
        // no window where the credential is gone but agent configs still
        // reference its provider prefix.
        let tx = conn.transaction()?;
        let provider_id: String = tx
            .query_row(
                "SELECT provider_id FROM provider_credentials WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    DbError::ProviderCredentialNotFound(id.to_string())
                }
                other => DbError::Sqlite(other),
            })?;
        let affected = tx.execute(
            "DELETE FROM provider_credentials WHERE id = ?1",
            params![id],
        )?;
        if affected == 0 {
            // Race: row vanished between SELECT and DELETE. Treat as not
            // found — the caller's expectation (it's gone) is satisfied but
            // we surface the error so the UI refreshes from truth.
            return Err(DbError::ProviderCredentialNotFound(id.to_string()));
        }
        // Cascade: clear any agent_config.model_id rooted at this provider.
        // The pattern match (`provider_id/%`) is the contract's defined
        // cascade semantic — see ADR-0006 for the analogous Phase/Character
        // cascade.
        //
        // SQL LIKE wildcards `_` and `%` in the provider_id are escaped so
        // they match literally (ESCAPE '\'). Without this, a provider like
        // `my_provider` would also clear `myXprovider/foo`.
        let escaped = provider_id
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("{escaped}/%");
        tx.execute(
            "UPDATE agent_configs SET model_id = NULL, updated_at = ?1
             WHERE model_id LIKE ?2 ESCAPE '\\'",
            params![now, pattern],
        )?;
        tx.commit()?;
        Ok(())
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// agent configs (read + update model only — creation is seed-only at Space create)
// ═══════════════════════════════════════════════════════════════════════════

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn list_agent_configs(
    space_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<AgentConfig>, DbError> {
    do_list_agent_configs(&state, &space_id)
}

pub(crate) fn do_list_agent_configs(
    mgr: &DbManager,
    space_id: &str,
) -> Result<Vec<AgentConfig>, DbError> {
    mgr.with_space(space_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, model_id, auto_execute_dangerous_tools, shell_tool_enabled,
                    context_compaction_enabled, context_compaction_turn_age,
                    system_prompt, created_at, updated_at
             FROM agent_configs ORDER BY created_at",
        )?;
        let rows = stmt
            .query_map([], row_to_agent_config)?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn update_agent_config_model(
    space_id: String,
    id: String,
    model_id: Option<String>,
    state: State<'_, DbManager>,
) -> Result<AgentConfig, DbError> {
    do_update_agent_config_model(&state, &space_id, &id, model_id)
}

pub(crate) fn do_update_agent_config_model(
    mgr: &DbManager,
    space_id: &str,
    id: &str,
    model_id: Option<String>,
) -> Result<AgentConfig, DbError> {
    let now = now_iso();
    mgr.with_space(space_id, |conn| {
        let affected = conn.execute(
            "UPDATE agent_configs SET model_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![model_id, now, id],
        )?;
        if affected == 0 {
            return Err(DbError::AgentConfigNotFound(id.to_string()));
        }
        // Read back the canonical row (AGENTS.md: read after mutation).
        conn.query_row(
            "SELECT id, name, model_id, auto_execute_dangerous_tools, shell_tool_enabled,
                    context_compaction_enabled, context_compaction_turn_age,
                    system_prompt, created_at, updated_at
             FROM agent_configs WHERE id = ?1",
            params![id],
            row_to_agent_config,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::AgentConfigNotFound(id.to_string()),
            other => DbError::Sqlite(other),
        })
    })
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn update_agent_config_auto_execute(
    space_id: String,
    id: String,
    auto_execute: bool,
    state: State<'_, DbManager>,
) -> Result<AgentConfig, DbError> {
    do_update_agent_config_auto_execute(&state, &space_id, &id, auto_execute)
}

pub(crate) fn do_update_agent_config_auto_execute(
    mgr: &DbManager,
    space_id: &str,
    id: &str,
    auto_execute: bool,
) -> Result<AgentConfig, DbError> {
    let now = now_iso();
    mgr.with_space(space_id, |conn| {
        let affected = conn.execute(
            "UPDATE agent_configs SET auto_execute_dangerous_tools = ?1, updated_at = ?2 WHERE id = ?3",
            params![auto_execute, now, id],
        )?;
        if affected == 0 {
            return Err(DbError::AgentConfigNotFound(id.to_string()));
        }
        // Read back the canonical row (AGENTS.md: read after mutation).
        conn.query_row(
            "SELECT id, name, model_id, auto_execute_dangerous_tools, shell_tool_enabled,
                    context_compaction_enabled, context_compaction_turn_age,
                    system_prompt, created_at, updated_at
             FROM agent_configs WHERE id = ?1",
            params![id],
            row_to_agent_config,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => {
                DbError::AgentConfigNotFound(id.to_string())
            }
            other => DbError::Sqlite(other),
        })
    })
}

#[tracing::instrument(skip(state, id, context_compaction), fields(entity_id = %id))]
#[tauri::command]
pub fn update_agent_config_context_compaction(
    space_id: String,
    id: String,
    context_compaction: ContextCompaction,
    state: State<'_, DbManager>,
) -> Result<AgentConfig, DbError> {
    do_update_agent_config_context_compaction(&state, &space_id, &id, context_compaction)
}

pub(crate) fn do_update_agent_config_context_compaction(
    mgr: &DbManager,
    space_id: &str,
    id: &str,
    context_compaction: ContextCompaction,
) -> Result<AgentConfig, DbError> {
    // Guard: turn_age must be a positive integer. The frontend Zod schema
    // (types/ai.ts) enforces this on the happy path, but a direct IPC call or
    // manual DB edit could bypass it. Reject early so a bad value can never
    // reach SQLite (where it would silently disable or over-compact: a value
    // ≤ 0 compacts every turn including the current one).
    if context_compaction.turn_age <= 0 {
        return Err(DbError::InvalidInput(format!(
            "context_compaction.turn_age must be a positive integer, got {}",
            context_compaction.turn_age
        )));
    }
    let now = now_iso();
    mgr.with_space(space_id, |conn| {
        let affected = conn.execute(
            "UPDATE agent_configs
             SET context_compaction_enabled = ?1,
                 context_compaction_turn_age = ?2,
                 updated_at = ?3
             WHERE id = ?4",
            params![
                context_compaction.enabled,
                context_compaction.turn_age,
                now,
                id
            ],
        )?;
        if affected == 0 {
            return Err(DbError::AgentConfigNotFound(id.to_string()));
        }
        // Read back the canonical row (AGENTS.md: read after mutation).
        conn.query_row(
            "SELECT id, name, model_id, auto_execute_dangerous_tools, shell_tool_enabled,
                    context_compaction_enabled, context_compaction_turn_age,
                    system_prompt, created_at, updated_at
             FROM agent_configs WHERE id = ?1",
            params![id],
            row_to_agent_config,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::AgentConfigNotFound(id.to_string()),
            other => DbError::Sqlite(other),
        })
    })
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn update_agent_config_system_prompt(
    space_id: String,
    id: String,
    system_prompt: String,
    state: State<'_, DbManager>,
) -> Result<AgentConfig, DbError> {
    do_update_agent_config_system_prompt(&state, &space_id, &id, system_prompt)
}

pub(crate) fn do_update_agent_config_system_prompt(
    mgr: &DbManager,
    space_id: &str,
    id: &str,
    system_prompt: String,
) -> Result<AgentConfig, DbError> {
    let now = now_iso();
    mgr.with_space(space_id, |conn| {
        let affected = conn.execute(
            "UPDATE agent_configs SET system_prompt = ?1, updated_at = ?2 WHERE id = ?3",
            params![system_prompt, now, id],
        )?;
        if affected == 0 {
            return Err(DbError::AgentConfigNotFound(id.to_string()));
        }
        // Read back the canonical row (AGENTS.md: read after mutation).
        conn.query_row(
            "SELECT id, name, model_id, auto_execute_dangerous_tools, shell_tool_enabled,
                    context_compaction_enabled, context_compaction_turn_age,
                    system_prompt, created_at, updated_at
             FROM agent_configs WHERE id = ?1",
            params![id],
            row_to_agent_config,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::AgentConfigNotFound(id.to_string()),
            other => DbError::Sqlite(other),
        })
    })
}

#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn update_agent_config_shell_tool(
    space_id: String,
    id: String,
    shell_tool_enabled: bool,
    state: State<'_, DbManager>,
) -> Result<AgentConfig, DbError> {
    do_update_agent_config_shell_tool(&state, &space_id, &id, shell_tool_enabled)
}

pub(crate) fn do_update_agent_config_shell_tool(
    mgr: &DbManager,
    space_id: &str,
    id: &str,
    shell_tool_enabled: bool,
) -> Result<AgentConfig, DbError> {
    let now = now_iso();
    mgr.with_space(space_id, |conn| {
        let affected = conn.execute(
            "UPDATE agent_configs SET shell_tool_enabled = ?1, updated_at = ?2 WHERE id = ?3",
            params![shell_tool_enabled, now, id],
        )?;
        if affected == 0 {
            return Err(DbError::AgentConfigNotFound(id.to_string()));
        }
        // Read back the canonical row (AGENTS.md: read after mutation).
        conn.query_row(
            "SELECT id, name, model_id, auto_execute_dangerous_tools, shell_tool_enabled,
                    context_compaction_enabled, context_compaction_turn_age,
                    system_prompt, created_at, updated_at
             FROM agent_configs WHERE id = ?1",
            params![id],
            row_to_agent_config,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::AgentConfigNotFound(id.to_string()),
            other => DbError::Sqlite(other),
        })
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// custom providers (meta.db settings key `ai.customProviders` — ADR-0046)
// ═══════════════════════════════════════════════════════════════════════════

#[tracing::instrument(skip(state))]
#[tauri::command]
pub fn get_custom_providers(state: State<'_, DbManager>) -> Result<String, DbError> {
    do_get_custom_providers(&state)
}

pub(crate) fn do_get_custom_providers(mgr: &DbManager) -> Result<String, DbError> {
    read_custom_providers_setting(mgr)
}

#[tracing::instrument(skip(state, json))]
#[tauri::command]
pub fn set_custom_providers(
    json: String,
    state: State<'_, DbManager>,
) -> Result<CustomProvidersReport, DbError> {
    do_set_custom_providers(&state, &json)
}

/// Validate + store the custom-providers JSON. Never fails on user-input
/// problems — those flow through the returned [`CustomProvidersReport`]:
/// a syntax error blocks the store entirely (`stored: false`, previous
/// value untouched); per-entry schema errors are reported but tolerated
/// (the valid entries are stored; the catalog loader skips the bad ones
/// identically at read time). The stored value is always the trimmed
/// input.
pub(crate) fn do_set_custom_providers(
    mgr: &DbManager,
    json: &str,
) -> Result<CustomProvidersReport, DbError> {
    let trimmed = json.trim();
    if trimmed.is_empty() {
        // Empty (or whitespace-only) input = clear the setting. "" parses
        // as "no custom providers" at load time.
        write_custom_providers_setting(mgr, "")?;
        tracing::info!(provider_count = 0, "catalog.custom.saved");
        return Ok(CustomProvidersReport {
            syntax_error: None,
            stored: true,
            valid_provider_ids: Vec::new(),
            entry_errors: Vec::new(),
        });
    }

    // Syntax gate: the whole input must parse as a JSON object map before
    // anything is stored — a syntax error never clobbers the previous value.
    let map: HashMap<String, serde_json::Value> = match serde_json::from_str(trimmed) {
        Ok(map) => map,
        Err(e) => {
            return Ok(CustomProvidersReport {
                syntax_error: Some(e.to_string()),
                stored: false,
                valid_provider_ids: Vec::new(),
                entry_errors: Vec::new(),
            });
        }
    };

    // Per-entry validation: the same schema the catalog loader applies, so
    // the save-time report never disagrees with what a subsequent load
    // skips. Per the redaction policy this logs provider ids and serde
    // error descriptions only — never names or JSON content.
    let mut valid_provider_ids = Vec::new();
    let mut entry_errors = Vec::new();
    for (pid, value) in map {
        match serde_json::from_value::<RawProvider>(value) {
            Ok(_raw) => valid_provider_ids.push(pid),
            Err(e) => entry_errors.push(CustomProviderEntryError {
                provider_id: pid,
                message: e.to_string(),
            }),
        }
    }
    valid_provider_ids.sort();
    entry_errors.sort_by(|a, b| a.provider_id.cmp(&b.provider_id));

    write_custom_providers_setting(mgr, trimmed)?;
    tracing::info!(
        provider_count = valid_provider_ids.len(),
        "catalog.custom.saved"
    );
    Ok(CustomProvidersReport {
        syntax_error: None,
        stored: true,
        valid_provider_ids,
        entry_errors,
    })
}

/// Read the raw `ai.customProviders` setting string. Missing key (the
/// normal unset case) → `""`. Short `with_meta` closure — the meta lock
/// is never held across any IO.
fn read_custom_providers_setting(mgr: &DbManager) -> Result<String, DbError> {
    mgr.with_meta(|conn| {
        Ok(conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'ai.customProviders'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_default())
    })
}

/// UPSERT the `ai.customProviders` setting (same statement shape as
/// `commands/setting.rs`).
fn write_custom_providers_setting(mgr: &DbManager, value: &str) -> Result<(), DbError> {
    mgr.with_meta(|conn| {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('ai.customProviders', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![value],
        )?;
        Ok(())
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// catalog (global — models.dev fetch with 24h TTL + stale-copy fallback)
// ═══════════════════════════════════════════════════════════════════════════

#[tracing::instrument(skip(state))]
#[tauri::command]
pub async fn get_models_dev_catalog(
    state: State<'_, DbManager>,
) -> Result<ModelsDevCatalog, DbError> {
    // Read the custom-providers setting BEFORE any fetch/file IO so the
    // merged view is consistent for the whole call — and so the meta lock
    // is released long before the first await.
    let custom_json = read_custom_providers_setting(&state)?;
    // Clone the PathBuf out of State BEFORE any .await so the State borrow
    // ends promptly (State itself is Send but the contained Mutex guard
    // would not be — we never hold one across an await anyway).
    let data_dir = state.data_dir().clone();
    do_get_models_dev_catalog(&data_dir, &custom_json).await
}

pub(crate) async fn do_get_models_dev_catalog(
    data_dir: &Path,
    custom_json: &str,
) -> Result<ModelsDevCatalog, DbError> {
    let (cat_path, meta_path) = catalog_paths(data_dir);

    // TTL check: refresh iff meta missing/corrupt/unparseable OR age > 24h
    // OR catalog file itself is absent.
    let fresh = cat_path.exists() && matches!(read_meta(&meta_path), Some(m) if !is_stale(&m));

    if !fresh {
        if let Err(_fetch_err) = fetch_catalog(&cat_path, &meta_path).await {
            // Fetch failed: fall back to any existing local copy, flagged
            // stale so the UI can warn. No copy → contract says return
            // CatalogFetchFailed.
            if cat_path.exists() {
                return load_catalog_from_disk(data_dir, Some(custom_json), true);
            }
            return Err(DbError::CatalogFetchFailed);
        }
    }

    load_catalog_from_disk(data_dir, Some(custom_json), false)
}

#[tracing::instrument(skip(state))]
#[tauri::command]
pub async fn refresh_models_dev_catalog(
    state: State<'_, DbManager>,
) -> Result<ModelsDevCatalog, DbError> {
    let custom_json = read_custom_providers_setting(&state)?;
    let data_dir = state.data_dir().clone();
    do_refresh_models_dev_catalog(&data_dir, &custom_json).await
}

pub(crate) async fn do_refresh_models_dev_catalog(
    data_dir: &Path,
    custom_json: &str,
) -> Result<ModelsDevCatalog, DbError> {
    let (cat_path, meta_path) = catalog_paths(data_dir);
    // Force-refresh: bypass TTL. Same fallback semantics as get.
    if let Err(_fetch_err) = fetch_catalog(&cat_path, &meta_path).await {
        if cat_path.exists() {
            return load_catalog_from_disk(data_dir, Some(custom_json), true);
        }
        return Err(DbError::CatalogFetchFailed);
    }
    load_catalog_from_disk(data_dir, Some(custom_json), false)
}

// ─── catalog helpers ────────────────────────────────────────────────────────

fn catalog_paths(data_dir: &Path) -> (PathBuf, PathBuf) {
    (
        data_dir.join(CATALOG_FILE),
        data_dir.join(CATALOG_META_FILE),
    )
}

/// Read + parse the meta file. Returns `None` on any failure (missing file,
/// parse error) — the caller treats None as "needs refresh".
fn read_meta(meta_path: &Path) -> Option<CatalogMeta> {
    let s = std::fs::read_to_string(meta_path).ok()?;
    serde_json::from_str(&s).ok()
}

/// `true` iff the cached copy is older than the 24h TTL (or the timestamp
/// is unparseable). Returning `true` triggers a refresh attempt.
fn is_stale(meta: &CatalogMeta) -> bool {
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(&meta.fetched_at) else {
        return true;
    };
    let now = chrono::Utc::now();
    let age = now.signed_duration_since(parsed.with_timezone(&chrono::Utc));
    age.num_seconds() > CATALOG_TTL_SECS
}

/// GET `https://models.dev/api.json`, validate it parses as a catalog, then
/// write both the raw JSON (so later loads can re-parse without re-fetching)
/// and the meta file (recording the fetch time). Any failure is surfaced as
/// a `DbError`; the caller decides whether to fall back to a stale copy.
async fn fetch_catalog(cat_path: &Path, meta_path: &Path) -> Result<(), DbError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(CATALOG_FETCH_TIMEOUT_SECS))
        .build()
        .map_err(|e| DbError::Internal(format!("reqwest build: {e}")))?;

    let resp = client
        .get(MODELS_DEV_URL)
        .send()
        .await
        .map_err(|e| DbError::Internal(format!("reqwest send: {e}")))?;

    if !resp.status().is_success() {
        return Err(DbError::Internal(format!(
            "models.dev returned HTTP {}",
            resp.status()
        )));
    }

    let text = resp
        .text()
        .await
        .map_err(|e| DbError::Internal(format!("reqwest body: {e}")))?;

    // Validate before persisting: a non-catalog response (e.g. an HTML error
    // page from a captive portal) must not overwrite a known-good cache.
    // `parse_catalog` enforces the upstream shape and discards unknowns.
    let _validated = parse_catalog(&text)?;

    // Write atomically-ish: catalog first, then meta. If the process dies
    // between the two writes, the next get() will treat the missing meta as
    // "needs refresh" and re-fetch — no corruption.
    std::fs::write(cat_path, &text)?;
    let meta = CatalogMeta {
        fetched_at: now_iso(),
    };
    std::fs::write(meta_path, serde_json::to_string(&meta)?)?;
    Ok(())
}

/// Load + parse the cached catalog file from `data_dir`, merging the
/// user-authored custom providers parsed from `custom_json` (the raw
/// `ai.customProviders` setting string). `is_stale` is set as given by
/// the caller (`true` when this is a fallback after a failed fetch).
fn load_catalog_from_disk(
    data_dir: &Path,
    custom_json: Option<&str>,
    is_stale: bool,
) -> Result<ModelsDevCatalog, DbError> {
    let (cat_path, meta_path) = catalog_paths(data_dir);
    let text = std::fs::read_to_string(cat_path)?;
    let mut catalog = parse_catalog(&text)?;
    let custom = parse_custom_providers(custom_json.unwrap_or(""));
    let custom_count = custom.len();
    merge_custom_providers(&mut catalog, custom);
    if custom_count > 0 {
        tracing::info!(
            custom_provider_count = custom_count,
            "catalog.custom.loaded"
        );
    }
    catalog.fetched_at = read_meta(&meta_path)
        .map(|m| m.fetched_at)
        .unwrap_or_else(now_iso);
    catalog.is_stale = is_stale;
    Ok(catalog)
}

/// Parse the custom-providers JSON (models.dev api.json shape:
/// `{ "<providerId>": { ... } }`). Identical tolerant semantics to the
/// catalog loader: empty/whitespace input (the normal unset case) →
/// empty vec silently; a syntax error or non-object root → empty vec
/// with a WARN; an individually invalid entry is skipped so one bad row
/// never hides the valid ones. Per the redaction policy this never logs
/// JSON content or provider names — only provider ids and the error
/// description.
fn parse_custom_providers(json: &str) -> Vec<CatalogProvider> {
    if json.trim().is_empty() {
        return Vec::new();
    }
    let map: HashMap<String, serde_json::Value> = match serde_json::from_str(json) {
        Ok(map) => map,
        Err(e) => {
            tracing::warn!(error = %e, "catalog.custom.parse_failed");
            return Vec::new();
        }
    };
    map.into_iter()
        .filter_map(
            |(pid, value)| match serde_json::from_value::<RawProvider>(value) {
                Ok(raw) => {
                    // Zero-model providers are almost certainly a user typo,
                    // but an intentional "shell" provider is plausible — warn,
                    // still include it.
                    if raw.models.is_empty() {
                        tracing::warn!(provider_id = %pid, "catalog.custom.no_models");
                    }
                    Some(raw_provider_to_catalog(pid, raw))
                }
                Err(e) => {
                    tracing::warn!(provider_id = %pid, error = %e, "catalog.custom.entry_skipped");
                    None
                }
            },
        )
        .collect()
}

/// Merge custom providers into a parsed catalog. On provider-id collision
/// the custom entry FULLY replaces the catalog's — a user overriding
/// `openai` wants their definition, not a blend of both. The merged vec
/// is re-sorted by id to preserve the deterministic ordering contract
/// established by `parse_catalog`.
fn merge_custom_providers(catalog: &mut ModelsDevCatalog, custom: Vec<CatalogProvider>) {
    let custom_ids: Vec<String> = custom.iter().map(|p| p.id.clone()).collect();
    catalog.providers.retain(|p| !custom_ids.contains(&p.id));
    catalog.providers.extend(custom);
    catalog.providers.sort_by(|a, b| a.id.cmp(&b.id));
}

/// Map one raw upstream provider row (plus its map key as the id) to the
/// slimmed-down `CatalogProvider`. Shared by the models.dev parse and the
/// custom-providers setting so both go through the identical projection
/// (name fallback to key, `limit.context` → `context_window`,
/// `modalities.input` → `input_modalities`, per-model id sort).
fn raw_provider_to_catalog(pid: String, p: RawProvider) -> CatalogProvider {
    let RawProvider {
        name,
        npm,
        api,
        icon_url,
        models,
    } = p;
    let mut models: Vec<CatalogModel> = models
        .into_iter()
        .map(|(mid, m)| {
            let RawModel {
                name,
                limit,
                modalities,
            } = m;
            CatalogModel {
                id: mid.clone(),
                name: name.unwrap_or(mid),
                // Surface the upstream `limit.context` as the
                // semantic `context_window` (renamed to
                // `contextWindow` in the JSON payload by serde
                // `rename_all`). `limit` is an object
                // `{ context, output }` upstream; we keep only the
                // context half.
                context_window: limit.and_then(|l| l.context),
                // Surface the upstream `modalities.input` as
                // `input_modalities` (`inputModalities` in the
                // JSON payload). `unwrap_or_default` + the
                // non-empty filter make `None` mean "upstream
                // omitted it / unknown" — never "known empty" —
                // so the vision check (input.includes("image"))
                // and the pass-through rule for unknown models
                // (ADR-0044 §D9) both key off the same Option.
                input_modalities: modalities
                    .map(|md| md.input.unwrap_or_default())
                    .filter(|v| !v.is_empty()),
            }
        })
        .collect();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    CatalogProvider {
        id: pid.clone(),
        name: name.unwrap_or(pid),
        npm,
        api_base_url: api,
        icon_url,
        models,
    }
}

/// Parse the upstream models.dev JSON into our slimmed-down catalog. Unknown
/// top-level keys / unknown provider fields / unknown model fields are
/// silently dropped (serde default). Missing `name` falls back to the key
/// so the frontend always has something to render.
///
/// Output is sorted by provider id then model id for deterministic ordering
/// (HashMap iteration order is random; without sorting the frontend would
/// reshuffle the catalog on every call).
fn parse_catalog(json: &str) -> Result<ModelsDevCatalog, DbError> {
    let raw: RawCatalog = serde_json::from_str(json)?;
    let RawCatalog(map) = raw;

    let mut providers: Vec<CatalogProvider> = map
        .into_iter()
        .map(|(pid, p)| raw_provider_to_catalog(pid, p))
        .collect();
    providers.sort_by(|a, b| a.id.cmp(&b.id));

    Ok(ModelsDevCatalog {
        providers,
        fetched_at: String::new(),
        is_stale: false,
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// tests
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
#[path = "tests/ai.rs"]
mod tests;
