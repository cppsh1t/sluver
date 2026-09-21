---
name: subagent-dispatch-guide
description: "How the Orchestrator composes dispatch_subagent task briefs. A subagent run shares no memory — the brief is the ONLY context a specialist receives — so each brief must carry everything that role needs in one pass. Role-specific sections state what that role's briefs must include; the curator's section covers inlined source material, inlined explorer findings, and authoring intent (the curator holds worldbook write tools only). More roles accumulate here over time. Activate this skill when composing a dispatch_subagent task brief."
---

# Subagent Dispatch Guide

Every `dispatch_subagent` call launches a fresh one-shot run: the specialist sees only the task brief you compose — never this conversation, never another run. The brief is the complete specification of the job; a run that lacks material cannot ask for more. This guide states what a complete brief carries, per role.

## What every brief carries

- **Objective** — the outcome the run must produce, concrete enough to verify against (e.g. "create the character entries for the cast listed below, one phase per life period mentioned").
- **Scope** — what is in this run's hands and what is not; boundaries the specialist should respect rather than guess at.
- **Source material** — the facts, text, and findings the work draws on, inlined into the brief itself (the per-role sections below define what that means for each specialist).
- **Ids and names** — every entity id and name the specialist must act on or reference, gathered by you from earlier runs and the conversation so far.
- **Constraints and expectations** — requirements the result must satisfy: style, coverage, language, length, ordering.

Sibling dispatches in one step run concurrently and cannot see each other: when several briefs share material, each carries its own copy.

## curator — the worldbook author

The curator writes entity field content (characters and their phases, locations, items, lore, events). Its toolset is worldbook CRUD: it can look up and read the existing worldbook itself, and carries no novel-side reads, no corpus search, and no web. Everything beyond the existing worldbook rides the brief:

- **Source material, inlined.** When entities are drawn from prose or reference material — a chapter, a scene excerpt, a character sheet the user pasted — quote that material in the brief (the relevant excerpt in full; the whole text when density matters). The curator cannot fetch it: a brief that only names the source leaves the curator with nothing to write from.
- **Explorer findings, inlined.** Creation briefs follow an explorer survey; carry its findings forward — existing entities to update (with ids), near-duplicates to keep distinct, related entities and their ids that references should point to.
- **Authoring intent.** Which entities to create or update, roughly the coverage each should have (full archive from the material vs. a quick stub), and any user decisions already made (naming, merging, what counts as canon). The curator distills worldbook reference entries from material; your intent frames that work.
- **What comes back.** The curator's report lists what was created, updated, or deleted with ids, approvals that were denied, and anything left undone — route the ids into later briefs and relay the open items to the user.

## Roles without a section yet

Apply the general anatomy above, and when in doubt inline more context: each specialist sees exactly one brief, and material left out of it does not exist for that run.
