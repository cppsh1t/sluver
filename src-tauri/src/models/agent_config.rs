use serde::{Deserialize, Serialize};

/// An AI agent config stored in `space.db` (ADR-0012). Each Space is seeded
/// with exactly four agent configs on creation — `explorer`, `writer`,
/// `namer`, and `vision` (see `commands::space::do_create_space`;
/// pre-existing Spaces get `namer` via SPACE_MIGRATION_007 and `vision` via
/// SPACE_MIGRATION_010). `namer` (conversation auto-titling) and `vision`
/// (backs the `look_at` tool — one-shot image description for non-vision
/// chat models) are non-conversational roles alongside the two
/// conversational ones. These configs cannot be created
/// or deleted by the frontend; only their `model_id` selection is mutable.
///
/// `model_id` is a composite `"{provider_id}/{model_id}"` (e.g.
/// `"anthropic/claude-sonnet-5"`) aligned with models.dev, or `None` when
/// the user hasn't picked a model yet. Deleting a provider credential
/// cascades a NULL-out of any agent config whose `model_id` is rooted at
/// that provider (see `commands::ai::do_delete_provider_credential`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub model_id: Option<String>,
    /// Whether the agent may execute "dangerous" tools without user approval.
    /// Stored as INTEGER (0/1) in SQLite; defaults to false (off) on seed and
    /// on migration of pre-existing rows.
    pub auto_execute_dangerous_tools: bool,
    /// Whether the shell execution tool (`shell_exec` / `shell_kill`,
    /// ADR-0041) is registered for this role (ADR-0042). When true the tool
    /// auto-executes without consent prompts; when false the tool is not
    /// registered at all. Stored as INTEGER (0/1) in SQLite; defaults to
    /// false (off) on seed and on migration of pre-existing rows.
    pub shell_tool_enabled: bool,
    /// Context-compaction policy for this role (ADR-0031 Phase 1). Stored as
    /// two scalar columns on `agent_configs` (`context_compaction_enabled` +
    /// `context_compaction_turn_age`); defaults to disabled (`enabled = false`,
    /// `turn_age = 3`) on seed and on migration of pre-existing rows.
    pub context_compaction: ContextCompaction,
    /// Per-role context note: a user-authored guideline inserted at the END
    /// of the role prompt's `<context>` block by the frontend
    /// (`injectContextNote` in `src/lib/ai-roles/index.ts`). Empty string =
    /// no note (the code-defined prompt is used verbatim). Unlike the
    /// removed `system_prompt` override, the note can never rewrite the
    /// operational sections of the structured prompt. Defaults to empty on
    /// seed and on migration of pre-existing rows (SPACE_MIGRATION_013).
    pub context_note: String,
    /// User-editable per-role loop step budget. `None` (NULL, the default
    /// on seed and on migration of pre-existing rows) = use the frontend
    /// `ROLE_REGISTRY` default (30 for loop roles); a value overrides it
    /// for this Space. One-shot roles (`namer`, `vision`) never read it.
    pub max_steps: Option<i64>,
    /// Per-role model generation settings (ADR-0056). Stored as a single
    /// JSON-blob TEXT column (`model_settings`, SPACE_MIGRATION_015) —
    /// NULL (the default on seed and on migration of pre-existing rows)
    /// and corrupt JSON both map to `ModelSettings::default()` at read
    /// time (every field `None` = provider default), so the field is
    /// NON-Option. Updated only via the whole-blob
    /// `update_agent_config_model_settings` command.
    pub model_settings: ModelSettings,
    pub created_at: String,
    pub updated_at: String,
}

/// Per-role context-compaction policy (ADR-0031 Phase 1 §1).
///
/// - `enabled = false` (default): the compactor is a no-op for this role.
///   Opt-in is intentional — compaction trades prompt-cache hits for token
///   savings, which is a net win for long Writer conversations but a net loss
///   for short Explorer ones; per-role config is the escape hatch.
/// - `turn_age` (default 3): a tool-call + tool-result pair is replaced with
///   a short text stub when its enclosing user-turn is older than N turns
///   (0 = current turn). The user-turn boundary is the safe cut point
///   (see ADR-0031 §2).
///
/// Stored in SQLite as two scalar columns; `turn_age` mirrors
/// `auto_execute_dangerous_tools`'s INTEGER convention.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextCompaction {
    pub enabled: bool,
    pub turn_age: i64,
}

/// Per-role model generation settings (ADR-0056). One nullable-JSON-blob
/// column on `agent_configs`; per-field `None` = provider default, so a
/// fresh config serializes every key as `null` and the frontend always
/// sees the full object shape (no partial payloads). Validation happens
/// app-layer in `do_update_agent_config_model_settings` — SQLite holds
/// whatever JSON round-trips, range/enum checks would not survive the
/// IPC boundary otherwise.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettings {
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub top_p: Option<f64>,
    #[serde(default)]
    pub top_k: Option<i64>,
    #[serde(default)]
    pub max_output_tokens: Option<i64>,
    /// Portable reasoning-effort level ("none" | "minimal" | "low" |
    /// "medium" | "high" | "xhigh"); providers map it to their native
    /// knob or drop it.
    #[serde(default)]
    pub reasoning: Option<String>,
    /// MUST stay `serde_json::Value` (BTreeMap → deterministic sorted key
    /// order). A HashMap would randomize key order across IPC calls and
    /// destabilize the frontend configSignature (ADR-0023 rebuilds).
    #[serde(default)]
    pub provider_options: Option<serde_json::Value>,
}
