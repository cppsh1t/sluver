# ADR-0046: Custom LLM providers via global Settings JSON

**Status**: accepted.

## Context

Every model picker is fed by the models.dev catalog: `get_models_dev_catalog` / `refresh_models_dev_catalog` (`src-tauri/src/commands/ai.rs`) fetch `https://models.dev/api.json`, cache it at `data_dir/models-dev.json`, and serve it under a 24h TTL. models.dev cannot cover self-hosted gateways, corporate proxies, or niche providers — and a user who runs one should not have to wait for either models.dev or an app release to list it.

The credential half already generalizes. `provider_credentials` keys rows by provider slug with `UNIQUE provider_id` (ADR-0012/0013), never by an enum of blessed providers, so a credential for any slug can be stored today. The catalog is the only missing half: a provider absent from the catalog is invisible to every picker, even though the user can fully describe it (slug, base URL, model ids, npm package).

## Decision

### 1. Storage: meta.db settings key `ai.customProviders`, global

The raw JSON string lives in the meta.db `settings` table under `ai.customProviders` — a global Setting, not Space-scoped. The catalog is global data, identical for every Space; credentials stay Space-scoped per ADR-0012, and the provider slug is the join key on both sides. Because credential rows are slug-generic, a credential saved for a custom provider id works unchanged, including the delete cascade that clears bound model ids via `model_id LIKE '{provider}/%'`.

### 2. Management: JSON textarea in the global Settings dialog

Editing happens in a JSON textarea in the global Settings dialog; a placeholder documents the format. Saving goes through `set_custom_providers`, which returns a validation report (`CustomProvidersReport`) instead of failing on user input: a syntax error blocks the store entirely (`stored: false` — the previous value is untouched); per-entry schema errors are reported (`entryErrors`) but tolerated — the valid entries are still stored, mirroring the load-time skip semantics so the save report never disagrees with what a subsequent catalog load does. Empty input clears the setting.

### 3. Format: byte-compatible with models.dev

The setting string's root has the same shape as `https://models.dev/api.json` and is parsed by the same `Raw*` structs (`models/catalog.rs`), through a shared `raw_provider_to_catalog` mapper extracted from `parse_catalog` so builtin and custom entries take one identical path. Any provider object copy-pasted from models.dev works as-is; unknown upstream fields (`env`, `doc`, `cost`, `tool_call`, …) are ignored by serde.

### 4. Merge and read cadence

Merging happens Rust-side inside `load_catalog_from_disk` — the single choke point shared by the get, refresh, and stale-fallback paths — which receives the setting string as a parameter instead of deriving it from the data dir. The setting is read (a short `with_meta` closure; the meta lock is never held across any IO) at the top of each catalog command, before any fetch or file IO, so the merged view is consistent for the whole call. On provider-id collision, the custom entry wins as a **full replacement** (no per-field overlay); the merged list is re-sorted by provider id. Customs carry no cache or TTL of their own: the catalog query is invalidated on save, and the Space config page's reload button re-fetches — so edits appear without an app restart.

### 5. Failure semantics: never block

- Unset/empty setting — the normal state; the catalog is builtin-only.
- JSON syntax error or non-object root — WARN log, serve the builtin catalog only.
- Per-entry schema violation — skip that entry with WARN, keep the rest.
- Zero-model provider — WARN but still included; harmless, since the model picker filters empty providers anyway.

## Consequences

- Supported `npm` values are exactly the packages statically bundled in `src/lib/ai/provider/provider-modules.ts`; anything else fails at resolve time. The canonical custom setup is `"npm": "@ai-sdk/openai-compatible"` plus an `"api"` base URL — the baseUrl plumbing already flows catalog → resolver → factory.
- A broken setting can always be repaired in the same dialog that wrote it. The save-time report distinguishes the cases (syntax error vs per-entry ids); load-time WARN logs (`catalog.custom.parse_failed`, `catalog.custom.entry_skipped`, `catalog.custom.no_models`) cover reads, and saves/merged loads log `catalog.custom.saved` / `catalog.custom.loaded`.
- Save-time validation is advisory for entry-level problems: a report containing `entryErrors` still stores. Deliberate — a partially-valid paste isn't bounced (matching load-time skip semantics), and the report tells the author exactly which ids will be dropped.
- The vision capability tri-state (ADR-0045-adjacent logic in `src/lib/conversation-runtime/vision.ts`) passes custom models with no modalities through as selectable — unknown capability is not presumed absent, so self-hosted vision setups stay usable.

## Alternatives considered

- **Hand-edited file at `app_data_dir/custom-providers.json`** (the v1 design) — rejected: degradation is invisible (a typo silently drops providers, leaving only a WARN in the log file), there is no validation feedback loop at edit time, and a file outside the app has no Settings surface to edit or clear it from.
- **An `AppSetting` struct field** — rejected: `update_app_setting` rewrites the whole struct on every appearance change, so a stale client would clobber the custom-providers value along with any other concurrently-changed key. A dedicated settings row with its own UPSERT (`get_/set_custom_providers`) avoids the read-modify-write race entirely.
- **Env-var-driven config** — rejected: inconsistent with the DB credential model and invisible to the Settings surface.
- **Rich per-provider form UI** — deferred, not rejected: additive once the JSON format proves stable.

## References

- ADR-0012 (Space-scoped AI config — credentials stay per-Space), ADR-0013 (credential storage), ADR-0045 (vision tri-state selectability that custom models inherit).
