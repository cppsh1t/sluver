# Workspace shell: three-tier layout + Space tabs in the TitleBar

**Status**: accepted — supersedes ADR-0005.

> ## Amendment (2026-07-20)
>
> Three points of this ADR were revised after the Space layer shipped and
> real usage surfaced two problems:
>
> 1. **Space switching is now available in BOTH the TitleBar AND the sidebar
>    footer.** The original "not in a sidebar" restriction is dropped: the
>    sidebar-footer `SpacePicker` is an intentional second affordance, kept
>    because users expect a bottom-of-sidebar switcher and because it shows
>    the *active* Space at a glance (the TitleBar tabs show *open* Spaces
>    but no obvious "current" marker beyond selection). Both controls drive
>    the same `setActiveSpace` / `openSpace` mutations and navigate to
>    `/space/$spaceId` on success.
> 2. **The space-tier sidebar is now a three-item nav: 世界 / 配置 / 资料库.**
>    The previous design filled the sidebar with the active Space's Worlds
>    list + a "Manage Space" dropdown. That conflated navigation with
>    management. Now the sidebar is pure navigation; the Worlds list lives
>    in the 世界 page content (`/space/$spaceId`), and Space management
>    (rename / password / delete) moved into a dedicated 配置 page
>    (`/space/$spaceId/config`).
> 3. **Library is per-Space.** The deferred "global vs per-Space" question
>    is resolved: 资料库 is a Space-tier destination (`/space/$spaceId/library`,
>    sibling of 世界 and 配置), not a landing-tier global page. The landing
>    `/library` route is removed.
>
> The corrected clauses below are marked `[amended]`. The original rationale
> (avoid double sidebars, keep the Scene editor wide) stands unchanged.

ADR-0005 chose two layout routes (app-level vs world-level) with no persistent global sidebar, to avoid a double sidebar eating the Scene editor's horizontal width. Introducing the Space layer (see `CONTEXT.md`, ADR-0007) changes two things, and both *reinforce* ADR-0005's core rationale rather than overturn it:

1. **Space switching lives in the persistent `TitleBar` [amended: and in the sidebar footer].** The `TitleBar` is already rendered in every layout (it sits in `__root.tsx`), so browser-style Space tabs there are visible even mid-Scene-writing. Switching Spaces costs vertical titlebar pixels, not horizontal editor pixels — exactly the trade-off ADR-0005 preferred. The `TitleBar` grows from an empty drag strip into real chrome: `[Space tabs…] [+]` between the macOS traffic lights (top-left) and the Windows caption buttons (top-right, injected by `decorum`). `data-tauri-drag-region` stays on the bar; interactive tab/button children opt out. *[amended]* The sidebar-footer `SpacePicker` is a second, intentional switcher (see amendment #1) — both drive the same session mutations and navigate to `/space/$spaceId`.

2. **The layout grows from two tiers to three** — one per level of the domain hierarchy (Space → World → writing):
   - **Landing** (no Space tab open): minimal — brand + the Space picker + global Settings. Shown on first run and whenever the user closes every tab.
   - **Space-tier** (a Space tab is open, no World selected): the `AppSidebar` is a **three-item nav — 世界 / 配置 / 资料库** *[amended]*. 世界 (`/space/$spaceId`) shows the active Space's Worlds grid in the page content; 配置 (`/space/$spaceId/config`) hosts Space management (rename / password / delete); 资料库 (`/space/$spaceId/library`) is the per-Space library. The sidebar footer hosts the Space picker and the global Settings entry.
   - **World-inside** (inside a World): unchanged `WorldSidebar` with entity navigation. The original "← back" affordance returns to Space-tier (世界).

ADR-0005's rejected alternatives (double sidebar, single conditional sidebar, collapsible icon rail) stay rejected for the same reasons. The new decision simply relocates Space-switching to the TitleBar (and, amended, mirrors it in the sidebar footer) and inserts the Space-home tier. Consequences: three sidebar-bearing layouts to maintain instead of two; `AppSidebar` is no longer app-global but, in space-tier, renders the three-item Space nav (世界/配置/资料库); `Settings` drops to the bottom area as a global-entry link. `Library` is per-Space *[amended: resolved]* — `routes/space.$spaceId/library.tsx` is a placeholder until its content surface is built.
