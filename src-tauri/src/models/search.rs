use serde::Serialize;

/// One page of `search_*` results (`commands/world_search.rs`) — the
/// entity-centric counterpart to `GrepResult`, carrying the pagination
/// contract first established by `commands/grep.rs` (ADR-0035 precedent):
/// a fixed-size page walked via the `offset` argument under an unchanged
/// deterministic ORDER BY, plus the full match count so the caller can
/// detect truncation instead of silently losing rows.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage<T> {
    /// The requested page: up to `DEFAULT_LIMIT` (50) rows starting at the
    /// applied `offset`, in the command's unchanged ORDER BY.
    pub results: Vec<T>,
    /// Full `COUNT(*)` of matching rows BEFORE pagination.
    pub total_count: i64,
    /// `(offset + page_len) < total_count` — more rows remain behind
    /// `offset + page_len`; re-query with that offset to walk them.
    pub truncated: bool,
}

impl<T> SearchPage<T> {
    /// Assemble a page from already-fetched rows. `offset` must be the
    /// offset ACTUALLY APPLIED (non-negative — clamped before the SELECT),
    /// so `truncated` derives exactly like `commands/grep.rs::paginate`
    /// computes `has_more`. An offset past the end yields an empty page
    /// with `truncated = false`.
    pub fn new(results: Vec<T>, total_count: i64, offset: i64) -> Self {
        let truncated = offset + (results.len() as i64) < total_count;
        Self {
            results,
            total_count,
            truncated,
        }
    }
}
