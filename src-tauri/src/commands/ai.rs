// AI config commands (ADR-0012: Space-scoped AI provider config).
//
// Two concerns live here:
//   1. `provider_credentials` + `agents` — Space-scoped CRUD against the
//      `space.db` file (uses `DbManager::with_space` exactly like other
//      Space-scoped commands). Provider credentials are UPSERT-by-provider_id;
//      deleting a provider cascades a NULL-out of any agent whose `model_id`
//      is rooted at that provider (semantic cascade, NOT a SQL FK — the
//      `model_id` column is a free-form composite string).
//   2. `catalog` — global (not Space-scoped) fetch of the models.dev catalog.
//      These two commands are `async` because they drive `reqwest`. The
//      fetched JSON is cached at `data_dir/models-dev.json` with a sibling
//      `models-dev.meta.json` recording the fetch time; a 24h TTL gates
//      refresh. On fetch failure the last good copy is returned with
//      `is_stale: true`; only when no copy exists does the command surface
//      `CatalogFetchFailed`.
//
// All command bodies are thin wrappers over `do_*` helpers that take
// `&DbManager` (sync) or `&Path` (async) — this split makes the helpers
// unit-testable without spinning up the Tauri runtime.

use std::path::{Path, PathBuf};

use rusqlite::params;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::agent::Agent;
use crate::models::catalog::{CatalogMeta, CatalogModel, CatalogProvider, ModelsDevCatalog, RawCatalog, RawModel, RawProvider};
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

fn row_to_agent(row: &rusqlite::Row) -> rusqlite::Result<Agent> {
    Ok(Agent {
        id: row.get("id")?,
        name: row.get("name")?,
        model_id: row.get("model_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

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
        // dependent agents. Wrapping all three in one tx guarantees no
        // window where the credential is gone but agents still reference
        // its provider prefix.
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
        // Cascade: clear any agent.model_id rooted at this provider. The
        // pattern match (`provider_id/%`) is the contract's defined cascade
        // semantic — see ADR-0006 for the analogous Phase/Character cascade.
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
            "UPDATE agents SET model_id = NULL, updated_at = ?1
             WHERE model_id LIKE ?2 ESCAPE '\\'",
            params![now, pattern],
        )?;
        tx.commit()?;
        Ok(())
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// agents (read + update model only — creation is seed-only at Space create)
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub fn list_agents(
    space_id: String,
    state: State<'_, DbManager>,
) -> Result<Vec<Agent>, DbError> {
    do_list_agents(&state, &space_id)
}

pub(crate) fn do_list_agents(
    mgr: &DbManager,
    space_id: &str,
) -> Result<Vec<Agent>, DbError> {
    mgr.with_space(space_id, |conn| {
        let mut stmt = conn.prepare(
            "SELECT id, name, model_id, created_at, updated_at
             FROM agents ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], row_to_agent)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
}

#[tauri::command]
pub fn update_agent_model(
    space_id: String,
    id: String,
    model_id: Option<String>,
    state: State<'_, DbManager>,
) -> Result<Agent, DbError> {
    do_update_agent_model(&state, &space_id, &id, model_id)
}

pub(crate) fn do_update_agent_model(
    mgr: &DbManager,
    space_id: &str,
    id: &str,
    model_id: Option<String>,
) -> Result<Agent, DbError> {
    let now = now_iso();
    mgr.with_space(space_id, |conn| {
        let affected = conn.execute(
            "UPDATE agents SET model_id = ?1, updated_at = ?2 WHERE id = ?3",
            params![model_id, now, id],
        )?;
        if affected == 0 {
            return Err(DbError::AgentNotFound(id.to_string()));
        }
        // Read back the canonical row (AGENTS.md: read after mutation).
        conn.query_row(
            "SELECT id, name, model_id, created_at, updated_at
             FROM agents WHERE id = ?1",
            params![id],
            row_to_agent,
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => DbError::AgentNotFound(id.to_string()),
            other => DbError::Sqlite(other),
        })
    })
}

// ═══════════════════════════════════════════════════════════════════════════
// catalog (global — models.dev fetch with 24h TTL + stale-copy fallback)
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub async fn get_models_dev_catalog(
    state: State<'_, DbManager>,
) -> Result<ModelsDevCatalog, DbError> {
    // Clone the PathBuf out of State BEFORE any .await so the State borrow
    // ends promptly (State itself is Send but the contained Mutex guard
    // would not be — we never hold one across an await anyway).
    let data_dir = state.data_dir().clone();
    do_get_models_dev_catalog(&data_dir).await
}

pub(crate) async fn do_get_models_dev_catalog(
    data_dir: &Path,
) -> Result<ModelsDevCatalog, DbError> {
    let (cat_path, meta_path) = catalog_paths(data_dir);

    // TTL check: refresh iff meta missing/corrupt/unparseable OR age > 24h
    // OR catalog file itself is absent.
    let fresh = cat_path.exists()
        && matches!(read_meta(&meta_path), Some(m) if !is_stale(&m));

    if !fresh {
        if let Err(_fetch_err) = fetch_catalog(&cat_path, &meta_path).await {
            // Fetch failed: fall back to any existing local copy, flagged
            // stale so the UI can warn. No copy → contract says return
            // CatalogFetchFailed.
            if cat_path.exists() {
                return load_catalog_from_disk(&cat_path, &meta_path, true);
            }
            return Err(DbError::CatalogFetchFailed);
        }
    }

    load_catalog_from_disk(&cat_path, &meta_path, false)
}

#[tauri::command]
pub async fn refresh_models_dev_catalog(
    state: State<'_, DbManager>,
) -> Result<ModelsDevCatalog, DbError> {
    let data_dir = state.data_dir().clone();
    do_refresh_models_dev_catalog(&data_dir).await
}

pub(crate) async fn do_refresh_models_dev_catalog(
    data_dir: &Path,
) -> Result<ModelsDevCatalog, DbError> {
    let (cat_path, meta_path) = catalog_paths(data_dir);
    // Force-refresh: bypass TTL. Same fallback semantics as get.
    if let Err(_fetch_err) = fetch_catalog(&cat_path, &meta_path).await {
        if cat_path.exists() {
            return load_catalog_from_disk(&cat_path, &meta_path, true);
        }
        return Err(DbError::CatalogFetchFailed);
    }
    load_catalog_from_disk(&cat_path, &meta_path, false)
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

/// Load + parse the cached catalog file. `is_stale` is set as given by the
/// caller (`true` when this is a fallback after a failed fetch).
fn load_catalog_from_disk(
    cat_path: &Path,
    meta_path: &Path,
    is_stale: bool,
) -> Result<ModelsDevCatalog, DbError> {
    let text = std::fs::read_to_string(cat_path)?;
    let mut catalog = parse_catalog(&text)?;
    catalog.fetched_at = read_meta(meta_path)
        .map(|m| m.fetched_at)
        .unwrap_or_else(now_iso);
    catalog.is_stale = is_stale;
    Ok(catalog)
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
        .map(|(pid, p)| {
            let RawProvider {
                name,
                npm,
                icon_url,
                models,
            } = p;
            let mut models: Vec<CatalogModel> = models
                .into_iter()
                .map(|(mid, m)| {
                    let RawModel { name } = m;
                    CatalogModel {
                        id: mid.clone(),
                        name: name.unwrap_or(mid),
                    }
                })
                .collect();
            models.sort_by(|a, b| a.id.cmp(&b.id));
            CatalogProvider {
                id: pid.clone(),
                name: name.unwrap_or(pid),
                npm,
                icon_url,
                models,
            }
        })
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
mod tests {
    use super::*;
    use crate::commands::space::do_create_space;
    use crate::models::space::CreateSpaceInput;
    use tempfile::TempDir;

    /// Bootstrap a real `DbManager` against an isolated tempdir. The
    /// `TempDir` is bound first in the tuple so it drops AFTER the manager
    /// (Rust drops in reverse declaration order), ensuring SQLite
    /// connections close before the temp files vanish (matters for WAL on
    /// Windows).
    fn make_manager() -> (TempDir, DbManager) {
        let tmp = TempDir::new().expect("tempdir");
        let data_dir = tmp.path().to_path_buf();
        let mgr = DbManager::new(data_dir).expect("manager new");
        (tmp, mgr)
    }

    /// Create a Space and return its id (the Space's `space.db` gets the
    /// two seed agents per the contract).
    fn make_space(mgr: &DbManager, name: &str) -> String {
        let s = do_create_space(
            mgr,
            CreateSpaceInput {
                name: name.into(),
                password: None,
            },
        )
        .expect("create space");
        s.id
    }

    // ─── provider_credentials ──────────────────────────────────────────────

    #[test]
    fn set_provider_credential_insert_then_upsert() {
        let (_tmp, mgr) = make_manager();
        let sid = make_space(&mgr, "S");

        // First write = INSERT.
        let first = do_set_provider_credential(
            &mgr,
            &sid,
            SetProviderCredentialInput {
                provider_id: "anthropic".into(),
                api_key: "sk-first".into(),
            },
        )
        .expect("insert");
        assert_eq!(first.provider_id, "anthropic");
        assert_eq!(first.api_key, "sk-first");
        let original_id = first.id.clone();
        let original_created = first.created_at.clone();

        // Second write with the SAME provider_id = UPDATE (UPSERT). The row
        // id and created_at must stay stable; only api_key + updated_at move.
        let second = do_set_provider_credential(
            &mgr,
            &sid,
            SetProviderCredentialInput {
                provider_id: "anthropic".into(),
                api_key: "sk-rotated".into(),
            },
        )
        .expect("upsert");
        assert_eq!(second.id, original_id, "UPSERT must keep the row id");
        assert_eq!(
            second.created_at, original_created,
            "UPSERT must not bump created_at"
        );
        assert_eq!(second.api_key, "sk-rotated", "api_key rotated");
        assert!(
            second.updated_at >= first.updated_at,
            "updated_at must advance (or stay equal within ms)"
        );
    }

    #[test]
    fn list_provider_credentials_ordered_by_created_at() {
        let (_tmp, mgr) = make_manager();
        let sid = make_space(&mgr, "S");

        // Insert two distinct providers.
        do_set_provider_credential(
            &mgr,
            &sid,
            SetProviderCredentialInput {
                provider_id: "openai".into(),
                api_key: "k1".into(),
            },
        )
        .expect("insert openai");
        do_set_provider_credential(
            &mgr,
            &sid,
            SetProviderCredentialInput {
                provider_id: "anthropic".into(),
                api_key: "k2".into(),
            },
        )
        .expect("insert anthropic");

        let list = do_list_provider_credentials(&mgr, &sid).expect("list");
        assert_eq!(list.len(), 2, "two distinct providers");
        // Order is created_at ascending — openai was inserted first.
        assert_eq!(list[0].provider_id, "openai");
        assert_eq!(list[1].provider_id, "anthropic");
    }

    #[test]
    fn delete_provider_credential_not_found() {
        let (_tmp, mgr) = make_manager();
        let sid = make_space(&mgr, "S");
        let err = do_delete_provider_credential(&mgr, &sid, "ghost-id")
            .expect_err("delete missing credential");
        match err {
            DbError::ProviderCredentialNotFound(id) => assert_eq!(id, "ghost-id"),
            other => panic!("expected ProviderCredentialNotFound, got {other:?}"),
        }
    }

    // ─── agent seed (proves do_create_space wires the seed correctly) ───────

    #[test]
    fn list_agents_returns_seed_explorer_and_writer() {
        let (_tmp, mgr) = make_manager();
        let sid = make_space(&mgr, "S");

        let agents = do_list_agents(&mgr, &sid).expect("list agents");
        let names: Vec<&str> = agents.iter().map(|a| a.name.as_str()).collect();
        assert!(
            names.contains(&"explorer"),
            "explorer seed missing: {names:?}"
        );
        assert!(names.contains(&"writer"), "writer seed missing: {names:?}");
        assert_eq!(agents.len(), 2, "exactly two seed agents expected");
        // Seeds are created with model_id = NULL.
        for a in &agents {
            assert!(a.model_id.is_none(), "seed agent model_id must be NULL");
        }
    }

    // ─── update_agent_model ────────────────────────────────────────────────

    #[test]
    fn update_agent_model_set_and_clear() {
        let (_tmp, mgr) = make_manager();
        let sid = make_space(&mgr, "S");

        let explorer = do_list_agents(&mgr, &sid)
            .expect("list")
            .into_iter()
            .find(|a| a.name == "explorer")
            .expect("explorer exists");

        // Set a model.
        let updated = do_update_agent_model(
            &mgr,
            &sid,
            &explorer.id,
            Some("anthropic/claude-sonnet-5".into()),
        )
        .expect("update");
        assert_eq!(updated.model_id.as_deref(), Some("anthropic/claude-sonnet-5"));
        assert_eq!(updated.id, explorer.id);
        assert!(updated.updated_at >= explorer.updated_at);

        // Clear it (None = no model selected).
        let cleared = do_update_agent_model(&mgr, &sid, &explorer.id, None).expect("clear");
        assert!(cleared.model_id.is_none(), "model_id must be NULL after clear");
    }

    #[test]
    fn update_agent_model_not_found() {
        let (_tmp, mgr) = make_manager();
        let sid = make_space(&mgr, "S");
        let err = do_update_agent_model(&mgr, &sid, "no-such-agent", Some("x/y".into()))
            .expect_err("update missing agent");
        match err {
            DbError::AgentNotFound(id) => assert_eq!(id, "no-such-agent"),
            other => panic!("expected AgentNotFound, got {other:?}"),
        }
    }

    // ─── cascade: delete provider NULLs dependent agent.model_id ───────────

    #[test]
    fn delete_provider_cascades_agent_model_id_to_null() {
        let (_tmp, mgr) = make_manager();
        let sid = make_space(&mgr, "S");

        // Configure anthropic + openai.
        let anthropic = do_set_provider_credential(
            &mgr,
            &sid,
            SetProviderCredentialInput {
                provider_id: "anthropic".into(),
                api_key: "k-a".into(),
            },
        )
        .expect("insert anthropic");
        let openai = do_set_provider_credential(
            &mgr,
            &sid,
            SetProviderCredentialInput {
                provider_id: "openai".into(),
                api_key: "k-o".into(),
            },
        )
        .expect("insert openai");

        // Point explorer at an anthropic model + writer at an openai model.
        let mut explorer = None;
        let mut writer = None;
        for a in do_list_agents(&mgr, &sid).expect("list") {
            if a.name == "explorer" {
                explorer = Some(a);
            } else if a.name == "writer" {
                writer = Some(a);
            }
        }
        let explorer = explorer.expect("explorer seeded");
        let writer = writer.expect("writer seeded");
        do_update_agent_model(
            &mgr,
            &sid,
            &explorer.id,
            Some("anthropic/claude-sonnet-5".into()),
        )
        .expect("set explorer model");
        do_update_agent_model(
            &mgr,
            &sid,
            &writer.id,
            Some("openai/gpt-4o".into()),
        )
        .expect("set writer model");

        // Delete the anthropic credential.
        do_delete_provider_credential(&mgr, &sid, &anthropic.id).expect("delete anthropic");

        // explorer's model_id (rooted at anthropic/) MUST be NULL now.
        let agents_after = do_list_agents(&mgr, &sid).expect("list after");
        let explorer_after = agents_after
            .iter()
            .find(|a| a.name == "explorer")
            .expect("explorer still exists");
        assert!(
            explorer_after.model_id.is_none(),
            "anthropic-rooted model_id must cascade to NULL"
        );

        // writer's model_id (rooted at openai/) MUST be untouched.
        let writer_after = agents_after
            .iter()
            .find(|a| a.name == "writer")
            .expect("writer still exists");
        assert_eq!(
            writer_after.model_id.as_deref(),
            Some("openai/gpt-4o"),
            "openai-rooted model_id must NOT be cascaded"
        );

        // And the credential is gone from the list.
        let creds = do_list_provider_credentials(&mgr, &sid).expect("creds");
        assert!(
            !creds.iter().any(|c| c.id == anthropic.id),
            "deleted credential must be absent"
        );
        assert!(creds.iter().any(|c| c.id == openai.id), "openai untouched");

        // Sanity: deleting openai too cascades the writer.
        do_delete_provider_credential(&mgr, &sid, &openai.id).expect("delete openai");
        let final_agents = do_list_agents(&mgr, &sid).expect("final agents");
        for a in &final_agents {
            assert!(
                a.model_id.is_none(),
                "all agent model_ids must be NULL after both providers deleted: {:?}",
                a.name
            );
        }
    }

    // ─── catalog parsing + TTL helpers (no real HTTP) ──────────────────────

    /// Minimal catalog fixture exercising every code path: two providers,
    /// one with npm+iconUrl and one without; one model with an explicit name
    /// and one relying on the id fallback; plus an unknown field at every
    /// level (`extra`) that serde must tolerate.
    const FIXTURE_JSON: &str = r#"{
        "anthropic": {
            "name": "Anthropic",
            "npm": "@ai-sdk/anthropic",
            "iconUrl": "https://example.com/a.svg",
            "extra": "ignored",
            "models": {
                "claude-sonnet-5": {
                    "name": "Claude Sonnet 5",
                    "modalities": ["text"],
                    "extra": "ignored"
                },
                "claude-haiku": {
                    "extra": "model with no name falls back to id"
                }
            }
        },
        "openai": {
            "models": {
                "gpt-4o": { "name": "GPT-4o" }
            }
        }
    }"#;

    #[test]
    fn parse_catalog_projects_and_falls_back() {
        let cat = parse_catalog(FIXTURE_JSON).expect("parse fixture");
        // Sorted by id → anthropic, openai.
        assert_eq!(cat.providers.len(), 2);
        assert_eq!(cat.providers[0].id, "anthropic");
        assert_eq!(cat.providers[1].id, "openai");

        let anthropic = &cat.providers[0];
        assert_eq!(anthropic.name, "Anthropic");
        assert_eq!(anthropic.npm.as_deref(), Some("@ai-sdk/anthropic"));
        assert_eq!(
            anthropic.icon_url.as_deref(),
            Some("https://example.com/a.svg")
        );
        // Models sorted by id → claude-haiku, claude-sonnet-5.
        assert_eq!(anthropic.models.len(), 2);
        assert_eq!(anthropic.models[0].id, "claude-haiku");
        // claude-haiku had no `name` → falls back to its id.
        assert_eq!(anthropic.models[0].name, "claude-haiku");
        assert_eq!(anthropic.models[1].id, "claude-sonnet-5");
        assert_eq!(anthropic.models[1].name, "Claude Sonnet 5");

        let openai = &cat.providers[1];
        // Provider with no `name` → falls back to id.
        assert_eq!(openai.name, "openai");
        assert!(openai.npm.is_none());
        assert!(openai.icon_url.is_none());
        assert_eq!(openai.models.len(), 1);
        assert_eq!(openai.models[0].id, "gpt-4o");
        assert_eq!(openai.models[0].name, "GPT-4o");
    }

    #[test]
    fn parse_catalog_rejects_non_object() {
        // A non-object upstream response (e.g. an HTML error page) must NOT
        // parse as a catalog — this guards the "validate before persist"
        // check in `fetch_catalog`.
        let err = parse_catalog("<html>not json</html>").expect_err("must reject");
        assert!(matches!(err, DbError::Serde(_)));
    }

    #[test]
    fn parse_catalog_accepts_empty_object() {
        let cat = parse_catalog("{}").expect("empty catalog is valid");
        assert!(cat.providers.is_empty());
    }

    /// Write a (catalog, meta) pair to a tempdir, then prove the disk loader
    /// round-trips the data + honors the `is_stale` flag.
    #[test]
    fn load_catalog_from_disk_round_trip() {
        let tmp = TempDir::new().expect("tempdir");
        let data_dir = tmp.path();
        let (cat_path, meta_path) = catalog_paths(data_dir);
        std::fs::write(&cat_path, FIXTURE_JSON).expect("write catalog");
        let fetched_at = "2026-07-22T10:00:00.000Z";
        std::fs::write(
            &meta_path,
            serde_json::to_string(&CatalogMeta {
                fetched_at: fetched_at.into(),
            })
            .unwrap(),
        )
        .expect("write meta");

        let cat = load_catalog_from_disk(&cat_path, &meta_path, false).expect("load");
        assert_eq!(cat.fetched_at, fetched_at);
        assert!(!cat.is_stale);
        assert_eq!(cat.providers.len(), 2);

        // is_stale flag passes through unchanged.
        let stale = load_catalog_from_disk(&cat_path, &meta_path, true).expect("load stale");
        assert!(stale.is_stale);
        assert_eq!(stale.fetched_at, fetched_at);
    }

    #[test]
    fn is_stale_flags_old_timestamp() {
        // 25h ago → stale.
        let old = chrono::Utc::now() - chrono::Duration::seconds(CATALOG_TTL_SECS + 3600);
        let meta_old = CatalogMeta {
            fetched_at: old.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        };
        assert!(is_stale(&meta_old));

        // 1h ago → fresh.
        let recent = chrono::Utc::now() - chrono::Duration::seconds(3600);
        let meta_recent = CatalogMeta {
            fetched_at: recent.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        };
        assert!(!is_stale(&meta_recent));
    }

    #[test]
    fn is_stale_treats_unparseable_as_stale() {
        let meta = CatalogMeta {
            fetched_at: "not-a-timestamp".into(),
        };
        assert!(is_stale(&meta), "unparseable fetchedAt → treat as stale");
    }

    /// Sanity: catalog_paths joins the canonical filenames onto data_dir.
    #[test]
    fn catalog_paths_join_data_dir() {
        let data_dir = Path::new("/tmp/sluver-data");
        let (cat, meta) = catalog_paths(data_dir);
        assert_eq!(cat, Path::new("/tmp/sluver-data/models-dev.json"));
        assert_eq!(meta, Path::new("/tmp/sluver-data/models-dev.meta.json"));
    }

    /// CatalogMeta serializes to `{ "fetchedAt": "..." }` (camelCase) so the
    /// sibling meta file matches the frontend's JSON conventions.
    #[test]
    fn catalog_meta_serializes_camel_case() {
        let meta = CatalogMeta {
            fetched_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let json = serde_json::to_string(&meta).expect("serialize");
        assert!(json.contains("\"fetchedAt\""), "camelCase key: {json}");
        assert!(!json.contains("fetched_at"), "snake_case leaked: {json}");
    }

    /// Provider credential serialization shape (camelCase + no extra fields).
    #[test]
    fn provider_credential_serialization_shape() {
        let pc = ProviderCredential {
            id: "abc".into(),
            provider_id: "anthropic".into(),
            api_key: "sk-x".into(),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let json = serde_json::to_string(&pc).expect("serialize");
        assert!(json.contains("\"providerId\":\"anthropic\""), "camelCase: {json}");
        assert!(json.contains("\"apiKey\":\"sk-x\""), "camelCase: {json}");
        assert!(json.contains("\"createdAt\""), "camelCase: {json}");
        assert!(!json.contains("provider_id"), "snake_case leak: {json}");
    }

    /// Agent serialization shape (camelCase).
    #[test]
    fn agent_serialization_shape() {
        let a = Agent {
            id: "x".into(),
            name: "explorer".into(),
            model_id: Some("anthropic/claude-sonnet-5".into()),
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        };
        let json = serde_json::to_string(&a).expect("serialize");
        assert!(json.contains("\"modelId\":\"anthropic/claude-sonnet-5\""), "camelCase: {json}");
        assert!(!json.contains("model_id"), "snake_case leak: {json}");
    }

    /// SetProviderCredentialInput deserializes from camelCase frontend input.
    #[test]
    fn set_provider_credential_input_deserializes_camel_case() {
        let json = r#"{"providerId":"openai","apiKey":"sk-xyz"}"#;
        let input: SetProviderCredentialInput =
            serde_json::from_str(json).expect("deserialize");
        assert_eq!(input.provider_id, "openai");
        assert_eq!(input.api_key, "sk-xyz");
    }
}
