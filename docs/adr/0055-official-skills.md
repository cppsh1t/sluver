# ADR-0055: Official skills — app-seeded, undeletable, default-enabled per role

**Status**: accepted. Amends [ADR-0043](./0043-agent-skills-install-model.md) (two clauses, named in §Decision).

## Context

ADR-0043 made skills a pure user-import surface: the app is a package manager over uploaded community zips. But sluver's agent roles have concrete editorial jobs (the `curator` subagent writes worldbook entity fields), and the app itself owns the authoring standards those jobs should follow — standards that today live only in role prompts, unversioned and invisible to the user. The same mechanism Anthropic built skills for (distributable expertise packages) applies to first-party content: the app should be able to ship a skill, have it appear in every Space's pool, and have the right role use it out of the box.

Concretely (the first shipping instance): `docs/official-skills/element-creation-guide/` — the worldbook element authoring standards (standalone-reference-entry fields, aliases as in-story forms of address, plain-text paragraphed descriptions, moderate tags, notes as the user's private field, the character/phase description boundary) — is the official skill of the `curator` role. A second official followed: `docs/official-skills/subagent-dispatch-guide/` — dispatch-brief composition standards for the `orchestrator` (per-role brief requirements; the curator section carries the inlined-source-material requirement, since the curator holds worldbook write tools only — sections accumulate as dispatch experience shows what each role's briefs need). Official skill sources live only under `docs/official-skills/`.

## Decision

### 1. Official skills are embedded, seeded, and discriminated by `kind`

Official skill source files live in the repo (`docs/official-skills/{name}/`), embedded at compile time (`include_str!` — paths relative to `official_skills.rs`; rustc tracks the included files in dep-info) and zipped in-process into the standard wrapper-dir layout, then validated through the SAME `parse_skill_zip` pipeline as uploads — app-shipped content gets no validation bypass. A static registry (`official_skills.rs`: fixed literal UUIDv7 id, name, `default_roles`, files) defines what ships.

`space.db` v14 adds `skills.kind` (`'user'` default | `'official'`). Official rows are seeded by `official_skills::seed_official_skills` inside `DbManager::open_space_conn_inner`, right after migrations — the single choke point every space-connection open routes through (this covers existing Spaces on upgrade, new Spaces at creation, and reopens after lock/close). Seeding is:

- **DB-only** (the spaces lock is held — same contract as the migrations themselves; no file IO),
- **best-effort**: per-def failures are logged (`warn`) and skipped, never propagated — a seeding hiccup must never make a Space unopenable; the next open retries,
- **transactional per def**: the skills row and its default junction rows commit atomically, so a mid-seed failure can never leave an official row that junction-once (below) would then never backfill.

Timestamps are the fixed far-future literal (`9999-12-31…`, the M007/M011 seed precedent) — deterministic across Spaces; `do_list_skills` pins officials first with `ORDER BY (kind = 'official') DESC, created_at, id`.

### 2. Undeletable + reserved names; default-on but toggleable

- `delete_skill` rejects `kind = 'official'` with the business error `SKILL_OFFICIAL_PROTECTED`; the pool UI renders no delete affordance for official rows. The user's lever over officials is per-role enablement, never existence.
- `upload_skill` rejects a parsed name held by an official skill with `SKILL_NAME_RESERVED` (inside the same closure as the INSERT — no check-then-insert window), so a user package can never shadow the app-seeded row. Plain user-user name collisions keep the raw UNIQUE error (house convention).
- Seeding also inserts the default junction rows (`agent_config_skills` for each `default_roles` entry, resolved by AgentConfig NAME so it works regardless of which seed path created the row). **Default-on is not locked-on**: the per-role Switch stays a normal Switch; disabling an official skill is the ordinary `set_skill_enabled` flow, and a user-disabled official stays disabled across reopens.

### 3. Junction-once seeding (the anti-resurrection rule)

Junction rows are seeded ONLY on first insert of the skills row. The row-exists branch only refreshes content — it never touches junctions. This is what makes re-seeding on every connection open safe: **reopening a Space is not a consent event** and must never resurrect a junction the user deliberately deleted.

Accepted limitation: adding a `default_role` to an ALREADY-seeded official skill (in a future app version) will not backfill — that requires an explicit migration. New official skills (new ids) seed normally everywhere.

### 4. Lazy materialization with self-heal (amends ADR-0043 §2's install-before-enable)

ADR-0043 §2: *"The install happens BEFORE the enablement row is recorded, so a failed install can never leave a skill reported as enabled but missing on disk."* Official skills deliberately record enablement at seed time WITHOUT installing — file IO is impossible inside the seeding choke point, and eager materialization for every Space × skill on every open would be wasted work for never-activated skills.

The invariant's **purpose** — never "reported enabled but broken at runtime" — is preserved differently: every consumer of the disk copy is DB-driven except `read_skill_entry`, which **self-heals**: on a missing install it looks up the official blob by name, installs it (the normal `install_skill` stash-dance, no lock held), and retries the read once. The first `activate_skill` is the designated install moment; a user-mangled install directory heals the same way. Known benign edges, accepted:

- `read_skill_file` called BEFORE activation on an unmaterialized official returns `null` (its lenient contract); the tool descriptions steer through `activate_skill` first.
- Two parallel first-activations of the same official (e.g. two curator dispatches in one orchestrator step) can race the stash-dance swap; on Windows the loser's rename fails transiently and the model's retry succeeds. Not serialized — the window is one activation per Space per app lifetime.
- The shell tool (when enabled) can observe `skills/` partially materialized. Cosmetic.

### 5. Content refresh: DB-only propagation (amends ADR-0043 §2's re-install-only clause)

ADR-0043 §2: *"after installation, the disk copy is the runtime truth and the DB plays no part in execution… Re-installation is the only propagation path."* Official rows are app-owned, so a changed embedded package UPDATES the stored blob at connection open (comparison by parsed entries — zip metadata churn doesn't count; a corrupted stored blob counts as divergence and is healed by the same UPDATE). Disk propagation stays re-enable-only: an enabled-and-installed official serves its installed copy until the user toggles it off and on. User rows are never touched by refresh.

### 6. Name collisions: the user row wins

If a Space already holds a USER skill with an official name (uploaded before the official shipped), seeding skips with a warning — never mutate or delete user data. The Space stays fully functional; `curator` simply has no default skill until the user removes their duplicate, after which the next open seeds the official normally (self-healing, not permanent).

## Consequences

**Positive:** app-shipped expertise reaches every Space with zero user action; curator writes entity fields to the app's own standards from the very first run; officials are first-class pool citizens (badged, sorted first) with the full progressive-disclosure runtime (catalog + `activate_skill`/`read_skill_file`, compaction exemption) unchanged; users keep complete per-role control; corrupted officials self-heal from the embedded source.

**Negative / accepted:** junction-once means future default-role expansion needs an explicit migration (§3); a content refresh does not auto-reinstall enabled copies (§5, documented behavior); the stale-disk window after a refresh persists until re-enable; concurrent first-activation can transiently fail once (§4); the `.opencode/skills/` authoring originals were removed — `docs/official-skills/` is the single source of truth for official skills; the compile-time validation (`frontmatter name == def name`) plus the registry unit tests are the guardrails (a moved/renamed source file fails the build loudly via `include_str!`).

**Manual invocation:** unchanged from ADR-0043 — natural language only; the curator's catalog lists the skill and it activates on relevance.

## References

- ADR-0043 (amended: §2 install-before-enable ordering and re-install-only propagation; unchanged: upload safety, progressive disclosure, compaction exemption, consent neutrality)
- ADR-0050 D7/D9 (the eleven-config topology; the M011 seed that guarantees `curator` exists before seeding runs)
- ADR-0007 (lock discipline — seeding is DB-only under the spaces lock)
