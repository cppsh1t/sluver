# Workspace shell: separate layout routes, not a persistent global sidebar

**Status**: superseded by ADR-0009 (three-tier layout + Space tabs in the TitleBar).

When a user opens a World, the app switches from app-level navigation (Worlds / Library / Settings) to world-level navigation (Characters / Events / Locations / Items / Lore / Novels). We implement this as two sibling layout routes under the root, not as a single persistent sidebar that adapts by route.

## Context

Sluver is a novel-writing app. The primary activity inside a World is writing Scenes, which demands maximum horizontal editor width. A persistent global sidebar (240px) alongside a world entity sidebar (another ~240px) would consume ~480px before any content appears — untenable on laptop screens where the Scene editor needs every pixel.

## Decision

The root layout (`__root.tsx`) renders only `TitleBar + Toaster` — no sidebar. Two layout route children sit under it:

- **`appLayoutRoute`** — renders `AppSidebar` (Worlds / Library / Settings). Parents the index, settings, and library routes.
- **`worldLayoutRoute`** — renders a new `WorldSidebar`. Parents all `/world/$worldId/*` routes.

The global sidebar is unmounted while inside a World; a "← All Worlds" affordance in the `WorldSidebar` returns to app-level navigation.

The `WorldSidebar` uses **flat entity navigation grouped into two sections** — **Worldbook** (Characters, Events, Locations, Items, Lore) and **Writing** (Novels) — rather than a Scrivener-style deep tree. Chapter/scene trees live inside the Novel detail view, not the sidebar.

## Considered options

- **Keep the global sidebar, nest workspace inside `<main>`** — rejected: double-sidebar eats ~480px, death for a writing surface.
- **One sidebar component that swaps nav content by route** — rejected: conditional rendering inside the sidebar component is less clean than two purpose-built components; harder to reason about.
- **Collapsible global sidebar that auto-collapses to icon-only in a World** — rejected: most complex to build, still wastes ~48px of icon rail, and the contextual swap is hidden from the user.

## Consequences

- Settings is not instantly accessible from inside a World (requires "back to Worlds" → Settings). Accepted: Settings are rarely adjusted once configured; a future command palette can bridge this.
- Two sidebar components to maintain (`AppSidebar`, `WorldSidebar`) — but each is simple and purpose-built, less complex than one conditional component.
