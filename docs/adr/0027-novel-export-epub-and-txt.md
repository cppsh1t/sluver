# ADR-0027: Novel Export as EPUB and TXT (Rust-side generation, no MOBI)

**Status**: accepted.

## Context

A finished Novel (Novel, Chapters, Scenes) needs to leave the app as a portable file for reading and sharing outside sluver, in a format any e-reader can open. Two facts already fixed in the codebase constrain the content source. First, `Scene.content` is plain text by design (CONTEXT.md), not markdown, so the generator has to wrap each paragraph in `<p>` tags itself rather than hand off to a markdown-to-HTML converter. Second, cover art already lives on the `novels` table as the `image_blob` / `image_mime` pair added in WORLD_MIGRATION_006, reachable through the existing `get_novel_image` IPC command.

The mechanical shape of the feature follows a precedent already in the app: `export_logs` (ADR-0015). There, the frontend picks an output path through the `save()` dialog from `@tauri-apps/plugin-dialog`, Rust writes the file with `std::fs` inside the command handler, and the command returns `Result<(), DbError>`. This ADR records the decision to reuse that exact contract for book export instead of introducing a new file-write mechanism on the frontend.

MOBI is excluded on purpose. Amazon deprecated it across the board: KDP stopped accepting MOBI for reflowable titles on 2021-06-28, Send-to-Kindle stopped delivering it in 2022-08, and KDP stopped accepting it for fixed-layout books on 2025-03-18. EPUB is now the one format every major reader accepts, including Kindle via Send-to-Kindle (since April 2022), Apple Books, Kobo, and Google Play Books. AZW3 (KF8) only matters for USB sideload to pre-2012 Kindles, a shrinking edge case.

## Decision

The export format set is EPUB plus TXT, nothing else. MOBI is dropped outright; it carries no remaining value for new content. AZW3 is deferred to a hypothetical v2 if real USB-sideload demand shows up, and even then the plan would be to convert the same generated EPUB through the `kindling-mobi` crate rather than maintain a second generator. TXT stays as the zero-dependency fallback for readers, plain-text archives, and copy-paste workflows.

Generation happens Rust-side, not in the webview. The `epub-builder` crate (0.8, MPL-2.0) writes the file from a single aggregated in-memory tree, and the frontend's only job is to pick the output path via `save()`. This avoids shipping the full novel tree plus cover bytes across IPC into the webview, keeps one source of truth, and reuses the `export_logs` contract. It also costs nothing in zip machinery, because `epub-builder` sits on top of the same `zip` crate already in `Cargo.toml` for `export_logs`. A single `export_novel` aggregation command fetches the Novel row, every Chapter ordered by `position`, every Scene ordered by `position`, and the cover bytes inside one `with_world` closure, which removes the N+2 IPC round-trips a naive frontend-orchestrated approach would incur. The DB lock is released before any file I/O touches disk.

The TXT and EPUB generation logic lives in a new `src-tauri/src/export.rs` module as pure functions over an in-memory `ExportedNovel` struct. No database access, no Tauri state. The IPC command in `commands/export_book.rs` is a thin orchestrator that builds the struct and calls the generator, and keeping the generator pure makes it unit-testable without a Tauri runtime. Two authoring-time decisions round out the design. `Novel.author` becomes a permanent column (`novels.author`, WORLD_MIGRATION_009, `TEXT NOT NULL DEFAULT ''`) rather than a throwaway export-dialog input, editable in the Novel form and reused as the EPUB `<dc:creator>`. Cover embedding is gated on MIME type: only `image/jpeg` and `image/png` covers are embedded in v1. WebP covers are silently omitted, because `epub-builder` does not accept WebP and format conversion is out of scope for v1.

## Consequences

The shape is a net win on simplicity and correctness, with a few accepted costs.

**Positive:**

- One IPC call per export. The webview never sees the full tree or the cover bytes.
- Pure generators in `export.rs` are unit-testable without a Tauri runtime or a real World database.
- No new frontend file-write mechanism; the `export_logs` contract is reused verbatim.
- EPUB output lands on every major reader, Kindle included via Send-to-Kindle.
- `Novel.author` becomes a first-class editable attribute, useful for display and future sorting and search, not just export.

**Negative:**

- One new world migration (009) and one new Cargo dependency (`epub-builder` 0.8, MPL-2.0). MPL-2.0 is file-level copyleft, compatible with the closed-source desktop app.
- The command is synchronous, so a large novel briefly blocks the IPC thread. This matches `export_logs`; an async upgrade is a future option if latency ever bites.
- WebP covers do not appear in exported EPUBs in v1. Users can re-save covers as PNG or JPEG.
- No MOBI. Users with pre-2012 Kindles who cannot use Send-to-Kindle must convert externally (Calibre). Documented in the user-facing help text.

## References

- [ADR-0015 — Unified log file with export-time Space filtering](./0015-unified-log-file-with-export-filter.md) — the `export_logs` IPC contract this feature reuses.
- [CONTEXT.md](../../CONTEXT.md) — `Scene.content` is plain text by design.
- `WORLD_MIGRATION_006` in [`src-tauri/src/db/migrations.rs`](../../src-tauri/src/db/migrations.rs) — `novels.image_blob` / `novels.image_mime` cover columns.
- [Amazon KDP — MOBI deprecation notice](https://kdp.amazon.com/help/topic/GULSQMHU5MNH4EZM)
