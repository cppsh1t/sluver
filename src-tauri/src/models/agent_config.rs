use serde::{Deserialize, Serialize};

/// An AI agent config stored in `space.db` (ADR-0012). Each Space is seeded
/// with exactly two agent configs on creation — `explorer` and `writer`
/// (see `commands::space::do_create_space`). These configs cannot be created
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
    /// Context-compaction policy for this role (ADR-0031 Phase 1). Stored as
    /// two scalar columns on `agent_configs` (`context_compaction_enabled` +
    /// `context_compaction_turn_age`); defaults to disabled (`enabled = false`,
    /// `turn_age = 3`) on seed and on migration of pre-existing rows.
    pub context_compaction: ContextCompaction,
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
