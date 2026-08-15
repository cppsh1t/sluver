# ADR-0036: Native notifications via notify-rust with explicit AUMID (no tauri-plugin-notification)

**Status**: accepted.

## Context

ADR-0025's tool-consent gate surfaces pending approvals via OS notifications so the user learns about them even when the Space window is minimized, unfocused, or showing a different conversation. The initial implementation used `tauri-plugin-notification` (JS `sendNotification` → IPC → plugin `builder().show()`).

On Windows 11 this never displayed a toast in dev builds. Diagnosis on a 25H2 machine (Build 26200):

1. The plugin's desktop `show()` sets the toast's `System.AppUserModel.ID` **only when the exe is NOT under `target/{debug,release}`** (its dev-detection heuristic). In dev it falls back to notify-rust's default — the **Windows PowerShell AUMID**.
2. Windows 11 24H2+ **silently drops toasts sent under the PowerShell AUMID** (anti-abuse measure — malware abused it for fake notifications). Verified empirically: PowerShell-AUMID toasts vanish (not even in the notification center) while toasts under the app's own identifier render fine.
3. The plugin swallows send failures at three layers (spawned task + `let _ =` + unit-return command), so the breakage is undiagnosable from logs.

## Decision

1. **Drop `tauri-plugin-notification`** (Rust plugin, JS package, and `notification:default` capability) — its dev-mode AUMID strategy is unfixable from our side and its silent failure mode is unacceptable.
2. **One command, `show_notification(title, body)`** in `commands/notification.rs`, sending via **`notify-rust` directly** (the same backend the plugin uses on desktop) with `.app_id()` **always set to the bundle identifier** from `tauri.conf.json`. Errors propagate as `DbError::Internal` — no silent swallowing.
3. **AUMID self-registration at startup** (Windows only, best-effort, idempotent — re-written every launch):
   - `SetCurrentProcessExplicitAppUserModelID` pins the process to the identifier.
   - `HKCU\Software\Classes\AppUserModelId\{id}` gets `DisplayName` + `IconUri` (exe path), so the notification platform renders toasts for this unpackaged app with proper branding even without an installer-created Start Menu shortcut. A repaired install that dropped the shortcut property self-heals on next launch.
4. Frontend `notify.ts` keeps its shape (no-throw, fire-and-forget, global `i18n.t`, snake_case log fields) and calls our command via the typed IPC layer; i18n strings and the store-layer hook in `createGate().request()` (ADR-0024 rationale) are unchanged.

## Consequences

- Dev builds on Windows 11 24H2+ display notifications (generic/registered branding instead of "Windows PowerShell").
- Installed builds keep working: NSIS/MSI registers the AUMID via Start Menu shortcut; our registry write is redundant but harmless and self-healing.
- `show_notification` is generic (title/body strings) — future non-consent notifications reuse it without new commands.
- We lose the plugin's permission API (`isPermissionGranted`/`requestPermission`) — a no-op on desktop anyway.
- macOS/Linux: notify-rust handles them (`app_id` ignored on Linux D-Bus); the app is Windows-first today, so this path is untested there.
