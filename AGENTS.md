# AGENTS.md — sluver

Tauri v2 desktop app for **worldbuilding & novel writing**. React 19 + TypeScript frontend, Rust backend backed by SQLite. Package manager: **pnpm**.

## Project Documentation

- **[CONTEXT.md](./CONTEXT.md)** — Domain glossary. Single source of truth for ubiquitous language (World, Character, Phase, CharacterRef, Event, Location, Item, Lore, Novel, Chapter, Scene) plus cross-cutting conventions (name uniqueness, World isolation, position uniqueness).
- **[docs/adr/](./docs/adr/)** — Architecture Decision Records. Read before questioning "why is X like this?":
  - [ADR-0001](./docs/adr/0001-two-database-design.md) — Two-database design (meta.db + per-World files)
  - [ADR-0002](./docs/adr/0002-character-ref-composite-pk.md) — CharacterRef composite PK includes phase_id
  - [ADR-0003](./docs/adr/0003-trigger-event-vs-character-refs-independence.md) — trigger_event_id vs character_refs semantic independence
  - [ADR-0004](./docs/adr/0004-world-isolation.md) — World isolation (no cross-World references)
  - [ADR-0005](./docs/adr/0005-workspace-shell-layout.md) — Workspace shell layout (dual layout: app vs world)
  - [ADR-0006](./docs/adr/0006-deletion-cascade-to-character-refs.md) — Phase/Character deletion cascades to CharacterRefs, with pre-delete disclosure

## Git commit style

Conventional Commits: `type(scope): description`

| Type | Usage |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code restructuring (no behavior change) |
| `chore` | Tooling, config, deps, misc |
| `docs` | Documentation |
| `style` | Formatting, whitespace |
| `ci` | CI/CD |
| `test` | Tests |
| `perf` | Performance |

Scope is optional but encouraged for clarity (e.g. `feat(tauri):`, `fix(ui):`, `chore(deps):`). All lowercase.

## Commands

| Command | Purpose |
|---|---|
| `pnpm tauri dev` | Full app dev (Vite + Rust backend). Dev server on **port 1420** (strict). HMR on port 1421. |
| `pnpm tauri build` | Production build (frontend + native binary). Runs `pnpm build` internally. |
| `pnpm build` | Frontend-only build (`tsc && vite build`). Output to `dist/`. |
| `pnpm dev` | Vite dev server only (no Rust backend). For frontend-only work. |
| `pnpm type-check` | `tsc --noEmit`. Fast type validation. |
| `pnpm lint` | oxlint (not eslint). Runs from repo root; ignores `dist/`, `src-tauri/`, `node_modules/`. |
| `pnpm lint:fix` | oxlint with auto-fix. |

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
- No router, no state management library, no `hooks/` dir, no tests yet.
- `markdown-it` and `@hugeicons/react` are declared deps but not yet imported anywhere in `src/`. Scene `content` is **plain text by design** (see CONTEXT.md) — `markdown-it` is no longer earmarked for it. `@hugeicons/react` is reserved for UI icons.

### Key patterns

- **Path alias**: `@/` → `./src/` (configured in both `vite.config.ts` and `tsconfig.json`).
- **shadcn/ui style**: `base-mira` — components use `@base-ui/react` primitives, not Radix. This differs from most shadcn docs/examples which assume Radix. Config in `components.json`.
- **Icon library**: hugeicons (`components.json` → `iconLibrary: "hugeicons"`, baseColor `neutral`).
- **Dark mode**: toggle by adding/removing `.dark` class. CSS uses `@custom-variant dark (&:is(.dark *))` pattern (Tailwind v4).
- **Color system**: oklch, defined as CSS custom properties in `index.css` (`:root` / `.dark`).

### Internationalization (i18n)

**Stack**: `react-i18next` v17 + `i18next-resources-to-backend` (Vite dynamic `import()` → bundled chunks, no HTTP / no Tauri fs needed) + `@tauri-apps/plugin-os` (OS locale detection). User's choice persists in `meta.db` settings table under key `app.locale`.

**Locale files** — `src/i18n/locales/{zh-CN,en}/{namespace}.json`:

| Namespace | Use for |
|---|---|
| `common` | Shared UI atoms (actions.cancel/save/delete, nav labels, shared empty states) |
| `world` | World hub page, world card, create/edit dialogs, world toasts |
| `settings` | Settings page (theme/color/language options + toasts) |
| `errors` | Error code translations + entity name map (Character→角色, Location→地点, etc.) |

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

## Agent Skills

Project skills live in `.opencode/skills/`. **Agents MUST assess the current task and auto-load the relevant skill** via `load_skills=[...]` (for `task()`) or the `skill` tool — do not wait to be told which skill to use.

| Skill | Applies when | Notes |
|---|---|---|
| `shadcn` | Adding / searching / fixing / composing shadcn/ui components; touching `components.json`, presets, `--preset` codes | This project uses `base-mira` style (`@base-ui/react`, NOT Radix). Load for any `components/ui/` work. |
| `frontend-design` | Building new UI, reshaping existing UI, making aesthetic / visual decisions (palette, typography, layout, motion) | Drives distinctive, opinionated design choices; avoids AI-templated defaults. Load alongside `shadcn` for page/feature-level UI. |
| `vercel-ai-sdk` | Adding AI features (text generation, streaming, tool calling, agents, chat UI, embeddings); questions about the `ai` / `@ai-sdk/*` packages | Novel-writing app may integrate AI assistance. Load for anything AI-related. |
| `skill-creator` | Designing, structuring, or packaging a new AgentSkill | Meta-tool. Load only when authoring/editing a skill. |
| `skill-lookup` | Discovering, retrieving, or installing skills | Meta-tool. Load only when searching for / installing skills. |

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

| ❌ Forbidden (rabbit hole) | ✅ Use instead (targeted) |
|---|---|
| `git clone https://github.com/x/y` then read files | GitHub **code search API** (e.g. `grep_app_searchGitHub`) for specific snippets |
| Clone a repo to "understand its schema" | Read **docs / README / published DDL** via `webfetch` / `websearch` |
| Clone to find usage examples | `context7_query-docs` for official library docs |
| Spawning subagent that clones repos | Direct `grep`/`glob` on **our own** codebase only |

#### If you (any agent) feel the urge to clone a repo:

STOP. The answer is almost always available via: official docs, npm/crates package metadata, GitHub raw file URLs (`raw.githubusercontent.com` — read single files, never clone), or web search. Use those.

**Violating this rule is a blocking failure. Report it immediately if a subagent attempts it.**

## Tauri-specific notes

- `pnpm build` = frontend only. `pnpm tauri build` = frontend + native binary.
- `tauri.conf.json` sets `beforeDevCommand: "pnpm dev"` and `beforeBuildCommand: "pnpm build"`. When running `pnpm tauri dev/build`, these commands execute automatically.
- Rust source lives in `src-tauri/` — oxlint ignores this directory. Use `cargo check` / `cargo clippy` for Rust linting.
- CSP is disabled (`"csp": null`). Adjust in `tauri.conf.json` before production.
- Capabilities (`src-tauri/capabilities/default.json`): `core:default` + `opener:default` only. Add new permissions here when invoking new Tauri APIs.
