use std::sync::OnceLock;

// ─── System fonts (fontdb enumeration) ──────────────────────────────────────

/// Process-wide cache of enumerated system font family names.
///
/// Scanning + parsing every installed font can take hundreds of milliseconds
/// (fontdb cold-cache figures), so the result is computed once on a blocking
/// thread and reused for the lifetime of the process. Installed fonts don't
/// change while the app runs (a font install while running is vanishingly
/// rare and self-corrects on next launch).
static SYSTEM_FONTS: OnceLock<Vec<String>> = OnceLock::new();

/// Enumerate installed system font family names.
///
/// Returns a deduplicated list sorted ascending, case-insensitively. Each
/// face may carry multiple localized family names (English US first, then
/// translations) — all of them are collected so a user can find e.g. both
/// "SimSun" and "宋体". Families whose name starts with `@` are Windows
/// vertical-writing variants and are filtered out.
///
/// Infallible: an empty `Vec` is a legitimate outcome (no fonts found, or the
/// blocking task failed — the latter is logged at WARN). Never logs font
/// names themselves; only the family count at DEBUG (ADR-0016 metadata-only
/// policy).
#[tracing::instrument]
#[tauri::command]
pub async fn list_system_fonts() -> Vec<String> {
    if let Some(fonts) = SYSTEM_FONTS.get() {
        return fonts.clone();
    }

    // Font scanning is blocking file I/O + parsing — keep it off the async
    // runtime's worker threads.
    match tauri::async_runtime::spawn_blocking(enumerate_system_fonts).await {
        Ok(fonts) => SYSTEM_FONTS.get_or_init(|| fonts).clone(),
        Err(e) => {
            tracing::warn!(error = %e, "system font enumeration task failed");
            Vec::new()
        }
    }
}

/// Scan system fonts via `fontdb` and return deduplicated, case-insensitively
/// sorted family names.
fn enumerate_system_fonts() -> Vec<String> {
    let mut db = fontdb::Database::new();
    // Infallible: malformed fonts are skipped internally.
    db.load_system_fonts();

    let mut families: Vec<String> = db
        .faces()
        .flat_map(|face| face.families.iter().map(|(name, _)| name.clone()))
        .filter(|name| !name.is_empty() && !name.starts_with('@'))
        .collect();

    // Sort and dedup share the same Unicode-aware caseless key so non-ASCII
    // case variants (e.g. "Ü" vs "ü") collapse to one entry.
    families.sort_by_cached_key(|name| name.to_lowercase());
    families.dedup_by(|a, b| a.to_lowercase() == b.to_lowercase());

    tracing::debug!(count = families.len(), "system fonts enumerated");
    families
}
