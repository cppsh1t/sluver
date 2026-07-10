use serde::Serialize;

/// Unified error type for all database operations.
///
/// Serialized as a plain string for Tauri command results — the frontend
/// receives the human-readable error message via `invoke` rejection.
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
}

impl Serialize for DbError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
