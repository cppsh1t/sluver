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

    /// `export_world` failed midway (wal checkpoint, file read, zip build).
    /// Dynamic message only; surfaces as `WORLD_EXPORT_FAILED`. The partial
    /// output file is removed by the command before returning this error.
    #[error("World export failed: {0}")]
    WorldExportFailed(String),

    /// `import_world` failed midway (file IO, base64 decode, registry write).
    /// Dynamic message only; surfaces as `WORLD_IMPORT_FAILED`. The command
    /// cleans up any partially-written `.db` on the new-import path.
    #[error("World import failed: {0}")]
    WorldImportFailed(String),

    /// Imported `.sluver-world` file is corrupt or unsupported (not a valid
    /// zip, missing `manifest.json`, unparseable manifest, unsupported
    /// `formatVersion`, missing `world.db`). Surfaces as
    /// `WORLD_IMPORT_CORRUPT_FILE` with `{ reason }` so the frontend can
    /// render a targeted "this file is not a valid world export" message.
    #[error("World import corrupt file: {0}")]
    WorldImportCorruptFile(String),

    /// Imported world's id already exists in the target Space and `overwrite`
    /// was `false`. Surfaces as `WORLD_IMPORT_ALREADY_EXISTS` with
    /// `{ entity, id, existing_name }` so the frontend can show a
    /// confirmation dialog and retry with `overwrite = true`.
    #[error("World import already exists: {id} ({existing_name})")]
    WorldImportAlreadyExists {
        id: String,
        existing_name: String,
    },

    /// `create_note` / `move_note` targeted a `parent_id` that exists but
    /// is not a folder (notes cannot nest under notes — ADR-0038 §1).
    /// Surfaces as `NOTE_PARENT_NOT_FOLDER` with `{ id }` (the parent id).
    #[error("Note parent is not a folder: {0}")]
    NoteParentNotFolder(String),

    /// `move_note` tried to move a note/folder under itself or one of its
    /// descendants — the ancestor-walk rejection (ADR-0038 §4; SQLite
    /// cannot express this constraint). Surfaces as `NOTE_MOVE_CYCLE`
    /// with `{ id }` (the moved id).
    #[error("Note move would create a cycle: {0}")]
    NoteMoveCycle(String),

    /// A write violated the sibling-title uniqueness rule (ADR-0038 §2):
    /// `create_note` (duplicate title under the parent), `update_note`
    /// (rename onto an existing sibling's title), or `move_note` (target
    /// folder already holds that title). Detected by mapping the raw
    /// `UNIQUE constraint failed: index 'idx_notes_sibling_title'` SQLite
    /// error. Surfaces as `NOTE_DUPLICATE_TITLE` with `{ title }`.
    #[error("Note title already taken by a sibling: {0}")]
    NoteDuplicateTitle(String),

    /// Skill row not found (enable/delete/read on a missing skill id).
    /// Surfaces as `SKILL_NOT_FOUND` with `{ entity, id }` (same shape as
    /// the generic `NotFound`; the dedicated code lets the frontend render
    /// a skill-specific message).
    #[error("Skill not found: {0}")]
    SkillNotFound(String),

    /// Uploaded skill package rejected — not a zip, oversized (package or
    /// single entry), too many entries, zip-slip entry name, missing/mis-
    /// placed SKILL.md, or invalid frontmatter (ADR-0043 §1 upload safety).
    /// Surfaces as `SKILL_PACKAGE_INVALID` with `{ reason }` so the frontend
    /// can render a targeted "this file is not a valid skill package"
    /// message.
    #[error("Invalid skill package: {0}")]
    SkillPackageInvalid(String),

    /// `read_skill_entry` targeted a skill whose installed directory is not
    /// on disk (`spaces/{id}/skills/{name}/SKILL.md` missing — never
    /// enabled, or the dir was removed). Surfaces as `SKILL_NOT_INSTALLED`
    /// with `{ name }`.
    #[error("Skill not installed: {0}")]
    SkillNotInstalled(String),

    /// Chat message attachment rejected — the decoded payload exceeds the
    /// kind-specific ceiling (image 5 MiB / text 1 MiB — ADR-0044 §D6).
    /// Surfaces as `ATTACHMENT_TOO_LARGE` with `{ kind, max }` so the
    /// frontend can render a translated "file is too large (max {{max}})"
    /// message; `max` is MiB-formatted for direct interpolation.
    #[error("Attachment too large: {kind} over {max_bytes} bytes")]
    AttachmentTooLarge { kind: String, max_bytes: usize },

    /// Chat message attachment MIME not in the kind-specific allowlist
    /// (image: webp/jpeg/png; text: plain/markdown/csv — ADR-0044 §D6).
    /// Surfaces as `ATTACHMENT_INVALID_MIME` with `{ mime }`.
    #[error("Attachment mime not allowed: {0}")]
    AttachmentInvalidMime(String),

    /// Chat message text attachment payload is not valid UTF-8 (text files
    /// are inlined into the model input as sentinel TextParts, so the bytes
    /// must decode — ADR-0044 §D4). Surfaces as `ATTACHMENT_INVALID_TEXT`
    /// with no args.
    #[error("Attachment text is not valid UTF-8")]
    AttachmentInvalidText,
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
            // `export_world` / `import_world` failures: dynamic IO/zip message —
            // code is enough, everything useful is in `message`.
            DbError::WorldExportFailed(_) => ("WORLD_EXPORT_FAILED", HashMap::new()),
            DbError::WorldImportFailed(_) => ("WORLD_IMPORT_FAILED", HashMap::new()),
            // Imported `.sluver-world` is corrupt: surface the reason so the
            // frontend can distinguish "not a zip" / "missing manifest" / etc.
            DbError::WorldImportCorruptFile(reason) => (
                "WORLD_IMPORT_CORRUPT_FILE",
                HashMap::from([("reason".to_string(), reason.clone())]),
            ),
            // Imported world id already exists (overwrite=false): surface the
            // existing name + id so the frontend can render a confirmation
            // dialog ("World 'X' already exists. Replace it?").
            DbError::WorldImportAlreadyExists { id, existing_name } => (
                "WORLD_IMPORT_ALREADY_EXISTS",
                HashMap::from([
                    ("entity".to_string(), "world".to_string()),
                    ("id".to_string(), id.clone()),
                    ("existing_name".to_string(), existing_name.clone()),
                ]),
            ),
            // Notes tree invariants (ADR-0038): the offending id is surfaced
            // for diagnostics; the translated messages don't interpolate it
            // (a UUID is not user-meaningful) — same shape as
            // SPACE_WRONG_PASSWORD carrying args the message doesn't use.
            DbError::NoteParentNotFolder(id) => (
                "NOTE_PARENT_NOT_FOLDER",
                HashMap::from([("id".to_string(), id.clone())]),
            ),
            DbError::NoteMoveCycle(id) => (
                "NOTE_MOVE_CYCLE",
                HashMap::from([("id".to_string(), id.clone())]),
            ),
            // Unlike the two above, the title IS user-meaningful — the
            // translated message interpolates it ({{title}}).
            DbError::NoteDuplicateTitle(title) => (
                "NOTE_DUPLICATE_TITLE",
                HashMap::from([("title".to_string(), title.clone())]),
            ),
            // Agent Skills (ADR-0043). SKILL_NOT_FOUND mirrors the generic
            // NotFound's {entity, id} shape; the other two interpolate their
            // single diagnostic arg ({{reason}} / {{name}}).
            DbError::SkillNotFound(id) => (
                "SKILL_NOT_FOUND",
                HashMap::from([
                    ("entity".to_string(), "skill".to_string()),
                    ("id".to_string(), id.clone()),
                ]),
            ),
            DbError::SkillPackageInvalid(reason) => (
                "SKILL_PACKAGE_INVALID",
                HashMap::from([("reason".to_string(), reason.clone())]),
            ),
            DbError::SkillNotInstalled(name) => (
                "SKILL_NOT_INSTALLED",
                HashMap::from([("name".to_string(), name.clone())]),
            ),
            // Chat attachments (ADR-0044). `max` is MiB-formatted so the
            // translated message can interpolate it directly ("max {{max}}");
            // `kind` rides along for diagnostics. The other two interpolate
            // their single user-meaningful arg / take none.
            DbError::AttachmentTooLarge { kind, max_bytes } => (
                "ATTACHMENT_TOO_LARGE",
                HashMap::from([
                    ("kind".to_string(), kind.clone()),
                    (
                        "max".to_string(),
                        format!("{} MiB", max_bytes / (1024 * 1024)),
                    ),
                ]),
            ),
            DbError::AttachmentInvalidMime(mime) => (
                "ATTACHMENT_INVALID_MIME",
                HashMap::from([("mime".to_string(), mime.clone())]),
            ),
            DbError::AttachmentInvalidText => {
                ("ATTACHMENT_INVALID_TEXT", HashMap::new())
            }
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
#[path = "tests/error.rs"]
mod space_error_tests;
