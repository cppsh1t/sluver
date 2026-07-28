# Novel workspace: non-deep-linkable Scenes + single-source auto-save

The Novel workspace (`/novels/$novelId`) makes two non-obvious decisions that future maintainers must understand before touching routing or save logic. (The broader three-column layout and "hide WorldSidebar inside the workspace" choices are visible in `_world.tsx` and need no ADR — they are what they look like.)

## Scenes are not deep-linkable

A URL can target a Novel or a Chapter, but **not an individual Scene**. Scenes render as editable cards inside the chapter view, not as routed destinations. Route granularity stops at Chapter.

This is intentional, not an oversight: a Scene is meaningless outside its Chapter context — it is always read and written alongside its siblings. Routing each Scene separately would force a page unmount/remount on every switch, losing scroll position and breaking writing flow. If deep-linking to a Scene ever becomes a real requirement, add it as `/chapters/$chapterId?scene=$sceneId` that scrolls to and focuses the card — **not** as a new route segment.

## Single-source-of-truth auto-save (avoids full-replacement race)

`update_scene` is a **full-replacement** mutation — it rewrites every field plus every junction ref (`character_refs`, `item_ids`, `event_ids`) on each call (see `commands/novel.rs`). A naive auto-save design — one debounced saver for content typing, one immediate saver for reference edits — would race: a reference commit could clobber unsaved content typing, or vice versa.

The fix: each Scene owns **one local mutable copy** in React state (initialized from `list_scenes`). **Every edit** — content typing, title inline-edit, time popover, summary edit, right-sidebar reference changes — mutates this single copy. A single 1.5-second debounced saver per Scene reads the local state and fires `update_scene`. One queue per Scene means concurrent saves are structurally impossible. Before navigation away (chapter switch, novel switch, unmount), pending saves are force-flushed to prevent data loss.

The per-Scene save-status indicator (`Saving… / Saved / Save failed`) is the only external surface of this machinery. Anyone tempted to add a second, "immediate" save path for some new field — don't. Route the new field through the same local copy and the same debounce queue.
