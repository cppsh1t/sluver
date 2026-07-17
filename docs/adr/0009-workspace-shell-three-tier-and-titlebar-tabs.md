# Workspace shell: three-tier layout + Space tabs in the TitleBar

**Status**: accepted — supersedes ADR-0005.

ADR-0005 chose two layout routes (app-level vs world-level) with no persistent global sidebar, to avoid a double sidebar eating the Scene editor's horizontal width. Introducing the Space layer (see `CONTEXT.md`, ADR-0007) changes two things, and both *reinforce* ADR-0005's core rationale rather than overturn it:

1. **Space switching lives in the persistent `TitleBar`, not in a sidebar.** The `TitleBar` is already rendered in every layout (it sits in `__root.tsx`), so browser-style Space tabs there are visible even mid-Scene-writing. Switching Spaces costs vertical titlebar pixels, not horizontal editor pixels — exactly the trade-off ADR-0005 preferred. The `TitleBar` grows from an empty drag strip into real chrome: `[Space tabs…] [+]` between the macOS traffic lights (top-left) and the Windows caption buttons (top-right, injected by `decorum`). `data-tauri-drag-region` stays on the bar; interactive tab/button children opt out.

2. **The layout grows from two tiers to three** — one per level of the domain hierarchy (Space → World → writing):
   - **Landing** (no Space tab open): minimal — brand + the Space picker. Shown on first run and whenever the user closes every tab.
   - **Space-home** (a Space tab is open, no World selected): the `AppSidebar` is repurposed as a *context-sensitive* sidebar showing the active Space's Worlds (there is no longer a global "Worlds" page — Worlds are per-Space). Its bottom hosts the Space picker (`select`, pops upward) and the Setting entry (moved out of the nav).
   - **World-inside** (inside a World): unchanged `WorldSidebar` with entity navigation. The original "← back" affordance returns to Space-home.

ADR-0005's rejected alternatives (double sidebar, single conditional sidebar, collapsible icon rail) stay rejected for the same reasons. The new decision simply relocates Space-switching to the TitleBar and inserts the Space-home tier. Consequences: three sidebar-bearing layouts to maintain instead of two; `AppSidebar` is no longer app-global but fills with the active Space's content (its `Worlds`/`Library`/`Settings` nav items are reshaped — `Worlds` becomes the active Space's world list, `Settings` drops to the bottom area). `Library` remains a placeholder (`routes/library.tsx`); its scope (global vs per-Space) is deferred until it is actually built.
