use serde::Serialize;
use std::collections::HashMap;

/// Structured payload that the frontend receives when a command rejects.
///
/// Business errors (WorldNotFound / NotFound) carry a stable `code` plus
/// interpolation `args` so the frontend can translate them via i18n.
/// Infrastructure errors (SQLite / IO / Migration / Serde) collapse to
/// `code = "INTERNAL_ERROR"` with the raw English `message` as a fallback,
/// since their underlying messages are dynamic and low-value to translate.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub code: String,
    pub message: String,
    pub args: HashMap<String, String>,
}

/// Unified error type for all database operations.
///
/// The custom `Serialize` impl emits an [`ErrorPayload`] object so the
/// frontend can branch on `code` for translated messages; the `thiserror`
/// `Display` strings are kept for Rust-side logging and as the English
/// fallback in `ErrorPayload::message`.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),

    #[error("World not found: {0}")]
    WorldNotFound(String),

    #[error("{0} not found: {1}")]
    NotFound(&'static str, String),

    #[error("Space not found: {0}")]
    SpaceNotFound(String),

    #[error("Space name already taken: {0}")]
    SpaceNameTaken(String),

    #[error("Space password required: {0}")]
    SpacePasswordRequired(String),

    #[error("Wrong password for space: {0}")]
    SpaceWrongPassword(String),

    /// AI provider credential row not found (delete on a missing id).
    /// Surfaces as `PROVIDER_CREDENTIAL_NOT_FOUND` with `{ id }`.
    #[error("Provider credential not found: {0}")]
    ProviderCredentialNotFound(String),

    /// AI agent config row not found (update on a missing agent config id).
    /// Surfaces as `AGENT_CONFIG_NOT_FOUND` with `{ id }`.
    #[error("AgentConfig not found: {0}")]
    AgentConfigNotFound(String),

    /// models.dev catalog fetch failed AND no local fallback copy exists.
    /// Surfaces as `CATALOG_FETCH_FAILED` (no args). When a stale local copy
    /// IS available, the catalog commands return it with `is_stale: true`
    /// instead of surfacing this error.
    #[error("Catalog fetch failed and no local copy available")]
    CatalogFetchFailed,

    /// Client supplied a malformed id used in path construction (e.g. a
    /// non-UUID `space_id` that could enable path traversal). Surfaces as
    /// `INVALID_INPUT` so the frontend can show a generic "bad request"
    /// message; the raw id is kept in `message` for diagnostics.
    #[error("Invalid input: {0}")]
    InvalidInput(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Migration error: {0}")]
    Migration(#[from] rusqlite_migration::Error),

    #[error("Serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    /// Catch-all for infrastructure/framework errors that don't fit a more
    /// specific variant (e.g. a `tauri::Error` from window/tray operations).
    /// Collapses to `INTERNAL_ERROR` — the dynamic message is the only useful
    /// information, so it's not worth translating.
    #[error("{0}")]
    Internal(String),

    /// Failed to initialize the `tracing` logging subscriber
    /// (ADR-0014). Surfaces as `LOGGING_INIT_FAILED` with no args — the
    /// dynamic error message lives in `message` for diagnostics only. This is
    /// raised before logging is even available, so it can't be logged itself;
    /// the frontend surfaces a generic translated message via the code.
    #[error("Logging init failed: {0}")]
    LoggingInit(String),

    /// Failed to reload the `EnvFilter` on an already-initialized subscriber.
    /// Surfaces as `LOGGING_RELOAD_FAILED` — distinct from `LoggingInit`
    /// because it happens at runtime (post-startup verbosity change) where
    /// the original subscriber is still healthy and emitting.
    #[allow(dead_code)] // Constructed only by `LoggingState::reload_filter*`
                       // which is wired up in a downstream task (logging
                       // commands TBA — see ADR-0014 "frontend_log" + the
                       // runtime verbosity change UI).
    #[error("Logging reload failed: {0}")]
    LoggingReload(String),

    /// Per-entity image upload rejected — base64 decode failed, the
    /// `image_mime` is not in the allowlist (`image/webp`, `image/jpeg`,
    /// `image/png`), or the decoded payload exceeds the 1 MiB defense-
    /// in-depth ceiling. Surfaces as `INVALID_IMAGE` with no args (the
    /// reason is binary on the Rust side; the frontend surfaces a generic
    /// translated "image is invalid or too large" message).
    #[error("Invalid image")]
    InvalidImage,

    /// Caller passed a value to `set_log_level` that isn't one of the three
    /// allowed tiers (`standard` / `verbose` / `very_verbose`). Surfaces as
    /// `INVALID_LOG_LEVEL` with `{ provided }` so the frontend can render
    /// a translated "unknown log level '<provided>'" message.
    #[allow(dead_code)] // Constructed only by the `set_log_level` command,
                       // wired up in a downstream task (logging commands
                       // TBA — see ADR-0014).
    #[error("Invalid log level: {0}")]
    InvalidLogLevel(String),

    /// `export_logs` failed midway (zip write, file read, IO). The dynamic
    /// message is the only useful information; surfaces as
    /// `LOG_EXPORT_FAILED` with no args. The partial output file (if any)
    /// is the caller's responsibility to clean up.
    #[allow(dead_code)] // Constructed only by the `export_logs` command,
                       // wired up in a downstream task (logging commands
                       // TBA — see ADR-0014).
    #[error("Log export failed: {0}")]
    LogExportFailed(String),

    /// `export_novel` failed midway (file IO, epub build, etc.). Dynamic
    /// message only; surfaces as `NOVEL_EXPORT_FAILED`. Partial output file
    /// cleanup is NOT attempted (the file may be valid up to the failure
    /// point for EPUB; for TXT it's a complete prefix).
    #[error("Novel export failed: {0}")]
    NovelExportFailed(String),
}

impl DbError {
    /// Map this error into a serializable payload.
    fn to_payload(&self) -> ErrorPayload {
        let (code, args): (&'static str, HashMap<String, String>) = match self {
            DbError::WorldNotFound(id) => (
                "WORLD_NOT_FOUND",
                HashMap::from([("id".to_string(), id.clone())]),
            ),
            DbError::NotFound(entity, id) => (
                "NOT_FOUND",
                HashMap::from([
                    ("entity".to_string(), (*entity).to_string()),
                    ("id".to_string(), id.clone()),
                ]),
            ),
            DbError::SpaceNotFound(id) => (
                "SPACE_NOT_FOUND",
                HashMap::from([("id".to_string(), id.clone())]),
            ),
            DbError::SpaceNameTaken(name) => (
                "SPACE_NAME_TAKEN",
                HashMap::from([("name".to_string(), name.clone())]),
            ),
            DbError::SpacePasswordRequired(id) => (
                "SPACE_PASSWORD_REQUIRED",
                HashMap::from([("id".to_string(), id.clone())]),
            ),
            DbError::SpaceWrongPassword(id) => (
                "SPACE_WRONG_PASSWORD",
                HashMap::from([("id".to_string(), id.clone())]),
            ),
            DbError::ProviderCredentialNotFound(id) => (
                "PROVIDER_CREDENTIAL_NOT_FOUND",
                HashMap::from([("id".to_string(), id.clone())]),
            ),
            DbError::AgentConfigNotFound(id) => (
                "AGENT_CONFIG_NOT_FOUND",
                HashMap::from([("id".to_string(), id.clone())]),
            ),
            DbError::CatalogFetchFailed => {
                ("CATALOG_FETCH_FAILED", HashMap::new())
            },
            DbError::InvalidInput(msg) => (
                "INVALID_INPUT",
                HashMap::from([("message".to_string(), msg.clone())]),
            ),
            // Per-entity image rejection: generic code is enough — the
            // frontend surfaces a translated "image is invalid or too
            // large" message. No structured args.
            DbError::InvalidImage => ("INVALID_IMAGE", HashMap::new()),
            // Infrastructure errors: opaque code, no structured args.
            DbError::Sqlite(_)
            | DbError::Io(_)
            | DbError::Migration(_)
            | DbError::Serde(_)
            | DbError::Internal(_) => ("INTERNAL_ERROR", HashMap::new()),
            // Logging subsystem (ADR-0014): distinct stable codes so the
            // frontend can show a targeted "logging setup failed" / "verbosity
            // change failed" message even though the raw error message is
            // dynamic and not worth interpolating. No `args` — everything
            // useful is in `message` as the English fallback.
            DbError::LoggingInit(_) => ("LOGGING_INIT_FAILED", HashMap::new()),
            DbError::LoggingReload(_) => {
                ("LOGGING_RELOAD_FAILED", HashMap::new())
            }
            // `set_log_level` validation failure: surface the rejected value
            // so the frontend can quote it back to the user.
            DbError::InvalidLogLevel(provided) => (
                "INVALID_LOG_LEVEL",
                HashMap::from([("provided".to_string(), provided.clone())]),
            ),
            // `export_logs` failure: dynamic IO/zip message — code is enough,
            // everything useful is in `message`.
            DbError::LogExportFailed(_) => ("LOG_EXPORT_FAILED", HashMap::new()),
            // `export_novel` failure: dynamic IO/epub message — code is enough,
            // everything useful is in `message`.
            DbError::NovelExportFailed(_) => ("NOVEL_EXPORT_FAILED", HashMap::new()),
        };
        ErrorPayload {
            code: code.to_string(),
            message: self.to_string(),
            args,
        }
    }
}

impl Serialize for DbError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        self.to_payload().serialize(serializer)
    }
}

#[cfg(test)]
mod space_error_tests {
    use super::*;

    #[test]
    fn space_not_found_payload() {
        let p = DbError::SpaceNotFound("abc".into()).to_payload();
        assert_eq!(p.code, "SPACE_NOT_FOUND");
        assert_eq!(p.args.get("id"), Some(&"abc".to_string()));
    }

    #[test]
    fn space_name_taken_payload() {
        let p = DbError::SpaceNameTaken("My Space".into()).to_payload();
        assert_eq!(p.code, "SPACE_NAME_TAKEN");
        assert_eq!(p.args.get("name"), Some(&"My Space".to_string()));
    }

    #[test]
    fn space_password_required_payload() {
        let p = DbError::SpacePasswordRequired("abc".into()).to_payload();
        assert_eq!(p.code, "SPACE_PASSWORD_REQUIRED");
        assert_eq!(p.args.get("id"), Some(&"abc".to_string()));
    }

    #[test]
    fn space_wrong_password_payload() {
        let p = DbError::SpaceWrongPassword("abc".into()).to_payload();
        assert_eq!(p.code, "SPACE_WRONG_PASSWORD");
        assert_eq!(p.args.get("id"), Some(&"abc".to_string()));
    }

    #[test]
    fn invalid_input_payload() {
        let p = DbError::InvalidInput("bad id".into()).to_payload();
        assert_eq!(p.code, "INVALID_INPUT");
        assert_eq!(p.args.get("message"), Some(&"bad id".to_string()));
    }

    /// Regression guard: existing variants must keep their stable codes.
    #[test]
    fn existing_codes_unchanged() {
        assert_eq!(
            DbError::WorldNotFound("w1".into()).to_payload().code,
            "WORLD_NOT_FOUND"
        );
        let p = DbError::NotFound("Character", "c1".into()).to_payload();
        assert_eq!(p.code, "NOT_FOUND");
        assert_eq!(p.args.get("entity"), Some(&"Character".to_string()));
        assert_eq!(p.args.get("id"), Some(&"c1".to_string()));
        assert_eq!(
            DbError::Internal("boom".into()).to_payload().code,
            "INTERNAL_ERROR"
        );
    }
}
