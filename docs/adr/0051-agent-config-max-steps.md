# Per-role max steps stored in AgentConfig, NULL falls back to registry default

The AgentLoop step budget (`maxSteps`, the rung-4 termination in `loop.ts`) was historically hardcoded per role in `ROLE_REGISTRY` (`src/lib/ai-roles/index.ts`). It now lives in the per-role `AgentConfig` row (`agent_configs.max_steps`, SPACE_MIGRATION_012) and is editable on the Space config page; `ROLE_REGISTRY.maxSteps` demotes to the fallback default.

Shape of the decision:

1. **Nullable column, NULL = code default.** `max_steps INTEGER NULL` (no NOT NULL, no DEFAULT) mirrors the `system_prompt` convention (`''` = code default): the DB stores only user intent, the effective value is resolved at run composition in `constructAgent` (`maxStepsOverride ?? roleDefinition.maxSteps`). This keeps the registry the single place a code-level default lives and lets future default changes reach unconfigured rows without a migration.
2. **Default raised to 30 for all loop roles.** The former split (orchestrator 10, writer/curator 15, others 10) was flattened: every loop role (orchestrator + 8 subagents) defaults to 30. The differentiation bought nothing in practice — writer/curator hitting max-steps mid-task was a common failure, not a safety feature — and a user-editable budget makes per-role code constants redundant. One-shots (`namer`, `vision`) never run the loop; their registry `maxSteps: 1` is an inert shape-keeper and the config UI hides the control for them.
3. **Validation is app-layer, not SQL.** Following the `context_compaction.turn_age` precedent: no CHECK constraint; `do_update_agent_config_max_steps` rejects non-positive integers with `DbError::InvalidInput`, and the frontend Zod schema (`z.number().int().positive().nullable()`) is the happy-path validator.
4. **UI commits presets, not free text.** The config dialog uses a preset `Select` (10…200 + a "Default (30)" option committing NULL), copying the `turnAge` control. Immediate-commit-on-change, like every other field in that dialog.

The cost: one more nullable field fanned through `ResolvedAgentModelConfig` → `ResolvedModel` → `constructAgent`. The alternative — `NOT NULL DEFAULT 30`, always-materialized — would have simplified the plumbing but frozen the 30 into every existing row, requiring a data migration for any future default change and erasing the "user never touched this" signal.
