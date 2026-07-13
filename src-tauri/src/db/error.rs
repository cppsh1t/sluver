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
