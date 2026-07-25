# Unified log file with export-time Space filtering

**Status**: accepted.

All log events from every window and every Space land in a single rolling file under `app_data_dir/logs/`. The active file is named `sluver.YYYY-MM-DD.log` (one per day via `tracing-appender::rolling::daily`). Note: `tracing-appender` hardcodes `.` as the separator between filename prefix, date, and suffix, so the originally-considered `sluver-YYYY-MM-DD.log` (dash) is not achievable without a custom writer — the dot form is the closest available default and the difference is cosmetic (export-time filtering keys off the `space_id` field inside each line, not the filename). Each line carries a `space_id` field (null for cross-Space events). Per-Space log isolation is enforced at **export time** (the export dialog lets the user pick "all Spaces" or "current Space only" and filters by `space_id`), not at write time.

This deliberately diverges from the strong isolation principle of ADR-0004 (World isolation) and ADR-0007 (Space isolation). The divergence is scoped: those ADRs govern the **data model** (no cross-World or cross-Space entity references at the schema/query/UI layer). Logs are a **runtime observability stream**, not domain data — conflating the two would be overzealous.

The alternative — splitting logs into `logs/app.log` + `logs/spaces/{spaceId}.log` — has a fatal classification problem: the events most valuable for post-mortem debugging (meta.db migrations, launcher startup, tray hide-to-tray re-lock per ADR-0008, `determine_startup_space`) do not belong to any Space. They would have to live in `app.log`, and correlating an issue across `app.log` plus N Space files would be strictly harder than grepping one unified file. Meanwhile, the genuine privacy concern ("sharing a bug report from Space A should not leak Space B's activity") is fully solved by the export-time filter, because `space_id` is already a required field on every Space-scoped event.

Tradeoffs:

- The unified file does contain cross-Space activity in raw form on the user's disk. Acceptable: the user owns their own disk; the threat model only matters when logs leave the machine, which is exactly what the export filter controls.
- "Delete a Space → delete its logs" is not free (would require scanning the unified file by `space_id` and rewriting). Accepted as a non-goal for v1; deletion only happens via the 14-day retention sweep or the explicit "clear all logs" button in Settings.
- Migration from unified → split (if ever needed) is mechanical: the unified file already has `space_id` on every line, so a one-shot script can partition it. The reverse direction (split → unified) would lose interleaving and timestamp ordering. This asymmetry is why unified is the safer starting point.
