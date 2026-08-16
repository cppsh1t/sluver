# ADR-0038: Notes — single-table tree storage, no position UNIQUE

**Status**: accepted.

## Context

Notes need an arbitrarily deep Folder/Note tree in `world.db` (Notes are World-scoped per CONTEXT.md). The codebase has **no self-referential adjacency list anywhere** — all hierarchy is fixed-depth via distinct parent tables (novels→chapters→scenes, characters→phases, scenes→scene_images). This is the first arbitrary-depth tree.

Two position conventions coexist with documented rationale: chapters/scenes/phases enforce `UNIQUE(parent, position)` and pay the temporary-shift dance on reorder (`position + 1000000`, then per-row write-back — `reorder_chapters`); `scene_images` deliberately skips the constraint (M8 comment in `migrations.rs`: the per-row update path would need the dance, and a plain index is sufficient). Also a SQLite quirk: `UNIQUE(parent_id, title)` does not dedupe root-level siblings (`NULL ≠ NULL`), leaving the root scope unrestricted.

Agent access policy (prompt-gated, grep corpus exclusion) is ADR-0037; this ADR covers storage shape and the tool surface.

## Decision

### 1. One `notes` table with a `kind` discriminator

```sql
CREATE TABLE IF NOT EXISTS notes (
    id         TEXT PRIMARY KEY,
    parent_id  TEXT REFERENCES notes(id) ON DELETE CASCADE,  -- NULL = root
    kind       TEXT NOT NULL CHECK (kind IN ('folder','note')),
    title      TEXT NOT NULL,
    content    TEXT NOT NULL DEFAULT '',   -- folders: always ''
    position   INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
```

Rejected: separate `note_folders` + `note_documents` tables. The codebase instinct is one-table-per-concept, but Folder is a structural node (pure container, no shape of its own), and sibling title uniqueness must span folders and notes alike — filesystem intuition: a folder "大纲" and a note "大纲" under the same parent must collide — which SQLite cannot enforce across two tables without a racy app-layer check. Single table makes the tree query one `SELECT ... ORDER BY position` with client-side grouping (the `list_x` no-N+1 convention).

### 2. Sibling title uniqueness via NULL-safe expression index

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_sibling_title ON notes(IFNULL(parent_id,''), title);
CREATE INDEX IF NOT EXISTS idx_notes_parent_pos ON notes(parent_id, position);
```

The `IFNULL` form covers the root scope too. Display label is `title`, not `name` — notes belong to the writing family (Novel/Chapter/Scene all use `title`), not the worldbook `name` family.

### 3. No `UNIQUE(parent, position)` — the scene_images precedent

The note tree is dragged on **two axes**: same-parent reorder AND cross-parent move. A reparent is two position shifts (old parent shrinks, new parent appends); under a UNIQUE constraint each shift becomes a temporary-shift dance, sequenced to avoid mid-flight collisions. Position truth is maintained at the application layer: `reorder_notes(space_id, world_id, parent_id, ids: Vec<String>)` takes the complete sibling list and writes `position = index` (the established reorder contract); the app is desktop, single-user, one Space per window (ADR-0011) — no concurrent writers to race.

### 4. Cycle prevention at the application layer

Moving a folder under itself or its descendant is rejected by walking the ancestor chain before the move — SQLite cannot express this constraint. First self-referential table in the codebase; standard ancestor-walk, performed inside the move's transaction.

### 5. Deletion leaves position gaps — no renumbering

Gaps are harmless under `ORDER BY position`; delete-then-renumber is a pointless write burst. `reorder_notes` is the single renumbering path.

### 6. Agent surface: six tools; structural moves stay UI-only in v1

| Tool | Consent | Shape |
|---|---|---|
| `list_notes` | auto | full tree as nodes `{id, kind, title, position, parentId}` — no content |
| `get_note` | auto | one note incl. content |
| `grep_notes` | auto | ADR-0035 semantics scoped to notes: match groups over note title + note content + folder title; groups carry `path` (ancestor titles joined `/`) because note titles repeat and tree position is semantic; 50-group offset pages, three-part snippets, ASCII folding |
| `create_note` | configurable | `parentId` + `title` + `content`; parent-exists pre-check → business `NotFound` (the scene-image precedent, not an opaque FK error) |
| `update_note` | always | read-merge-write per `update_character`; **title/content only — never parentId/position** |
| `delete_note` | always | best-effort snapshot return per `delete_character` (feeds the delete-preview card; stripped from model input by `stripDeleteSnapshots`) |

The agent cannot reorder or reparent notes in v1 (not requested); the UI's move/reorder commands are where §4 cycle detection lives. Both roles receive all six tools under ADR-0037's prompt rule.

## Consequences

- `WORLD_MIGRATION_011` adds the table + both indexes; `commands/note.rs` + `models/note.rs` follow the novel.rs templates; `.sluver-world` export/import (ADR-0032) picks notes up as ordinary world.db rows — no format change.
- Duplicate-title violations currently surface as `INTERNAL_ERROR` with a raw SQLite message (`DbError` has no `DuplicateName` variant). A friendly duplicate-title error needs a new variant + `errors.json` keys in both locales — deferred until asked for.
- `delete_note` on a folder cascades to all descendants; the UI must show the ADR-0006-style pre-delete disclosure (count of notes/folders inside).
- If a future feature needs DB-enforced position uniqueness (e.g. multi-writer sync), migrating to the chapters-style index + temp-shift reorder is additive — the application-layer renumbering contract does not change.
