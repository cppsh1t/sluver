use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Payload for the `entity-changed` Tauri event.
///
/// Emitted after every successful entity write (create / update / delete /
/// reorder / image-update / image-clear) so the frontend can invalidate the
/// relevant React Query caches. The frontend listens in `__root.tsx`.
///
/// Serialized as camelCase via serde to match the TS interface:
/// ```ts
/// interface EntityChangedPayload {
///   kind: string;       // "world"|"character"|"phase"|"location"|"item"|"lore"|"event"|"novel"|"chapter"|"scene"
///   id?: string;        // entity id; omitted for bulk ops (reorder)
///   spaceId: string;    // always present
///   worldId?: string;   // omitted for Space-scoped entities (World itself)
/// }
/// ```
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityChangedPayload {
    /// Entity kind — one of: "world", "character", "phase", "location",
    /// "item", "lore", "event", "novel", "chapter", "scene".
    pub kind: &'static str,
    /// Entity id. `None` for bulk operations (reorder) where many rows change;
    /// the frontend then does a coarse prefix invalidation of the list cache.
    pub id: Option<String>,
    /// Space id — always present (every write originates from a Space context).
    pub space_id: String,
    /// World id — `None` for Space-scoped entities (World itself lives in
    /// `space.db`, not a world db).
    pub world_id: Option<String>,
}

/// Emit an `entity-changed` event to all windows.
///
/// Call this **after** the DB write has succeeded (only on the `Ok` path).
/// Errors are swallowed via `let _ =` — cache invalidation is best-effort
/// and must never mask a successful write or turn a success into an error.
///
/// The `kind` must be a `&'static str` literal (e.g. `"location"`, `"phase"`)
/// so it is borrowed for the lifetime of the payload without allocation.
pub fn emit_entity_changed(
    app: &AppHandle,
    kind: &'static str,
    id: Option<String>,
    space_id: &str,
    world_id: Option<&str>,
) {
    let _ = app.emit(
        "entity-changed",
        EntityChangedPayload {
            kind,
            id,
            space_id: space_id.to_string(),
            world_id: world_id.map(|w| w.to_string()),
        },
    );
}
