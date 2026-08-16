# ADR-0037: Notes agent access — prompt-gated static registration, outside grep corpus

**Status**: accepted.

## Context

Notes are the author's private working material (outlines, foreshadowing, inspiration — see CONTEXT.md "Notes"). The product requirement is that the agent may operate on notes **only when the user explicitly asks** — the agent must never browse, summarize, or "helpfully" organize notes unprompted. Notes also live under the "writing" nav section, not the worldbook, and are not one of the worldbook base entity types.

The current architecture has only static tool registration: `buildExplorerTools` / `buildWriterTools` compile a fixed `ToolSet` per role (`src/lib/tools/worldbook/index.ts`); there is no per-conversation or per-turn tool mounting mechanism. Once a tool is in the `ToolSet`, the model can see it; restraint is a prompt concern.

Meanwhile `grep` (ADR-0035) searches "all author-written text" across the 8 entity types. If notes joined the grep corpus, any ordinary conversation grep would surface note content as occurrence evidence — passive retrieval would silently break the "don't touch notes unprompted" rule.

## Decision

### 1. Register the note tools statically on both roles; enforce the unprompted-use ban in the system prompt

The note tools (read: `list_notes` tree query + `get_note`; write: `create_note` / `update_note` / `delete_note` — see ADR-0038 for the surface) are registered in **both** Explorer and Writer toolsets, like `grep` and `timeline_lookup` (shared section of both builders, not `systemTools()`).

- No dynamic tool-gating mechanism is introduced. That was considered and rejected: it is new architecture serving one feature, and the consent gate already covers the destructive half of the risk.
- Both role system prompts gain a hard rule (same wording in both roles): note tools are used **only** when the user explicitly asks to read, create, change, or delete notes — never proactively, never as "helpful" context gathering.
- Defense in depth stands even if the model drifts: `update_note` / `delete_note` are consent `always` and `create_note` is `configurable` (ADR-0025 taxonomy) — a drifted write attempt still hits the approval banner. Only drifted *reads* bypass the gate, and a read is non-destructive.

### 2. Notes are excluded from the grep corpus

`grep` continues to cover exactly the 8 worldbook entity types. Note content (and titles) never enter `grep` results. When the user explicitly asks to search their notes, the model uses `list_notes` (tree, names) and `get_note` (content) — which the user can see happening in the tool stream, unlike a grep hit surfacing note text in an ordinary answer.

> **Amendment** (design session, same day): the dedicated search path was activated immediately — a sixth note tool `grep_notes`, match-centric per ADR-0035's semantics (field-grouped matches, three-part snippets, 50-group pages with offset pagination, ASCII case folding), scoped to the notes table (note title + content; folder title). Consent `auto`, both roles, under the same prompt rule as every note tool. `grep`'s corpus remains untouched.

### 3. Scope: the ban is a behavioral rule, not a technical isolation

This is an ownership/privacy convention, not a security boundary. Notes live in `world.db` like every other World entity, ride along in `.sluver-world` export/import (ADR-0032), and are readable by any command that has the World open. Nothing here pretends otherwise.

## Consequences

- Zero new architecture: static registration, existing consent gate, existing prompt slot. The rule is enforced by prompt + consent gate, i.e. best-effort with a hard wall on destructive operations.
- A future reader will wonder why note tools exist if the agent is told not to use them — this ADR is the answer: the user's *explicit* request is the activation signal.
- If note search becomes a real ask later, the shape is a dedicated `search_notes`-style tool under the same prompt rule — not silently widening `grep`.
- Prompt wording is load-bearing: if the ban is dropped from a role's system prompt, both roles regain unprompted access to note reads and (subject to the gate) note writes. The rule must survive any role-prompt refactor.
