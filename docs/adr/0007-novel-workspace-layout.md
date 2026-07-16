# Novel workspace: chapter-centric layout route with dual-mode center

Novels get a fundamentally different UI paradigm from Worldbook entities. Instead of the archive-style detail page used by Characters and Events (single centered column, vertical scroll), a Novel opens into a persistent three-column **writing workspace**: a chapter sidebar (left), a content area (center), and an entity-reference sidebar (right). The global `WorldSidebar` is hidden while inside this workspace, giving the writing surface maximum horizontal space.

## Context

A Novel is a three-level hierarchy (Novel → Chapter → Scene). The Scene is the application's core value — the prose writing surface where authors spend the most time. This makes the Novel workspace unlike any previous entity view:

1. **Persistent navigation is essential.** An author writes across many Scenes within a Chapter, and navigates between Chapters frequently. Losing the tree on every navigation (as a separate-scene-route would) breaks writing flow.
2. **Horizontal space is precious.** ADR-0005 already established that the writing surface needs maximum width. A four-column layout (WorldSidebar + ChapterSidebar + Center + RightSidebar) would compress the editor to ~760px on a 1440px screen — untenable.
3. **Full-replacement updates make auto-save non-trivial.** `update_scene` rewrites all fields on every call (including all junction refs). Concurrent saves from different sources (content typing vs. reference editing) can clobber each other. This requires a disciplined single-source-of-truth auto-save strategy.

## Decision

### Layout route, not separate scene routes

`/novels/$novelId` is a **layout route** that renders the persistent chapter sidebar and an `<Outlet>`. The chapter is the navigation unit — selecting a chapter navigates to `/novels/$novelId/chapters/$chapterId`, which renders the center + right sidebar in the outlet. **Scenes are not individually routed.** They exist as editable cards within the chapter view.

This was chosen over two rejected alternatives:

- **Separate scene route** (`/novels/$novelId/scenes/$sceneId`) — rejected: every scene switch is a route transition (page unmount/remount), making the tree flicker and losing scroll position. Death for writing flow.
- **Single-route workspace with internal state** (`/novels/$novelId` + `?scene=` search param) — rejected: reimplements routing by hand, fights TanStack Router's model, and gains negligible performance over a layout route whose parent (chapter tree) is stable data.

### Chapter is the work unit

The center area shows **all Scenes of the selected Chapter simultaneously**, not one scene at a time. In **edit mode**, each Scene is an inline-editable card (title + time range + collapsible summary + editable content textarea). In **reading mode**, all Scenes' `content` is concatenated into one continuous prose flow (no titles, no summaries — pure narrative text). The mode toggle is a segmented control in the chapter sidebar and persists across chapter switches.

The right sidebar shows entity references as **rich cards** (not tags/chips): in edit mode it tracks the **active Scene** (the one whose content textarea last received focus); in reading mode it shows the **chapter aggregate** (union of all Scenes' refs, deduplicated). The right sidebar and chapter sidebar are both collapsible.

### Hide WorldSidebar inside the workspace

The `worldLayoutRoute` (`_world.tsx`) conditionally skips rendering the `WorldSidebar` for routes under `/novels/$novelId/*`. The chapter sidebar provides a "← Novels" back button for returning to world-level navigation. This yields a three-column workspace (~200px + flexible center + ~280px) instead of four columns, and the collapsible sidebars let the author maximize the writing surface for focused work.

### Single-source-of-truth auto-save

Each Scene has a local mutable copy in React state (initialized from the `list_scenes` query). **All edits** — content typing, title inline-edit, time popover, summary edit, right-sidebar reference changes — mutate this local copy. A single 1.5-second debounced saver per Scene reads the local state and fires a full `update_scene`. No concurrent saves are possible (one save queue per Scene). Before navigating away (chapter switch, novel switch, unmount), pending saves are force-flushed to prevent data loss. A save-status indicator (`Saving…` / `Saved` / `Save failed`) is shown per Scene card.

This eliminates the race condition that would arise from separate save paths for content (debounced) and references (immediate): both flow through the same local state and the same debounce queue, so a reference edit can never clobber unsaved content or vice versa.

## Consequences

- **Novel navigation differs from all other entities.** Worldbook entities use archive-style detail pages; Novels use an immersive workspace. This is intentional — writing is a different activity from cataloging. Future features (e.g., a timeline view) may need their own paradigm decisions.
- **Scenes are not deep-linkable.** A URL can point to a Novel or a Chapter, but not to an individual Scene. This is accepted because Scenes are meaningless in isolation — they're always read/written in chapter context. If deep-linking to a Scene becomes necessary later, it can be added as a `/chapters/$chapterId?scene=$sceneId` search param that scrolls to + focuses the card.
- **Conditional WorldSidebar rendering** adds a small amount of route-checking logic to `_world.tsx`. This is a localized `if` on the route path, not a route-tree restructure.
- **Auto-save requires discipline.** The optimistic local state must stay in sync with the query cache; navigation must flush pending saves; the save queue must serialize. This complexity is the cost of full-replacement updates + auto-save — the alternative (manual save) is worse for a writing app.
