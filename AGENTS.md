# AGENTS.md — sluver

Tauri v2 desktop app. React 19 + TypeScript frontend, Rust backend. Package manager: **pnpm**.

## Commands

| Command | Purpose |
|---|---|
| `pnpm tauri dev` | Full app dev (Vite + Rust backend). Dev server on **port 1420** (strict). HMR on port 1421. |
| `pnpm tauri build` | Production build (frontend + native binary). Runs `pnpm build` internally. |
| `pnpm build` | Frontend-only build (`tsc && vite build`). Output to `dist/`. |
| `pnpm dev` | Vite dev server only (no Rust backend). For frontend-only work. |
| `pnpm type-check` | `tsc --noEmit`. Use this for fast type validation without full build. |
| `pnpm lint` | oxlint (not eslint). Runs on `src/` only — `src-tauri/` and `dist/` are excluded. |
| `pnpm lint:fix` | oxlint with auto-fix. |

## Architecture

```
src/                    # Frontend (React + TypeScript)
  main.tsx              # Entry point
  App.tsx               # Root component
  index.css             # Tailwind + shadcn theme (oklch colors, dark mode via `.dark` class)
  lib/utils.ts          # cn() utility (clsx + tailwind-merge)
  components/ui/        # shadcn/ui components (base-mira style — uses @base-ui/react, NOT Radix)
src-tauri/               # Rust backend (Tauri v2)
  src/lib.rs             # Tauri app builder + command handlers
  src/main.rs            # Binary entry (delegates to sluver_lib::run)
  tauri.conf.json        # Tauri config (beforeDevCommand, beforeBuildCommand, window config)
  capabilities/           # Tauri capability permissions
```

### Key patterns

- **Path alias**: `@/` maps to `./src/` (configured in both `vite.config.ts` and `tsconfig.json`)
- **Frontend→Rust IPC**: Use `invoke("command_name", { args })` from `@tauri-apps/api/core`. Commands are registered in `src-tauri/src/lib.rs` via `tauri::generate_handler![]`
- **shadcn/ui style**: `base-mira` — components use `@base-ui/react` primitives, not Radix. This differs from most shadcn docs/examples which assume Radix.
- **Dark mode**: Toggle by adding/removing `.dark` class. CSS uses `@custom-variant dark (&:is(.dark *))` pattern (Tailwind v4).
- **Color system**: oklch, defined as CSS custom properties in `index.css` (`:root` / `.dark`).

## Toolchain quirks

- **Linter is oxlint, not eslint.** Config at `.oxlintrc.json`. Plugins: `react`, `typescript`, `import`, `unicorn`. Key rules: `no-console: warn`, `no-explicit-any: warn`.
- **Formatter is oxfmt** (from oxc), not prettier. VSCode config at `.vscode/settings.json` forces whole-file format on save.
- **Tailwind CSS v4** with `@tailwindcss/vite` plugin. No `tailwind.config.js` — configuration is inline in CSS via `@theme`. Do not create a `tailwind.config.js`.
- **No router, no state management library, no tests yet.** This is early-stage boilerplate.

## Verification

Do NOT rely on LSP diagnostics for verification — unreliable. Use commands instead:
- Frontend: `pnpm type-check`
- Backend: `cargo check` (run from `src-tauri/`)

## Tauri-specific notes

- `pnpm build` = frontend only. `pnpm tauri build` = frontend + native binary.
- `tauri.conf.json` sets `beforeDevCommand: "pnpm dev"` and `beforeBuildCommand: "pnpm build"`. When running `pnpm tauri dev/build`, these commands execute automatically.
- Rust source lives in `src-tauri/` — oxlint ignores this directory. Use `cargo check` / `cargo clippy` for Rust linting.
- CSP is disabled (`"csp": null`). Adjust in `tauri.conf.json` before production.
