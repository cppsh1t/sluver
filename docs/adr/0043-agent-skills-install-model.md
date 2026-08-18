# ADR-0043: Agent Skills — storage-center install model with progressive disclosure

**Status**: accepted. Amends [ADR-0031](./0031-tool-call-stub-compaction.md) (adds a compaction exemption for skill activation).

## Context

sluver's agents have fixed role prompts and fixed toolsets; the only user-extensible behavior surface is the per-AgentConfig `systemPrompt` override. There is no mechanism for reusable, distributable expertise packages — writing techniques, procedures, style conventions — that a user can install once and have the agent load exactly when relevant.

The industry has converged on one answer (the Anthropic Agent Skills open standard; Claude Code, OpenCode, and Codex all implement variants): a skill is a folder whose `SKILL.md` carries `name` + `description` frontmatter and a markdown body, optionally bundled with reference files and scripts. Activation is progressive disclosure — a metadata catalog (~100 tokens/skill) sits permanently in context, the model judges relevance from `description` alone, and the body plus bundled files load only on demand.

sluver-specific constraints that shape the design:

- The runtime library is purity-bound (ADR-0019): skill resolution and file reads happen app-side.
- The shell tool exists on **both** explorer and writer, default-off behind `shellToolEnabled` (ADR-0042), executing local interpreters resolved from PATH with the Space data directory as default cwd.
- Context compaction (ADR-0031) stubs aged tool-call pairs — a naive skill-body-as-tool-result design silently loses instructions mid-session.
- The app stores all user content in SQLite; there is no user-file filesystem storage.

## Decision

### 1. Skill = Anthropic-format package, Space-scoped, upload-only

Skills are Anthropic skill folders uploaded as zip archives. `space.db` gains a `skills` table: `id` (UUID v7), `name` and `description` (parsed from `SKILL.md` frontmatter at upload; `name` unique per Space — collisions rejected), `package` (the zip blob, the immutable original artifact), timestamps. Validation is lenient per the standard's client guidance, with one deliberate exception: a `name` outside the filesystem-safe charset `^[a-z0-9][a-z0-9-]{0,63}$` (Windows reserved device names included) is a hard rejection, because the name doubles as the on-disk directory name — filesystem safety is not a cosmetic concern. Otherwise: reject a missing/empty `description` or unparseable YAML; other cosmetic violations (name/dir mismatch) only warn.

Upload safety: zip-slip path traversal guard (OS-independent — `enclosed_name()` plus an explicit post-normalization `..` re-check, since the zip crate treats `\` as a separator only on Windows), ≤10 MiB total, ≤1 MiB per file, ≤100 files.

The skill page is a **storage center**, not an editor: import and delete only. Skills are authored externally in standard tooling; the app is their package manager. No in-app authoring surface exists.

### 2. Per-AgentConfig enablement; install model for materialization

An `agent_config_skills` junction table holds per-(AgentConfig, skill) toggles, surfaced in the existing AgentConfig settings dialog. Enabling a skill **installs** it: the zip is extracted to `spaces/{id}/skills/{name}/`. The install happens BEFORE the enablement row is recorded, so a failed install can never leave a skill reported as enabled but missing on disk (an orphan directory from a failure in between is benign — no row references it). Disabling or deleting removes the directory.

The DB is a storage source, not a sync service: after installation, **the disk copy is the runtime truth** and the DB plays no part in execution. There is no re-sync machinery. Re-installation (disable → enable, or re-upload) is the only propagation path. Configuration changes take effect for new conversations, same lifecycle as model/shell/compaction settings (ADR-0024 agent cache).

### 3. Progressive disclosure runtime

- **Catalog**: an `<available_skills>` block (name + description + disk location) is injected into the effective system prompt at Agent construction, for explorer and writer (never namer). Cost ~100 tokens per enabled skill.
- **`activate_skill` tool**: input enum-constrained to enabled skills (prevents hallucinated names); reads `SKILL.md` from the installed directory via app-side fs — **independent of the shell tool**; returns the body plus an enumeration of bundled files (listed, never eagerly loaded); `consentLevel: auto`; deduplicated per conversation.
- **`read_skill_file` tool**: reads bundled reference files from the installed directory; `consentLevel: auto`; compactable normally (re-readable on demand).
- **Scripts are not executed by sluver.** Skill instructions direct the model; bundled scripts run through the existing shell tool (local interpreter from PATH, default cwd = Space directory) **only when the user has enabled shell**. The risk boundary is exactly the ADR-0042 opt-in — enabling shell already means accepting arbitrary command execution, so skill scripts add no new capability class. With shell off, instructions and references still work; scripts are inert text.

### 4. Compaction exemption (amends ADR-0031)

`compactToolCalls` must never stub `activate_skill` call pairs. Without the exemption, a Writer conversation with compaction enabled crosses `turnAge` and the skill's instructions silently vanish from the model's view — no error, just behavior drift, precisely the failure mode the Agent Skills client guidance warns against. `read_skill_file` results compact normally: they are re-readable via the tool, so aging them out is safe.

### 5. No tool gating

Skills do not touch the consent system. No `allowedTools` pre-grant (activation-as-consent would weaken the ADR-0025 gate), no `disallowedTools` pool restriction (would require per-step toolset mutation in the pure loop). Skills influence tool use through instructions only; every tool call passes the existing consent levels unchanged.

## Consequences

**Positive:** ecosystem-compatible imports (community skill zips import zero-conversion); instruction/reference access works without shell, so users who never enable shell still get full skill value; scripts ride an existing, user-controlled risk gate rather than a new one; the catalog cost is bounded and constant per skill.

**Negative / accepted:** the installed directory can diverge from the zip if the model edits files via shell — disk is truth, such edits persist until re-installation (documented behavior, not a bug to fix); content is stored twice (zip blob + extracted files); no in-app authoring — authors need an external editor, accepted as the cost of staying format-compatible and shipping a small UI surface; ~100 tokens per enabled skill are always in context.

**Manual invocation:** natural language only in v1 — the user says "use skill X" and the model activates from the catalog. No slash-command UI.

**Future:** `.sluver-world` export does not carry skills (they are Space-scoped, not World-scoped); a Space-level export format, if ever built, would.

## References

- [agentskills.io](https://agentskills.io/specification) — the open standard (format, progressive disclosure, client implementation guidance)
- ADR-0031 (compaction — amended here), ADR-0042 (shell opt-in — the script risk boundary), ADR-0019 (runtime purity — activation reads are app-side), ADR-0025 (consent gate — deliberately untouched), ADR-0024 (agent cache lifecycle — when config changes take effect), ADR-0012 (Space-scoped AI configuration)
