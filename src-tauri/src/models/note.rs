use serde::{Deserialize, Serialize};

/// The `notes` table's kind discriminator (ADR-0038 §1). Serialized as the
/// lowercase TEXT values matching the SQL CHECK constraint (`'folder'` /
/// `'note'`); row helpers in `commands/note.rs` map to/from the column
/// manually via [`NoteKind::as_db_str`] / [`NoteKind::from_db_str`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteKind {
    Folder,
    Note,
}

impl NoteKind {
    /// The TEXT stored in the `kind` column.
    pub fn as_db_str(self) -> &'static str {
        match self {
            NoteKind::Folder => "folder",
            NoteKind::Note => "note",
        }
    }

    /// Parse the `kind` column's TEXT. The CHECK constraint makes `None`
    /// unreachable for rows written through normal paths; callers map it
    /// to a descriptive corruption error.
    pub fn from_db_str(raw: &str) -> Option<Self> {
        match raw {
            "folder" => Some(NoteKind::Folder),
            "note" => Some(NoteKind::Note),
            _ => None,
        }
    }
}

/// Note — one node of the arbitrary-depth Folder/Note tree (ADR-0038), the
/// codebase's first self-referential adjacency list (`parent_id` → notes.id;
/// NULL = root). Folders are pure structural containers: `content` is always
/// `''` (forced on create / update).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: NoteKind,
    pub title: String,
    pub content: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Lightweight note view returned by `list_notes` — a `Note` minus
/// `content`. Tree queries must not haul note bodies; the client builds
/// the tree from this flat list (one SELECT, no N+1 — ADR-0038 §1).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: NoteKind,
    pub title: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateNoteInput {
    /// Must reference an existing FOLDER row (pre-checked → business
    /// `NotFound` / `NoteParentNotFolder`). `None` = root scope.
    pub parent_id: Option<String>,
    pub kind: NoteKind,
    pub title: String,
    /// Ignored (forced to `''`) when `kind == Folder`.
    #[serde(default)]
    pub content: String,
}

/// Full-replacement update of title + content ONLY — never parent /
/// position (the agent contract, ADR-0038 §6: structural moves stay
/// UI-only in v1 via `move_note` / `reorder_notes`). Folder rows force
/// `content` back to `''` server-side.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateNoteInput {
    pub title: String,
    pub content: String,
}

// ─── grep_notes (match-centric search — ADR-0035 semantics applied to the
// notes corpus per ADR-0037's amendment; mirrors models/grep.rs naming) ────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepNotesInput {
    pub query: String,
    #[serde(default)]
    pub offset: i64,
}

/// Top-level response of `grep_notes` — mirrors `GrepResult` minus the
/// echoed query. IPC payload only; never logged (ADR-0016).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepNotesResponse {
    /// Match groups, sorted by `match_count` desc (ties → `title` asc,
    /// then `note_id` asc), capped at 50 entries.
    pub groups: Vec<NoteMatchGroup>,
    /// Full group count BEFORE the 50-group cap was applied.
    pub group_count: i64,
    /// `true` when more groups exist beyond the returned page — re-query
    /// with a larger `offset`.
    pub truncated: bool,
}

/// One match group: every occurrence of the query within ONE field of ONE
/// note/folder row, collapsed to a count plus up to 3 snippets — mirrors
/// `GrepMatchGroup` with notes-specific identity (`kind`, `title`,
/// `path`) in place of entity_type / entity_title / character owner.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMatchGroup {
    /// The matched row's id — directly usable by `get_note`.
    pub note_id: String,
    pub kind: NoteKind,
    pub title: String,
    /// Ancestor titles joined with `/`, root-to-parent, EXCLUDING the row
    /// itself — note titles repeat across the tree and tree position is
    /// semantic (ADR-0038 §6). `""` for root-level rows.
    pub path: String,
    /// The field the matches live in (`"title"` or `"content"`).
    pub field_name: String,
    /// Total non-overlapping occurrences — uncapped; preserves the
    /// "mentioned 50 times" signal beyond the snippet sample.
    pub match_count: i64,
    /// The first 3 occurrences as context snippets.
    pub snippets: Vec<NoteSnippet>,
}

/// Three-part context snippet around one occurrence — identical shape to
/// `GrepSnippet` (up to 40 chars per side, UTF-8-boundary-safe truncation,
/// no `...`/`【】` marker glyphs). `match` is a Rust keyword, hence the raw
/// identifier — serde still emits the field as `"match"` (solution copied
/// from `GrepSnippet`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSnippet {
    /// Up to 40 chars immediately before the match (`""` when none).
    pub before: String,
    /// The matched text, original case.
    pub r#match: String,
    /// Up to 40 chars immediately after the match (`""` when none).
    pub after: String,
}
