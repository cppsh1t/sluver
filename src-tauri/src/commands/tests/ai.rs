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
/// two seed agent configs per the contract).
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

// ─── agent_config seed (proves do_create_space wires the seed correctly) ─

#[test]
fn list_agent_configs_returns_seed_explorer_writer_namer_and_vision() {
    let (_tmp, mgr) = make_manager();
    let sid = make_space(&mgr, "S");

    let agent_configs = do_list_agent_configs(&mgr, &sid).expect("list agent configs");
    let names: Vec<&str> = agent_configs.iter().map(|a| a.name.as_str()).collect();
    assert!(
        names.contains(&"explorer"),
        "explorer seed missing: {names:?}"
    );
    assert!(names.contains(&"writer"), "writer seed missing: {names:?}");
    assert!(names.contains(&"namer"), "namer seed missing: {names:?}");
    assert!(names.contains(&"vision"), "vision seed missing: {names:?}");
    assert_eq!(
        agent_configs.len(),
        4,
        "exactly four seed agent configs expected"
    );
    // Seeds are created with model_id = NULL.
    for a in &agent_configs {
        assert!(
            a.model_id.is_none(),
            "seed agent config model_id must be NULL"
        );
    }
}

// ─── update_agent_config_model ──────────────────────────────────────────

#[test]
fn update_agent_config_model_set_and_clear() {
    let (_tmp, mgr) = make_manager();
    let sid = make_space(&mgr, "S");

    let explorer = do_list_agent_configs(&mgr, &sid)
        .expect("list")
        .into_iter()
        .find(|a| a.name == "explorer")
        .expect("explorer exists");

    // Set a model.
    let updated = do_update_agent_config_model(
        &mgr,
        &sid,
        &explorer.id,
        Some("anthropic/claude-sonnet-5".into()),
    )
    .expect("update");
    assert_eq!(
        updated.model_id.as_deref(),
        Some("anthropic/claude-sonnet-5")
    );
    assert_eq!(updated.id, explorer.id);
    assert!(updated.updated_at >= explorer.updated_at);

    // Clear it (None = no model selected).
    let cleared = do_update_agent_config_model(&mgr, &sid, &explorer.id, None).expect("clear");
    assert!(
        cleared.model_id.is_none(),
        "model_id must be NULL after clear"
    );
}

#[test]
fn update_agent_config_model_not_found() {
    let (_tmp, mgr) = make_manager();
    let sid = make_space(&mgr, "S");
    let err = do_update_agent_config_model(&mgr, &sid, "no-such-agent", Some("x/y".into()))
        .expect_err("update missing agent config");
    match err {
        DbError::AgentConfigNotFound(id) => assert_eq!(id, "no-such-agent"),
        other => panic!("expected AgentConfigNotFound, got {other:?}"),
    }
}

// ─── cascade: delete provider NULLs dependent agent_config.model_id ─────

#[test]
fn delete_provider_cascades_agent_config_model_id_to_null() {
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
    for a in do_list_agent_configs(&mgr, &sid).expect("list") {
        if a.name == "explorer" {
            explorer = Some(a);
        } else if a.name == "writer" {
            writer = Some(a);
        }
    }
    let explorer = explorer.expect("explorer seeded");
    let writer = writer.expect("writer seeded");
    do_update_agent_config_model(
        &mgr,
        &sid,
        &explorer.id,
        Some("anthropic/claude-sonnet-5".into()),
    )
    .expect("set explorer model");
    do_update_agent_config_model(&mgr, &sid, &writer.id, Some("openai/gpt-4o".into()))
        .expect("set writer model");

    // Delete the anthropic credential.
    do_delete_provider_credential(&mgr, &sid, &anthropic.id).expect("delete anthropic");

    // explorer's model_id (rooted at anthropic/) MUST be NULL now.
    let agent_configs_after = do_list_agent_configs(&mgr, &sid).expect("list after");
    let explorer_after = agent_configs_after
        .iter()
        .find(|a| a.name == "explorer")
        .expect("explorer still exists");
    assert!(
        explorer_after.model_id.is_none(),
        "anthropic-rooted model_id must cascade to NULL"
    );

    // writer's model_id (rooted at openai/) MUST be untouched.
    let writer_after = agent_configs_after
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
    let final_agent_configs = do_list_agent_configs(&mgr, &sid).expect("final agent configs");
    for a in &final_agent_configs {
        assert!(
            a.model_id.is_none(),
            "all agent config model_ids must be NULL after both providers deleted: {:?}",
            a.name
        );
    }
}

// ─── catalog parsing + TTL helpers (no real HTTP) ──────────────────────

/// Minimal catalog fixture exercising every code path: two providers,
/// one with npm+iconUrl and one without; one model with an explicit name
/// and one relying on the id fallback; plus an unknown field at every
/// level (`extra`) that serde must tolerate. `modalities` carries the
/// real upstream OBJECT shape (`{ input, output }`, ADR-0044 §D9).
const FIXTURE_JSON: &str = r#"{
        "anthropic": {
            "name": "Anthropic",
            "npm": "@ai-sdk/anthropic",
            "iconUrl": "https://example.com/a.svg",
            "extra": "ignored",
            "models": {
                "claude-sonnet-5": {
                    "name": "Claude Sonnet 5",
                    "modalities": { "input": ["text", "image"], "output": ["text"] },
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

    // Input modalities projection (ADR-0044 §D9): present upstream →
    // Some; absent → None. Models sorted by id → [haiku, sonnet-5].
    assert_eq!(
        anthropic.models[0].input_modalities, None,
        "claude-haiku has no modalities upstream → None"
    );
    assert_eq!(
        anthropic.models[1].input_modalities,
        Some(vec!["text".to_string(), "image".to_string()]),
        "claude-sonnet-5 modalities.input projects verbatim"
    );
    assert_eq!(
        openai.models[0].input_modalities, None,
        "gpt-4o has no modalities upstream → None"
    );
}

/// Pins the `modalities.input` → `input_modalities` projection rules
/// (ADR-0044 §D9): object present → Some(input array); object omitted
/// or input omitted/empty → None (unknown, never "known empty").
#[test]
fn parse_catalog_projects_input_modalities() {
    let json = r#"{
            "p": {
                "models": {
                    "vision-model": {
                        "modalities": { "input": ["text", "image"], "output": ["text"] }
                    },
                    "text-only": {
                        "modalities": { "input": ["text"] }
                    },
                    "no-modalities": {
                        "name": "No Modalities"
                    },
                    "empty-modalities": {
                        "modalities": { "input": [] }
                    },
                    "output-only": {
                        "modalities": { "output": ["text"] }
                    }
                }
            }
        }"#;
    let cat = parse_catalog(json).expect("modalities shapes must parse");
    let models = &cat.providers[0].models;
    // Sorted by id: empty-modalities, no-modalities, output-only,
    // text-only, vision-model.
    assert_eq!(
        models[0].input_modalities, None,
        "empty input array → None (filtered)"
    );
    assert_eq!(
        models[1].input_modalities, None,
        "modalities omitted upstream → None"
    );
    assert_eq!(
        models[2].input_modalities, None,
        "modalities without input → None"
    );
    assert_eq!(
        models[3].input_modalities,
        Some(vec!["text".to_string()]),
        "text-only input projects as-is"
    );
    assert_eq!(
        models[4].input_modalities,
        Some(vec!["text".to_string(), "image".to_string()]),
        "vision input projects verbatim"
    );
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

/// The upstream `limit` field is an OBJECT `{ context, output }`, not a
/// bare number. A previous regression typed it `Option<u64>` which made
/// `parse_catalog` reject EVERY real catalog (fresh fetch validation +
/// cached-file fallback both failed). This test pins the real shape so
/// it cannot regress again. Covers: object present, object omitted,
/// and object with only `output` (context should fall back to None).
#[test]
fn parse_catalog_handles_limit_object() {
    let json = r#"{
            "anthropic": {
                "models": {
                    "claude-sonnet-5": {
                        "name": "Claude Sonnet 5",
                        "limit": { "context": 200000, "output": 131072 }
                    },
                    "no-limit-model": {
                        "name": "No Limit"
                    },
                    "output-only": {
                        "name": "Output Only",
                        "limit": { "output": 4096 }
                    }
                }
            }
        }"#;
    let cat = parse_catalog(json).expect("real limit shape must parse");
    let models = &cat.providers[0].models;
    // Sorted by id: claude-sonnet-5, no-limit-model, output-only.
    assert_eq!(models[0].context_window, Some(200000));
    assert_eq!(models[1].context_window, None);
    assert_eq!(
        models[2].context_window, None,
        "limit with only `output` → context_window None"
    );
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
    assert!(
        json.contains("\"providerId\":\"anthropic\""),
        "camelCase: {json}"
    );
    assert!(json.contains("\"apiKey\":\"sk-x\""), "camelCase: {json}");
    assert!(json.contains("\"createdAt\""), "camelCase: {json}");
    assert!(!json.contains("provider_id"), "snake_case leak: {json}");
}

/// AgentConfig serialization shape (camelCase).
#[test]
fn agent_config_serialization_shape() {
    let a = AgentConfig {
        id: "x".into(),
        name: "explorer".into(),
        model_id: Some("anthropic/claude-sonnet-5".into()),
        auto_execute_dangerous_tools: false,
        shell_tool_enabled: false,
        context_compaction: ContextCompaction {
            enabled: false,
            turn_age: 3,
        },
        system_prompt: "".into(),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        updated_at: "2026-01-01T00:00:00.000Z".into(),
    };
    let json = serde_json::to_string(&a).expect("serialize");
    assert!(
        json.contains("\"modelId\":\"anthropic/claude-sonnet-5\""),
        "camelCase: {json}"
    );
    assert!(
        json.contains("\"autoExecuteDangerousTools\":false"),
        "camelCase: {json}"
    );
    assert!(
        json.contains("\"shellToolEnabled\":false"),
        "camelCase: {json}"
    );
    assert!(
        json.contains("\"contextCompaction\":{\"enabled\":false,\"turnAge\":3}"),
        "camelCase contextCompaction: {json}"
    );
    assert!(
        json.contains("\"systemPrompt\":\"\""),
        "camelCase systemPrompt: {json}"
    );
    assert!(!json.contains("model_id"), "snake_case leak: {json}");
    assert!(
        !json.contains("auto_execute_dangerous_tools"),
        "snake_case leak: {json}"
    );
    assert!(
        !json.contains("shell_tool_enabled"),
        "snake_case leak: {json}"
    );
    assert!(
        !json.contains("context_compaction") && !json.contains("turn_age"),
        "snake_case leak: {json}"
    );
    assert!(!json.contains("system_prompt"), "snake_case leak: {json}");
}

/// SetProviderCredentialInput deserializes from camelCase frontend input.
#[test]
fn set_provider_credential_input_deserializes_camel_case() {
    let json = r#"{"providerId":"openai","apiKey":"sk-xyz"}"#;
    let input: SetProviderCredentialInput = serde_json::from_str(json).expect("deserialize");
    assert_eq!(input.provider_id, "openai");
    assert_eq!(input.api_key, "sk-xyz");
}
