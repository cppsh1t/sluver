# `snake_case` log field names across Rust and TypeScript

**Status**: accepted.

Every structured log field name is `snake_case` everywhere — in Rust `tracing::info!` calls, in TypeScript `logger.info()` calls, and in the JSON-lines file they produce. This deliberately violates TypeScript's `camelCase` convention at logger callsites only.

The deciding reason is grep ergonomics in the unified log file (ADR-0015). Frontend events and Rust events interleave in the same file. If the frontend wrote `spaceId`/`characterId`/`windowLabel` and Rust wrote `space_id`/`character_id`/`window_label`, every grep for a single field would require two patterns (`space_id|spaceId`), and the cognitive overhead compounds across every field in every query. A single canonical form means a single grep expression.

The secondary reason is consistency with the existing `DbError` → `ErrorPayload.args` convention (see `src-tauri/src/db/error.rs`), which already uses `snake_case` keys (`entity`, `id`). Log fields should match the same vocabulary rather than introduce a parallel `camelCase` one for the same conceptual data.

The alternative — `camelCase` in TypeScript with automatic conversion to `snake_case` at the `frontend_log` bridge — was rejected because the conversion is recursive (fields can be nested in objects or arrays), bug-prone, and the bridge becomes a silent renaming layer that surprises anyone debugging the bridge itself.

Tradeoffs:

- TypeScript code calling `logger.info("character saved", { character_id: id })` reads unnaturally to TS-native developers. Mitigated by scope: this convention applies **only** to logger callsites, never to business logic or component props. An oxlint rule (or at minimum a code-review checklist item) flags `camelCase` keys in `logger.*` field objects.
- The convention must be documented once and enforced consistently; a half-migration (some modules `snake_case`, others `camelCase`) is worse than either pure form.
