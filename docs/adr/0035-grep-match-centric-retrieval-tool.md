# ADR-0035: `grep` — match-centric full-corpus retrieval tool

**Status**: accepted.

## Context

The agent already has 8 per-entity `search_*` tools (SQL `LIKE` substring match via `world_search.rs`). They are **entity-centric**: one call per entity type, returning entity summaries — no match location, no context snippet, no cross-entity sweep. Two jobs they structurally cannot serve:

1. **Writing retrospection** — "「断剑重铸」这个意象我在哪几个场景写过?" needs occurrence-level evidence (snippet + where), not a scene ID the model must then fetch in full.
2. **Global consistency** — "哪些实体的描述里提过「北境」?" needs one call across all entity types; today that is 8 tool calls.

Regex was considered and rejected: SQLite `LIKE` has no regex, FTS5 has Chinese-tokenization problems (the primary language of this app's content), and full-table Rust-side filtering doesn't scale with library size. Substring covers the dominant use cases.

## Decision

### 1. One tool named `grep`, with an `entityTypes` filter

```
grep(query: string, entityTypes?: EntityType[])
```

- The name itself teaches the model the semantics — occurrence-centric, context-carrying, distinct from entity discovery. Models have a strong grep prior; `search_all` / `find_mentions` would need the semantics explained from scratch.
- Omitting `entityTypes` searches the full corpus (job 2); `["scene"]` narrows to prose (job 1's most common shape). No field-level filter — follow up with `get_*` instead (YAGNI).
- The 8 `search_*` tools stay untouched. Entity discovery is a different job; the `grep` description states the division of labor explicitly ("find entities with search_*; find where text occurs with grep").

### 2. Corpus: all author-written text, including the Phase blind spot

All author-written text fields of the 8 entity types, **including the four `CharacterPhase` fields** (`name`, `appearance`, `description`, `conversation_style`) — an independent table that the existing `search_characters` does not cover. Excluded: IDs, timestamps (`start_at`/`end_at` — not creative text, and entity discovery already handles them), and system fields. Tags match per-element (deserialized from their JSON TEXT storage, never raw `LIKE` — raw matching would hit JSON syntax noise).

### 3. Match record: field-grouped

Results group by `(entityType, entityId, fieldName)`. Each group carries `matchCount`, up to 3 snippets, and redundant entity identity (`entityTitle`; plus `characterId` + `characterName` for phase hits) so the model can act without a second `get_*` call. `entityId` is always directly usable by the `get_*` family — phase hits are `entityType: "phase"` with `entityId = phaseId`, not an overloaded `character` + non-null `phaseId` encoding.

- Not occurrence-level: a protagonist name appearing 50× in one scene would produce 50 records and burn the result budget.
- Not mixed granularity: two semantics in one response burden the model. `matchCount` preserves the "mentioned 50 times" signal; 3 snippets suffice to judge context; more → `get_scene`.

### 4. Snippet: three-part `{before, match, after}`, 40 chars per side

Character-based truncation (UTF-8 boundary safe on the Rust side), no `...`/`【】` marker glyphs — markers collide with characters that occur in prose and mislead the model.

### 5. Return package: 50 groups per page, `matchCount` desc, deterministic tie-break, `offset` pagination

> **Amendment** (after real-world use): the original design was a hard 50-group cap with a `truncated` flag. Common queries (a protagonist's name matches hundreds of fields) reached the cap trivially, and raising it was rejected — a 50-group page already carries up to ~25K chars of snippets into the model's context, and a bigger cap just moves the wall while bloating every hot query. Completeness is served by pagination instead: `offset` walks pages of 50, and the deterministic total order (matchCount desc → entity-type order → title → entity id) is precisely what makes offset pagination correct — same input → same ordering → stable pages the model can walk (0, 50, 100, …) when `truncated` reports more. Concurrent edits between page fetches can shift boundaries — inherent to any offset scheme, acceptable at desktop scale.

`truncated: true` when `offset + groups.length < groupCount` (more pages exist); `groupCount` remains the FULL count. Same input → same output: reproducibility lets the model diff two greps across turns.

### 6. Matching: ASCII case folding only

SQL `LIKE` folds ASCII case only (`Aria` ≈ `aria`; Cyrillic/Greek do not fold). The Rust scan side applies the identical ASCII folding so the SQL prefilter and the in-memory count/snippet pass have **zero false negatives** between them. No Unicode-case-folding promise the stack can't keep; behavior identical to the existing `search_*` tools.

### 7. Consent `auto`; both roles; logging red line

- `consentLevel: "auto"` — pure read-only, same classification as `search_*` (ADR-0025).
- Explorer and Writer both receive `grep` (shared section of both toolset builders in `worldbook/index.ts`, not `systemTools()` — it spans all domain types).
- ADR-0016 NEVER-log applies: the query may be verbatim prose and snippets are content fragments, so neither is ever logged. `#[tracing::instrument(skip(state, query), ...)]`; log only `group_count`, `truncated`, `entity_types`. Follows the `world_search.rs` precedent ("The query itself is never logged").

### 8. `GrepToolCard`: read-only, no navigation in v1

A dedicated renderer in `src/components/chat/tool-cards/`, routed from the `ToolCard` dispatcher (4th special case after `plan` / `get_chapter_overview` / `timeline_lookup`). Collapsed: one-line summary (`query` · N 组命中). Expanded: per-group rows (entity icon, title, field badge, ×count) with snippets — `match` highlighted in primary, `before`/`after` in muted foreground, no new color tokens. Groups keep tool order (`matchCount` desc); card body scrolls (`max-height + overflow-y-auto` precedent). Defensive narrowing from `unknown` output; malformed rows skipped, never thrown.

No click-through to entity editors: Scenes are not deep-linkable (ADR-0021), no in-chat navigation routes exist, and all three existing special-case cards are read-only. Group rows already carry entity IDs, so navigation can be added later without contract change.

## Consequences

- New Rust command surface (`commands/grep.rs`): per-table SQL `LIKE` prefilter + in-memory Rust scan for counting and snippet extraction. The TS tool wrapper lives alongside the worldbook tools but registers in both role builders.
- JSON-array columns (`aliases` / `tags`) prefilter via `json_each` ELEMENT matching, not raw column `LIKE` — serde-escaped element text (`\"`, `\\`) would make a query spanning those characters miss the row at the prefilter stage, breaking the zero-false-negative invariant of §6. A `json_valid` CASE guard degrades malformed JSON to an empty array so corrupt rows never error the statement.
- `search_*` remain the entity-discovery path. If the `grep` description fails to state the division of labor, models will double-call both for the same question — the description is load-bearing.
- Regex could later be added as an opt-in mode without breaking this contract; the substring contract is the v1 guarantee.
