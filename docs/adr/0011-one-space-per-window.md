# One Space per OS window (multi-window architecture)

## Status

**Accepted** — supersedes [ADR-0009](./0009-workspace-shell-three-tier-and-titlebar-tabs.md) (browser-style title bar tabs) and [ADR-0010](./0010-tab-state-keepalive.md) (in-app DOM keep-alive).

## Context

ADR-0009 introduced browser-style Space tabs in a custom frameless title bar. ADR-0010 attempted to preserve tab state (component state, form drafts, scroll, future AI streams) across tab switches via an in-app DOM keep-alive mechanism using `cloneDeep(router)` + `<RouterContextProvider>`.

ADR-0010 was fundamentally broken: deep-cloning the TanStack Router instance produces a "Frankenstein" router — data fields are frozen snapshots while method references point to the live router's closures. This corrupts the router's internal `matchStores` Map pool and matchId resolution, causing `Invariant failed: Could not find match for matchId` crashes on navigation. The community library `tanstack-router-keepalive` has the same class of bug (Issues #1, #3, #5). Two community forks (suaveui, nuclear-xrd) have partial fixes by manually re-stitching `__store.state.matches` or restoring `options.context`, but these rely on private router internals that could break in any minor version.

Rather than continue fighting TanStack Router's singleton architecture, we eliminate the problem entirely: each Space gets its own native OS window with its own independent React tree.

## Decision

**One native OS window per Space.** No in-app tabs. No keep-alive.

- Each Space opens in its own `WebviewWindow` (`WebviewWindowBuilder`, stable Tauri v2 API — NOT the unstable multi-webview-per-window from ADR-0010 C3). Each window has its own React root, its own TanStack Router instance, its own component state. **State isolation is free** — the OS manages window lifecycle.

- The **launcher window** (`"main"`, defined in `tauri.conf.json`) is the app's anchor. It renders the landing page / Space picker. It hides to tray on close (keeping the process alive).

- **Startup**: reads `lastOpenedSpaceId` from session → auto-opens that Space's window. If none, stays on the launcher.

- **Tray icon**: dynamically lists all open Space windows as clickable menu items. Clicking focuses that window. Rebuilt on every window open/close/focus event via `tray.set_menu(Some(menu))`.

- **Session model** simplified to `lastOpenedSpaceId: Option<String>` + `lockedSpaceIds: Vec<String>`. Removes `openSpaceIds` (was the tab list) and `activeSpaceId` (OS window focus replaces it).

- **Window labels**: `space-{uuid}` for Space windows, `"main"` for the launcher. The label is the single-instance enforcement (`get_webview_window(label)` check before creating).

- **Space picker** (sidebar footer) calls `openSpace` (session/DB) then `openSpaceWindow` (creates/focuses OS window). No in-window navigation needed — the new window opens at URL `/space/{id}`.

- **Window close behavior**:
  - Launcher window → hide to tray (prevent close), lock all protected Spaces.
  - Space window → close normally (drop DB connections, refresh tray). `lastOpenedSpaceId` is NOT cleared (user's decision: close window ≠ close session).
  - Closing the **last** remaining Space window does NOT auto-show the launcher. The process stays dormant in the tray (launcher hidden, `lastOpenedSpaceId` preserved); the user returns via the tray menu's "Open Launcher" or by relaunching the app (which reopens `lastOpenedSpaceId`). An earlier implementation re-added `main.show()` on last-Space-close — that was a bug, since reverted.

- **Cross-window communication**: none. Each window queries the backend independently (decision 6B). SQLite consistency handles concurrent access. No Tauri event broadcasting for state sync between Space windows. The `spaces-locked` event (backend → all windows) is kept — it's a backend instruction, not window-to-window sync.

- **Custom title bar** kept (frameless + decorum overlay), but **tab area removed**. The title bar is now just a drag region with a "Sluver" label. Window controls (close/min/max) are injected by decorum's `create_overlay_titlebar()` on every window.

## Consequences

- **ADR-0009 (browser-style tabs) is superseded.** The TitleBar component, tab UI, tab switch/close logic — all deleted. The `AppSidebar` footer retains the Space picker (adapted for multi-window).

- **ADR-0010 (in-app DOM keep-alive) is superseded.** `KeepAliveProvider`, `KeepAliveOutlet`, `TabStateProvider`, the `cloneDeep(router)` approach, and the `lodash` dependency — all deleted. Each window's React tree lives independently; no cloning needed.

- **`set_active_space` command deleted.** OS window focus replaces it. `SessionState.activeSpaceId` removed.

- **`lock_all_protected_spaces` widened scope.** Pre-ADR-0011 it locked only the *open & protected* Spaces (`protected ∩ openSpaceIds`). Post-ADR-0011 it locks *every* protected Space in `meta.db` (`all_protected_ids`). Reasoning: with no `openSpaceIds` list to intersect against, and the "lock down everything before the process goes dormant" intent unchanged, the superset is the correct semantic. A user with N protected Spaces who has never opened most of them will see all N in `locked_space_ids` after the first hide-to-tray. On next launch, opening any of those Spaces via the picker follows the "unlock attempt" path (`was_locked == true`) instead of the "fresh-open" path — the end state is functionally equivalent (Space locked, gate shown).

- **Resource cost**: each `WebviewWindow` is a separate renderer process (~50–120 MB on Windows WebView2, ~30–80 MB on macOS WKWebView). For 3–5 open Spaces this is acceptable. No mitigation implemented; if needed, hide (don't destroy) idle Space windows.

- **Window title** is `Sluver — {SpaceName}`, managed by Rust at window creation time. The in-app title bar shows a generic "Sluver" label (not the Space name — the OS title bar already has it).

- **Per-pathname route state is naturally preserved** within each window. Switching OS windows (via tray or taskbar) does not unmount any React tree. AI streams (future) will survive window switches as long as the window stays open.

- **No `useSearch()` staleness issue** (ADR-0010 consequence). Each window has its own live router — no frozen context, no stale hooks.

## Implementation notes

- `WebviewUrl::App("/space/{id}")` sets the initial URL path; TanStack Router picks it up from `window.location.pathname` automatically. No window-label parsing needed in the frontend for routing.
- `tray::refresh(app)` is called after every window open/close. It enumerates `app.webview_windows()`, filters by `label.starts_with("space-")`, and rebuilds the tray menu.
- Old `SessionState` JSON (with `openSpaceIds`/`activeSpaceId`) is transparently migrated on read: `lastOpenedSpaceId = activeSpaceId.or_else(|| openSpaceIds.first().cloned())`.
- **Corollary — opening a Space from the frontend**: the ONLY correct way to present a Space to the user is the `useOpenSpaceInWindow` hook (composes `openSpace` + `openSpaceWindow`). Client-side `navigate({ to: '/space/$spaceId' })` MUST NOT be used to cross the Space boundary inside an existing window — a Tauri window's label is fixed at creation, so navigating the URL without creating a new window orphans the label from the tray menu and the single-instance check (`ensure_space_window`). `CreateSpaceDialog` once did this: creating a Space from within Space A's window navigated A's window to the new Space's content, but the window label stayed `space-{A}`, so the tray still listed A (focusing it re-pointed at the new Space's content) and the new Space never appeared in the tray. Fixed by routing both the picker and the create dialog through `useOpenSpaceInWindow`.
