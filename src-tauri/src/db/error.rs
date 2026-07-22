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

    /// AI agent row not found (update on a missing agent id).
    /// Surfaces as `AGENT_NOT_FOUND` with `{ id }`.
    #[error("Agent not found: {0}")]
    AgentNotFound(String),

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
            DbError::AgentNotFound(id) => (
                "AGENT_NOT_FOUND",
                HashMap::from([("id".to_string(), id.clone())]),
            ),
            DbError::CatalogFetchFailed => {
                ("CATALOG_FETCH_FAILED", HashMap::new())
            },
            DbError::InvalidInput(msg) => (
                "INVALID_INPUT",
                HashMap::from([("message".to_string(), msg.clone())]),
            ),
            // Infrastructure errors: opaque code, no structured args.
            DbError::Sqlite(_)
            | DbError::Io(_)
            | DbError::Migration(_)
            | DbError::Serde(_)
            | DbError::Internal(_) => ("INTERNAL_ERROR", HashMap::new()),
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
