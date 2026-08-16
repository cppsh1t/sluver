# AGENTS.md — sluver

Tauri v2 desktop app for **worldbuilding & novel writing**. React 19 + TypeScript frontend, Rust backend backed by SQLite. Package manager: **pnpm**.

## Project Documentation

- **[CONTEXT.md](./CONTEXT.md)** — Domain glossary. Single source of truth for ubiquitous language (World, Character, Phase, CharacterRef, Event, Location, Item, Lore, Novel, Chapter, Scene, AgentConfig) plus cross-cutting conventions (name uniqueness, World isolation, position uniqueness).
- **[docs/adr/](./docs/adr/)** — Architecture Decision Records. Read before questioning "why is X like this?":
  - [ADR-0001](./docs/adr/0001-two-database-design.md) — Two-database design (meta.db + per-World files)
  - [ADR-0002](./docs/adr/0002-character-ref-composite-pk.md) — CharacterRef composite PK includes phase_id
  - [ADR-0003](./docs/adr/0003-trigger-event-vs-character-refs-independence.md) — trigger_event_id vs character_refs semantic independence
  - [ADR-0004](./docs/adr/0004-world-isolation.md) — World isolation (no cross-World references)
  - [ADR-0005](./docs/adr/0005-workspace-shell-layout.md) — Workspace shell layout (dual layout: app vs world)
  - [ADR-0006](./docs/adr/0006-deletion-cascade-to-character-refs.md) — Phase/Character deletion cascades to CharacterRefs, with pre-delete disclosure
  - [ADR-0007](./docs/adr/0007-three-database-design.md) — Three-database design (meta.db + per-Space space.db + per-World files)
  - [ADR-0008](./docs/adr/0008-space-password-is-auth-gate.md) — Space password is an auth gate (argon2id hash), not at-rest encryption
  - [ADR-0009](./docs/adr/0009-workspace-shell-three-tier-and-titlebar-tabs.md) — Workspace shell three-tier (app/space/world) layout with titlebar tabs
  - [ADR-0010](./docs/adr/0010-tab-state-keepalive.md) — Tab state preservation via in-app DOM keep-alive (superseded by ADR-0011)
  - [ADR-0011](./docs/adr/0011-one-space-per-window.md) — One Space per OS window
  - [ADR-0012](./docs/adr/0012-space-scoped-ai-config.md) — AI provider configuration is Space-scoped, not global Setting
  - [ADR-0013](./docs/adr/0013-api-key-plaintext-storage.md) — API keys stored as plaintext in space.db (threat model + upgrade path)
  - [ADR-0014](./docs/adr/0014-logging-tracing-stack.md) — Logging uses `tracing` stack + custom frontend bridge (not `tauri-plugin-log`)
  - [ADR-0015](./docs/adr/0015-unified-log-file-with-export-filter.md) — Unified log file with export-time Space filtering (not per-Space files)
  - [ADR-0016](./docs/adr/0016-snake-case-log-fields-across-stack.md) — `snake_case` log field names across Rust and TypeScript
  - [ADR-0017](./docs/adr/0017-agent-manual-step-loop.md) — Agent drives a manual step loop over AI SDK's `streamText` (one LLM step per iteration)
  - [ADR-0018](./docs/adr/0018-abort-resolves-not-rejects.md) — All `AgentLoop.run()` terminations resolve; errors surface via `result.error`, the promise never rejects
  - [ADR-0019](./docs/adr/0019-ai-agent-library-purity-boundary.md) — AI agent runtime library stays free of all application concerns (no React, no IPC, no logger)
  - [ADR-0020](./docs/adr/0020-session-layer.md) — Stateful `Agent` + `SessionStore` wrap the stateless `AgentLoop` for conversation memory and persistence
  - [ADR-0021](./docs/adr/0021-novel-scene-autosave-and-routing.md) — Novel Scenes are not deep-linkable; full-replacement `update_scene` mandates single-source-of-truth auto-save
- [ADR-0022](./docs/adr/0022-chat-conversations-world-scoped.md) — Chat conversations are World-scoped (persisted in world.db)
- [ADR-0023](./docs/adr/0023-conversation-role-bound-live-model.md) — Conversation is role-bound; model resolved live from AgentConfig
- [ADR-0024](./docs/adr/0024-conversation-runtime-cache-space-layout.md) — Conversation runtime cache at the Space-layout layer
- [ADR-0025](./docs/adr/0025-tool-consent-execute-blocking-gate.md) — Tool consent via execute-blocking approval gate
- [ADR-0026](./docs/adr/0026-timemapper-architecture.md) — TimeMapper: user-authored JS, output-only, Web Worker isolation
- [ADR-0027](./docs/adr/0027-novel-export-epub-and-txt.md) — Novel export as EPUB + TXT (Rust-side generation, no MOBI); `Novel.author` field; single `export_novel` aggregation command
- [ADR-0028](./docs/adr/0028-three-layer-message-model.md) — Three-layer message model (Persisted Thread / Derived Model Input / Run Delta) underpinning Plan and Context modes
- [ADR-0029](./docs/adr/0029-toolcontext-extension-for-plan-and-context-modes.md) — ToolContext extension: `planAccess` (Phase 1, Plan mode) + `threadLookup` (Phase 2, Context mode — designed, deferred)
- [ADR-0030](./docs/adr/0030-token-usage-persistence.md) — Token usage persistence through the SessionStore boundary (per-turn input/output on last assistant message; cache/occupancy kept ephemeral)
- [ADR-0031](./docs/adr/0031-tool-call-stub-compaction.md) — Tool-call stub compaction (Context mode Phase 1): aged tool pairs become `[tool_call {id}]` stubs, expandable via `context_read`
- [ADR-0032](./docs/adr/0032-world-export-import-format.md) — World export/import as `.sluver-world` archive
- [ADR-0033](./docs/adr/0033-timeline-derived-character-swimlane-view.md) — Timeline derived character-swimlane view (agent `timeline_lookup` surface; UI surface superseded by ADR-0034)
- [ADR-0034](./docs/adr/0034-timeline-ui-uniform-character-swimlane-grid.md) — Timeline UI as uniform character-swimlane grid (non-proportional, order-based; supersedes ADR-0033 UI surface)
  - [ADR-0035](./docs/adr/0035-grep-match-centric-retrieval-tool.md) — `grep` match-centric full-corpus retrieval tool (occurrence evidence across all entity text fields; distinct from entity-discovery `search_*`)
  - [ADR-0036](./docs/adr/0036-native-notifications-notify-rust-explicit-aumid.md) — Native notifications via notify-rust with explicit AUMID + startup self-registration (replaces tauri-plugin-notification, whose dev-mode PowerShell AUMID is silently dropped on Win11 24H2+)
  - [ADR-0037](./docs/adr/0037-notes-agent-access-prompt-gated-static-registration.md) — Notes agent access: prompt-gated static registration on both roles; notes excluded from `grep` corpus; dedicated `grep_notes` tool
  - [ADR-0038](./docs/adr/0038-notes-single-table-tree-storage.md) — Notes storage: single `notes` table (kind discriminator, first adjacency list), NULL-safe sibling title uniqueness, no position UNIQUE (scene_images precedent), app-layer cycle guard

## Git commit style

Conventional Commits: `type(scope): description`

| Type       | Usage                                   |
| ---------- | --------------------------------------- |
| `feat`     | New feature                             |
| `fix`      | Bug fix                                 |
| `refactor` | Code restructuring (no behavior change) |
| `chore`    | Tooling, config, deps, misc             |
| `docs`     | Documentation                           |
| `style`    | Formatting, whitespace                  |
| `ci`       | CI/CD                                   |
| `test`     | Tests                                   |
| `perf`     | Performance                             |

Scope is optional but encouraged for clarity (e.g. `feat(tauri):`, `fix(ui):`, `chore(deps):`). All lowercase.

## Commands

| Command            | Purpose                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `pnpm tauri dev`   | Full app dev (Vite + Rust backend). Dev server on **port 1420** (strict). HMR on port 1421. |
| `pnpm tauri build` | Production build (frontend + native binary). Runs `pnpm build` internally.                  |
| `pnpm build`       | Frontend-only build (`tsc && vite build`). Output to `dist/`.                               |
| `pnpm dev`         | Vite dev server only (no Rust backend). For frontend-only work.                             |
| `pnpm type-check`  | `tsc --noEmit`. Fast type validation.                                                       |
| `pnpm lint`        | oxlint (not eslint). Runs from repo root; ignores `dist/`, `src-tauri/`, `node_modules/`.   |
| `pnpm lint:fix`    | oxlint with auto-fix.                                                                       |

## Architecture

### Domain model

See **[CONTEXT.md](./CONTEXT.md)** for the full glossary. In short: a World contains Characters (with Phases), Locations, Items, Lore, Events, and Novels (Chapters → Scenes); Scenes reference back into the worldbuilding material.

### Two-database design

Each World is its own SQLite file (`worlds/{uuid}.db`); `meta.db` holds only the world registry + app settings. World-scoped tables have NO `world_id` column. See **[ADR-0001](./docs/adr/0001-two-database-design.md)** for rationale, **[ADR-0004](./docs/adr/0004-world-isolation.md)** for the isolation rule.

### Backend (Rust) — `src-tauri/src/`

```
lib.rs          # Builder: setup (creates data_dir + worlds/), manages DbManager, registers ~40 commands
main.rs         # Binary entry → sluver_lib::run()
util.rs         # new_id() = UUID v7; now_iso() = ISO 8601 ms precision
db/
  manager.rs    # DbManager — the ONLY managed State. with_meta() / with_world() closure pattern
  migrations.rs # ALL migrations inline as &str SQL — NO .sql files. META_MIGRATIONS + WORLD_MIGRATIONS
  error.rs      # DbError enum — serializes to ErrorPayload {code, message, args} (see Internationalization section)
commands/       # One file per domain: world, character, element, event, novel
models/         # One file per entity: structs with #[serde(rename_all = "camelCase")]
```

**Command conventions:**

- Signature: `fn create_x(world_id: String, input: CreateXInput, state: State<'_, DbManager>) -> Result<X, DbError>`. World-scoped commands take `world_id` first; world/config commands use `with_meta()` directly.
- Updates are **full replacement** (not PATCH). Check `rows_affected == 0` → `NotFound`. Read back the entity after mutation.
- Junction refs (Event `character_refs`, Scene `character_refs`/`item_ids`/`event_ids`) = delete-all + re-insert in a transaction.
- Reorder commands (`reorder_chapters`, `reorder_scenes`, `reorder_phases`) take `Vec<String>` of IDs, set `position = index`.
- `commands/element.rs` uses a `load_element!` macro — Location/Item/Lore share identical schema.

**Rust gotchas:**

- `Vec<String>` fields (`tags`, `aliases`) are stored as **JSON TEXT** in SQLite, deserialized via `serde_json::from_str().unwrap_or_default()`.
- All connections enable `foreign_keys = ON` + `journal_mode = WAL`.
- All IDs are **UUID v7** (time-sortable). No sequential IDs anywhere.
- `#[serde(rename_all = "camelCase")]` on ALL models — Rust snake_case internally, frontend camelCase.
- DbManager lock ordering: `with_world()` resolves the world DB path via the `meta` lock, releases it, THEN acquires the `worlds` cache lock — reversing this order deadlocks (see ADR-0001).

### Frontend — `src/`

```
main.tsx, App.tsx   # STILL DEFAULT TAURI BOILERPLATE — not yet wired to the api/ layer
api/                # Typed IPC layer wrapping invoke()
  client.ts         # call<T>(cmd, args?) → invoke<T>(). Rejections carry ErrorPayload (see Internationalization section); use toErrorPayload() at catch sites.
  *.ts              # One file per domain: createX/getX/listX/updateX/deleteX. World-scoped take worldId first.
  types.ts          # CreateInput<T,R> derives input types from entity types (no field duplication).
types/              # Zod schemas are the SINGLE SOURCE OF TRUTH; TS types via z.infer
  index.ts          # Barrel re-export of all branded IDs + schemas + types
  ids.ts            # Leaf module (eventIdSchema only) — breaks character↔event import cycle
  *.ts              # Branded IDs: z.string().brand<'EntityId'>() prevent cross-entity mixups
components/ui/      # shadcn/ui (base-mira style — @base-ui/react, NOT Radix)
lib/utils.ts        # cn() = clsx + tailwind-merge
```

**Frontend patterns:**

- `types/element.ts` defines `elementBaseSchema` shared by Location/Item/Lore; each extends it with a branded ID.
- App.tsx is boilerplate calling `invoke("greet")` — a command no longer registered in `lib.rs`. The real API surface lives in `src/api/` + `src/types/`. When building UI, import from `@/api` and `@/types`, do not extend App.tsx's demo code.
- Routing is **code-based TanStack Router** (`src/router.ts` composes the tree via `addChildren` — the `src/routes/` layout mirrors file-based naming but there is NO codegen plugin; a new route must be created AND registered in `router.ts` or it silently doesn't exist). State: zustand + @tanstack/react-query. No tests yet.
- Markdown rendering: `react-markdown` + `remark-gfm` + `rehype-highlight` (see `src/components/chat/markdown.tsx`). CodeMirror 6 is used for TimeMapper JS editing (`src/components/timemapper/code-editor.tsx`). `markdown-it` has been REMOVED. Scene `content` is **plain text by design** (see CONTEXT.md) — markdown rendering belongs to chat (and Notes). Icons: `@hugeicons/react` + `@hugeicons/core-free-icons`, used throughout.

### Key patterns

- **Path alias**: `@/` → `./src/` (configured in both `vite.config.ts` and `tsconfig.json`).
- **shadcn/ui style**: `base-mira` — components use `@base-ui/react` primitives, not Radix. This differs from most shadcn docs/examples which assume Radix. Config in `components.json`.
- **Icon library**: hugeicons (`components.json` → `iconLibrary: "hugeicons"`, baseColor `neutral`).
- **Dark mode**: toggle by adding/removing `.dark` class. CSS uses `@custom-variant dark (&:is(.dark *))` pattern (Tailwind v4).
- **Color system**: oklch, defined as CSS custom properties in `index.css` (`:root` / `.dark`).

### Internationalization (i18n)

**Stack**: `react-i18next` v17 + `i18next-resources-to-backend` (Vite dynamic `import()` → bundled chunks, no HTTP / no Tauri fs needed) + `@tauri-apps/plugin-os` (OS locale detection). User's choice persists in `meta.db` settings table under key `app.locale`.

**Locale files** — `src/i18n/locales/{zh-CN,en}/{namespace}.json`:

| Namespace  | Use for                                                                         |
| ---------- | ------------------------------------------------------------------------------- |
| `common`   | Shared UI atoms (actions.cancel/save/delete, nav labels, shared empty states)   |
| `world`    | World hub page, world card, create/edit dialogs, world toasts                   |
| `settings` | Settings page (theme/color/language options + toasts)                           |
| `errors`   | Error code translations + entity name map (Character→角色, Location→地点, etc.) |

Add a namespace when a new domain (e.g. `novel`, `character`) accumulates enough strings. Add a locale by creating a new `{locale}/` folder with all namespace JSONs AND appending the code to `SUPPORTED_LOCALES` in `src/i18n/index.ts`.

**Using translations in components:**

```tsx
import { useTranslation } from "react-i18next";

function MyComponent() {
  // List every namespace this component reads from.
  const { t } = useTranslation(["world", "common"]);
  return <h1>{t("world:hub.title")}</h1>;
}
```

- **Key format**: `namespace:dotted.camelCase.path` (e.g. `world:card.deleteTitle`).
- **Interpolation**: `t("world:card.deleteTitle", { name: world.name })` — JSON uses `{{name}}`.
- **Async callbacks** (useEffect catch handlers, promise `.catch()`, event handler promise chains): use the **global** `i18n.t("ns:key")` from `@/i18n`, NOT the hook `t`. The hook `t` triggers `react-hooks/exhaustive-deps` warnings inside effects; the global `i18n` is correct for non-render contexts. The hook `t` is for JSX inside the render body.

**Error translation pipeline (CRITICAL):**

1. Rust `DbError` (in `src-tauri/src/db/error.rs`) serializes to `ErrorPayload { code: string, message: string, args: Record<string,string> }`:
   - Business errors (`WorldNotFound`, `NotFound`) → stable `code` (e.g. `"WORLD_NOT_FOUND"`, `"NOT_FOUND"`) + structured `args` (e.g. `{entity, id}`).
   - Infrastructure errors (SQLite/IO/Migration/Serde) → `code: "INTERNAL_ERROR"` with raw English `message` as fallback (dynamic, not worth translating).
2. Frontend catch sites: `const payload = toErrorPayload(e)` (normalizes object/string/unknown), then `translateError(payload)` → looks up `errors:{code}` with localized entity name substitution; falls back to `payload.message` for `INTERNAL_ERROR` / unknown codes.
3. Standard toast pattern:
   ```tsx
   toast.error(t("world:toast.createFailed"), {
     description: translateError(toErrorPayload(e)),
   });
   ```

When adding a new `DbError` variant: if it's a business error, give it a stable code in `to_payload()` and add the translation key to BOTH `errors.json` files. If it's infrastructure, leave it as `INTERNAL_ERROR`.

**Locale resolution chain** (at bootstrap in `src/main.tsx`, runs BEFORE React renders — no flash of fallback language):

1. `AppConfig.locale` from `meta.db` (`"auto"` = follow OS, otherwise a BCP-47 tag)
2. `@tauri-apps/plugin-os` `locale()` — respects Windows system language (unlike `navigator.language` which is hardcoded by Chromium WebView2, see tauri#2735)
3. `"en"` fallback

`resolveLocale()` in `src/i18n/index.ts` normalizes any BCP-47 tag to a `SUPPORTED_LOCALES` value (all `zh-*` variants → `zh-CN`).

**Language switching at runtime** — `i18n.changeLanguage(lng)` + `setDayjsLocale(lng)` (from `@/lib/format`) MUST be called together so dayjs relative times follow. See `handleChangeLanguage` in `src/routes/settings.tsx` for the optimistic-update-with-rollback pattern.

**Adding a new user-facing string (checklist):**

1. Pick the namespace + design a key path (e.g. `novel:editor.wordCount`).
2. Add the key to BOTH `src/i18n/locales/zh-CN/{ns}.json` AND `src/i18n/locales/en/{ns}.json`. Missing either side → fallback shown to users.
3. In the component: `const { t } = useTranslation(["{ns}", "common"]);` then `t("{ns}:your.key")`.
4. If the string lives inside an async callback (effect/promise), use `i18n.t("{ns}:your.key")` from the global import instead (see rule above).

### Logging

**Stack**: `tracing` + `tracing-subscriber` + `tracing-appender` + `tracing-log` (Rust) and a custom one-command Tauri bridge that forwards frontend log records into the same subscriber (ADR-0014). The unified file lives at `app_data_dir/logs/sluver.YYYY-MM-DD.log` — note the **dot separator** (a `tracing-appender` limitation; ADR-0015 documents why the dash form was abandoned). JSON-lines in the file, pretty text on stderr (no-op in release builds due to `windows_subsystem = "windows"`), 14-day retention, 100 MB soft warning. Three verbosity tiers exposed in the Settings → Diagnostics panel; `RUST_LOG` env var always wins.

**Module map:**

| Path                                                         | Role                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src-tauri/src/logging.rs`                                   | Subscriber init, panic hook, retention cleanup, `LoggingState` (owns the `WorkerGuard` + `ReloadHandle`), canonical `tier_to_filter` mapping, `DEFAULT_FILTER` const                                 |
| `src-tauri/src/commands/diagnostics.rs`                      | 5 IPC commands: `frontend_log` (bridge ingress), `get_log_level` / `set_log_level` (persist + reload + emit `log-level-changed`), `get_logs_dir`, `export_logs` (zip + README), `clear_logs`         |
| `src-tauri/src/lib.rs`                                       | `setup()` calls `logging::init` BEFORE `DbManager::new` (so db open + migration events get captured); `reapply_persisted_log_level` runs AFTER both are managed to restore the saved tier on startup |
| `src/lib/logger/{index,bridge,buffer,level,window-label}.ts` | Frontend logger singleton. Buffer holds entries that arrive before IPC is ready; flushed from `main.tsx` bootstrap. Level state mirrors Rust via the `log-level-changed` Tauri event                 |
| `src/api/diagnostics.ts`                                     | Typed IPC wrappers (`getLogLevel` / `setLogLevel` / `getLogsDir` / `exportLogs` / `clearLogs` + `dateRange` constructors + `VerbosityTier` / `DateRange` types)                                      |
| `src/components/error-boundary.tsx`                          | Root-level React ErrorBoundary; fallback UI has Reload + Export-logs buttons + 8-char `error_id` for support correlation                                                                             |

#### Field naming convention (CRITICAL — ADR-0016)

**All structured log field names are `snake_case` everywhere, including TypeScript callsites.** This is the only module in the codebase where TS code uses snake_case; the unified log file interleaves Rust and frontend lines, and a single grep pattern per field is non-negotiable. Match the existing vocabulary: `entity_id`, `space_id`, `world_id`, `window_label`, `db_kind`, `latency_ms`, `error`, `panic`, `backtrace`.

#### Redaction policy (CRITICAL)

Strict metadata-only logging by default. Three tiers:

| Tier                           | Examples                                                                                                                                                                                                                                                                      | Rule                                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ✅ Always safe                 | command name, entity type/id, latency, error code+args (DbError args already use snake_case), `space_id`/`world_id`/`window_label`, counts ("updated 3 character refs")                                                                                                       | Default INFO/DEBUG                                                                            |
| ⚠️ TRACE only (off by default) | entity `name`/`title` (creative work names may be sensitive), AI prompt length / response length / token counts / response first-80-chars                                                                                                                                     | Must explicitly enable via Settings → Diagnostics → "Very verbose" or `RUST_LOG=sluver=trace` |
| ❌ NEVER log                   | `Scene.content`, `Chapter.summary`, `Character.appearance`/`changes`, `Location/Item/Lore/Event` descriptions, AI prompt/response **full text**, API keys (plaintext per ADR-0013), Space password / argon2 hash, full filesystem paths (redact to `<app_data>/spaces/{id}/`) | Any level                                                                                     |

The `Secret<T>` wrapper pattern (auto-redacting `Debug`/`Display`) is reserved for future use — current enforcement is via `#[tracing::instrument(skip(...))]` on the Rust side and code review on the TS side.

#### Level taxonomy

| Level     | Use for                                                                                                                                                                | Examples                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **ERROR** | Panics, render crashes, unhandled rejections, security-adjacent failures (e.g. `spaces-locked` listener setup), bootstrap failures                                     | `panic captured`, `react.render_crash`, `window.unhandledrejection`, `bootstrap.failed` |
| **WARN**  | Business errors returned from commands (`NotFound`, `DuplicateName`), best-effort fire-and-forget failures (tray locale, catalog warm), retryable AI failures (future) | `db.entity.not_found`, `bootstrap.set_tray_locale.failed`                               |
| **INFO**  | App lifecycle (startup, version/OS), window created/destroyed/hidden, db open/close/migrate, tray menu refresh, Space unlock/lock, log-level change                    | `sluver starting`, `opened space.db`, `log level changed`                               |
| **DEBUG** | Tauri command entry/exit (auto via `#[tracing::instrument]`), DbManager connection acquisition, frontend console forwarding                                            | All `#[tracing::instrument]` spans                                                      |
| **TRACE** | Entity name/title, AI prompt/response length + first-80-chars (future), window event micro-details                                                                     | Off by default — requires explicit `RUST_LOG` or "Very verbose" tier                    |

#### Frontend usage

```ts
import { logger } from "@/lib/logger";

// ✅ Correct: snake_case fields, message is a stable greppable string
logger.info("character saved", { character_id: id, world_id: wid });
logger.warn("ai.streaming.interrupted", {
  tokens_received: 42,
  latency_ms: 820,
});

// ❌ WRONG — camelCase fields violate ADR-0016
logger.info("character saved", { characterId: id, worldId: wid });

// ❌ WRONG — structural dump hides what matters for grep
logger.info("character saved", character);

// ❌ WRONG — interpolated values break the message-as-key invariant
logger.info(`character ${name} saved`);
```

- The `console.*` API is off-limits except inside `src/lib/logger/index.ts` itself (the `error`-level devtools fallback) and `src/lib/logger/buffer.ts` (overflow warning). Both already carry `// oxlint-disable-next-line no-console`.
- Inside async callbacks (effect cleanup, promise `.catch()`, event listener bodies), the logger is correct — there is no hook-vs-global distinction like with `i18n.t`.

#### Rust usage

`#[tracing::instrument]` on every `#[tauri::command]` function. Mandatory `skip` set: `state`, `input`, `password`, `app`, and any `*_handle: AppHandle`. Entity IDs are exposed as fields:

```rust
// Get/delete by id:
#[tracing::instrument(skip(state, id), fields(entity_id = %id))]
#[tauri::command]
pub fn get_character(/* ... */, id: String, state: State<'_, DbManager>) -> Result<Character, DbError> { ... }

// Create (id generated inside) — declare the field, record after generation:
#[tracing::instrument(skip(state, input), fields(entity_id))]
#[tauri::command]
pub fn create_character(/* ... */) -> Result<Character, DbError> {
    let id = new_id();
    tracing::Span::current().record("entity_id", id.as_str());
    // ...
}
```

For **lifecycle events not tied to a command**, emit explicit `tracing::info!` / `debug!` (see `db/manager.rs::with_meta`/`with_space`/`with_world`, `tray::setup`/`refresh`, `lib.rs::on_window_event` for the established patterns).

- `println!` / `eprintln!` / `dbg!` are forbidden in production code — they're invisible in release builds (`windows_subsystem = "windows"` has no stderr console).
- The `log::*` macros from the `log` crate are NOT used directly — they're absorbed into the tracing subscriber via the `tracing-log` bridge, so any dep that emits `log::*` (tauri, reqwest, rusqlite, tokio) still lands in the file.
- `anyhow` is forbidden in the public command API — all fallible paths return `Result<T, DbError>`.

#### Adding a new log point (checklist)

1. **Pick the level** from the taxonomy above. If unsure, start at DEBUG.
2. **Pick a stable message string** — treat it as a grep key, not prose. Convention: `domain.event_or_state` in snake_case (e.g. `"character.saved"`, `"db.space.opened"`, `"bootstrap.failed"`).
3. **Pick the fields** — only metadata from the "Always safe" tier above. Names are snake_case.
4. **Frontend**: `logger.<level>(message, fields)`. No `console.*`, no interpolation in the message.
5. **Rust**: `tracing::<level>!(field = value, /* ... */, "{}", message)`. For commands, prefer `#[tracing::instrument]` over manual entry logs.
6. **Verify** by running `pnpm tauri dev`, triggering the event, and `grep`-ing `app_data_dir/logs/sluver.YYYY-MM-DD.log` for your message string.

#### Verbosity tier ↔ EnvFilter ↔ frontend threshold mapping

The Settings Diagnostics panel exposes 3 abstract tiers (writers don't want to see `info,sluver=debug`). The canonical mapping lives in `src-tauri/src/logging.rs::tier_to_filter` — single source of truth used by both `set_log_level` (user change) and `reapply_persisted_log_level` (startup restore).

| Tier label (UI) | Rust `EnvFilter`                                      | Frontend `LogLevel` threshold |
| --------------- | ----------------------------------------------------- | ----------------------------- |
| Standard        | `info,sluver=debug`                                   | `info`                        |
| Verbose         | `debug`                                               | `debug`                       |
| Very verbose    | `trace,rusqlite=warn,reqwest=warn,hyper=warn,h2=warn` | `trace`                       |

`RUST_LOG` env var always overrides the persisted tier at startup (`EnvFilter::try_from_default_env` runs first). Use this for ad-hoc per-module debugging: `RUST_LOG=sluver::commands::ai=trace pnpm tauri dev`.

#### Common pitfalls

- **Listener typing for `log-level-changed`**: the payload is `{ level, filter }` (camelCase via serde on the Rust struct), NOT a bare `VerbosityTier` string. Typing the listener as `listen<VerbosityTier>(...)` silently breaks threshold sync — see `__root.tsx` for the correct shape.
- **`verbosityToLogLevel` is duplicated** in `__root.tsx` and `settings-dialog.tsx` (inlined to avoid a `logger/ → api/` import cycle). Both copies MUST stay in sync, and both have a defensive `default` branch returning `"info"` because the input is ultimately a string read from SQLite.
- **Don't put `console.*` in your component** "just for debugging" — it's a `no-console: warn` lint, and it's invisible in release builds. Use `logger.debug(...)` instead; you can crank verbosity to "Verbose" in Settings to see its output without restarting.
- **Don't dump whole input structs** with `?input` in `#[tracing::instrument]` — `input` may contain user creative content (names, descriptions). Always `skip(input)` and add explicit `fields(entity_id)` instead.
- **`migrations.rs` has no apply loop** to instrument — `rusqlite_migration::to_latest()` handles iteration internally. Migration events are logged at the call sites in `db/manager.rs`.

#### Where to find logs at runtime

- **Dev**: stderr (pretty text) streams live in the terminal running `pnpm tauri dev`. JSON-lines file also written.
- **Production**: only the JSON-lines file at `app_data_dir/logs/sluver.YYYY-MM-DD.log`. Open it via Settings → Diagnostics → "Open log folder" (uses `tauri-plugin-opener`).
- **Export for bug reports**: Settings → Diagnostics → "Export logs…" produces a zip with a README.txt (system metadata, no creative content) and the requested Space/date window. The `space_id` filter is the only privacy control on the export side (ADR-0015).

#### References

- [ADR-0014](./docs/adr/0014-logging-tracing-stack.md) — `tracing` stack over `tauri-plugin-log`
- [ADR-0015](./docs/adr/0015-unified-log-file-with-export-filter.md) — unified log file with export-time Space filtering
- [ADR-0016](./docs/adr/0016-snake-case-log-fields-across-stack.md) — `snake_case` field names across Rust + TypeScript

## Agent Skills

Project skills live in `.opencode/skills/`. **Agents MUST assess the current task and auto-load the relevant skill** via `load_skills=[...]` (for `task()`) or the `skill` tool — do not wait to be told which skill to use.

| Skill             | Applies when                                                                                                                                | Notes                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `shadcn`          | Adding / searching / fixing / composing shadcn/ui components; touching `components.json`, presets, `--preset` codes                         | This project uses `base-mira` style (`@base-ui/react`, NOT Radix). Load for any `components/ui/` work.                           |
| `frontend-design` | Building new UI, reshaping existing UI, making aesthetic / visual decisions (palette, typography, layout, motion)                           | Drives distinctive, opinionated design choices; avoids AI-templated defaults. Load alongside `shadcn` for page/feature-level UI. |
| `vercel-ai-sdk`   | Adding AI features (text generation, streaming, tool calling, agents, chat UI, embeddings); questions about the `ai` / `@ai-sdk/*` packages | Novel-writing app may integrate AI assistance. Load for anything AI-related.                                                     |
| `skill-creator`   | Designing, structuring, or packaging a new AgentSkill                                                                                       | Meta-tool. Load only when authoring/editing a skill.                                                                             |
| `skill-lookup`    | Discovering, retrieving, or installing skills                                                                                               | Meta-tool. Load only when searching for / installing skills.                                                                     |

**Auto-load rules (judge by task, then act):**

- Frontend / component work → always load `shadcn`; add `frontend-design` when visual design decisions are involved.
- AI feature work → always load `vercel-ai-sdk`.
- Skill authoring / installation → load `skill-creator` / `skill-lookup` respectively.
- When unsure whether a skill applies, include it — `load_skills` is cheap, missing domain context is expensive.

## Toolchain quirks

- **Linter is oxlint, not eslint.** Config at `.oxlintrc.json`. Plugins: `react`, `typescript`, `import`, `unicorn`. `correctness` category = error. Notable rules: `no-console: warn`, `typescript/no-explicit-any: warn`, `typescript/no-unused-vars: warn`, `react/no-direct-mutation-state: error`.
- **Formatter is oxfmt** (from oxc), not prettier. `.vscode/settings.json` forces whole-file format on save (oxfmt only supports whole-file mode).
- **Tailwind CSS v4** with `@tailwindcss/vite` plugin. Config is inline in CSS via `@theme` — **do not create a `tailwind.config.js`**.
- **tsconfig is strict**: `noUnusedLocals` + `noUnusedParameters` are ON — `pnpm type-check` FAILS on unused vars/params. Clean them up before committing.
- **No tests yet.**

## Verification

Do NOT rely on LSP diagnostics for verification — unreliable. Use commands instead:

- Frontend: `pnpm type-check`
- Backend: `cargo check` (run from `src-tauri/`); `cargo clippy` for linting.

## 禁令 (HARD PROHIBITIONS)

### 🚫 严禁 git clone 查看源码 (STRICTLY FORBIDDEN: git clone to read source)

**进行 `git clone` 来查看某个仓库的源码，是严重的「钻牛角尖」行为，本项目完全禁止。**

This applies to ALL agents and subagents (librarian, explore, oracle, task categories — everyone). No exceptions.

- **Do NOT** run `git clone`, `gh repo clone`, or any equivalent to fetch a repository's full source for reading/analysis.
- **Do NOT** instruct subagents to "find open-source apps and extract their schemas/DDL by cloning".
- This wastes enormous time and tokens, produces marginal value over web/docs search, and is exactly the kind of over-research that derails work.

#### What to do INSTEAD:

| ❌ Forbidden (rabbit hole)                         | ✅ Use instead (targeted)                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| `git clone https://github.com/x/y` then read files | GitHub **code search API** (e.g. `grep_app_searchGitHub`) for specific snippets |
| Clone a repo to "understand its schema"            | Read **docs / README / published DDL** via `webfetch` / `websearch`             |
| Clone to find usage examples                       | `context7_query-docs` for official library docs                                 |
| Spawning subagent that clones repos                | Direct `grep`/`glob` on **our own** codebase only                               |

#### If you (any agent) feel the urge to clone a repo:

STOP. The answer is almost always available via: official docs, npm/crates package metadata, GitHub raw file URLs (`raw.githubusercontent.com` — read single files, never clone), or web search. Use those.

**Violating this rule is a blocking failure. Report it immediately if a subagent attempts it.**

## Tauri-specific notes

- `pnpm build` = frontend only. `pnpm tauri build` = frontend + native binary.
- `tauri.conf.json` sets `beforeDevCommand: "pnpm dev"` and `beforeBuildCommand: "pnpm build"`. When running `pnpm tauri dev/build`, these commands execute automatically.
- Rust source lives in `src-tauri/` — oxlint ignores this directory. Use `cargo check` / `cargo clippy` for Rust linting.
- CSP is disabled (`"csp": null`). Adjust in `tauri.conf.json` before production.
- Capabilities (`src-tauri/capabilities/default.json`): `core:default` + `opener:default` only. Add new permissions here when invoking new Tauri APIs.
