# Scenes reference Lore via `scene_lore_refs`; Events still don't

Scenes can now reference Lore entries through a `scene_lore_refs` junction table (`WORLD_MIGRATION_012`), mirroring `scene_item_refs` / `scene_event_refs` exactly: composite PK (set semantics), `lore_ids` threaded through `Scene` / `CreateSceneInput` / `UpdateSceneInput` / `SceneOverview`, delete-all + re-insert inside the update transaction, and a `LoreMultiPicker` UI cloned from the items picker.

This reverses half of Lore's original positioning. CONTEXT.md defined Lore as "standalone by design: never participates in Events or Scenes." In practice that made Lore the only worldbook entity with **zero reference surfaces** — an author could record a magic system or a political structure, but nothing in the novel could point back at it. Characters, Items, and Events are all reachable from Scene prose; Lore was dangling, and the entry was effectively write-only documentation. Scenes reference Lore as **background context**: the scene where a ritual is performed or a succession law bites should be linkable to the Lore entries that explain it, so both the author and the agent can traverse prose ↔ worldbook in both directions.

The other half of the original stance deliberately survives: **Events still do not reference Lore.** Events are records of story *action* — who participated (CharacterRefs), where (location), narrated by which Scenes. Lore never acts; an organization that "does" something is modeled as individual Characters plus a Lore entry describing the org (unchanged CONTEXT.md rule), and purely mythological deities stay in Lore precisely because they never participate. `timeline_lookup` accordingly surfaces characters and events on timeline nodes but not items or lore — that is intentional, not an omission.

Deletion follows the item/event precedent, not the ADR-0006 one: `scene_lore_refs` cascades on both FKs, `delete_lore` stays a plain `DELETE`, and there is **no pre-delete disclosure** — the same silent cascade items and events already have. (ADR-0006's disclosure exists because CharacterRef is identity-bearing: losing a ref silently falsifies who appeared. A lore/item/event ref is optional annotation; its removal degrades gracefully.) If disclosure is ever deemed worth having, it should be added for all three annotation ref types together.

Rejected alternatives:
- **Keep Lore fully standalone**: leaves the entity write-only and untraversable — the dangling state this ADR exists to fix.
- **Also add `event_lore_refs`**: symmetric but semantically wrong — Events record action, and Lore is not an actor; the org-as-Characters rule already covers everything that would "participate."
- **Lore as scalar column on Scene (like `location_id`)**: Scenes routinely draw on several lore entries at once; a single slot would force artificial choices.

Implementation note: the junction rides World export/import automatically (`export_world` zips the whole checkpointed `world.db`; the migration creates the table on import-open). Agent tools (`create_scene`, `update_scene`, `get_chapter_overview`) accept and report `loreIds`; `grep` / `search_*` / timeline surfaces are unchanged.
