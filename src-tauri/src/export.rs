//! Pure-function module for rendering an in-memory [`ExportedNovel`] tree to
//! plain text (TXT) or EPUB.
//!
//! This module is intentionally free of any `crate::commands` / `crate::db` /
//! `tauri::` dependency: it takes plain data in and produces a `String` or
//! writes to a caller-supplied [`std::io::Write`] + [`std::io::Seek`] sink.
//! That purity makes it fully unit-testable in isolation — no Tauri runtime,
//! no SQLite, no filesystem. The IPC command
//! `commands::export_book::export_novel` (wired up in a downstream task) will
//! assemble an [`ExportedNovel`] from world-DB rows and call [`generate_txt`]
//! / [`generate_epub`], mapping [`ExportError`] onto `DbError::NovelExportFailed`.
//!
//! # Content model
//!
//! Scene `content` is **plain text** (CONTEXT.md), not markdown. Paragraphs are
//! delimited by blank lines. The TXT renderer joins scenes with a blank line;
//! the EPUB renderer wraps each paragraph in `<p>…</p>` inside a full XHTML
//! document (epub-builder writes chapter content verbatim — it does NOT wrap a
//! bare fragment in `<html>/<body>`).
//!
//! # EPUB backend
//!
//! Uses `epub-builder` 0.8 with the pure-Rust `zip-library` backend (no system
//! `zip` binary). epub-builder 0.8 depends on `zip ^6`; this coexists with our
//! direct `zip = "8"` dep (different major versions resolve as separate crates).
//!
use std::borrow::Cow;
use std::io::{Seek, Write};

use epub_builder::{EpubBuilder, EpubContent, ReferenceType, ZipLibrary};

// ─── constants ───────────────────────────────────────────────────────────────

/// Minimal stylesheet injected into every generated EPUB. epub-builder writes
/// this to `OEBPS/stylesheet.css`; each chapter XHTML document links it via
/// `<link rel="stylesheet" href="stylesheet.css"/>`.
const MINIMAL_CSS: &str =
    "body { font-family: serif; line-height: 1.6; margin: 5%; } h1, h2 { font-weight: bold; }";

/// Chapter separator drawn in the TXT output. A single horizontal rule of
/// `U+2550` (BOX DRAWINGS DOUBLE HORIZONTAL) — tasteful, unambiguous, and
/// survives any plain-text encoding that is UTF-8 (the only encoding we emit).
const TXT_CHAPTER_SEPARATOR: &str =
    "═══════════════════════════════════════";

/// EPUB language tag. Hard-coded to `zh-CN` for v1 since the app's primary
/// audience is Chinese-language worldbuilding/novel writing. A future task can
/// thread the novel's own locale through `ExportedNovel` if multilingual novels
/// need first-class support.
const EPUB_LANGUAGE: &str = "zh-CN";

/// Author placeholder when the novel has no author recorded. Most EPUB readers
/// want a creator element; an empty `<dc:creator>` is worse than a placeholder.
const UNKNOWN_AUTHOR: &str = "Unknown Author";

// ─── data model ─────────────────────────────────────────────────────────────

/// A fully-assembled novel ready to be rendered to TXT or EPUB.
///
/// This is an internal transfer type: it carries **no `#[serde]` derives**
/// because it never crosses the IPC boundary as-is. The IPC command builds it
/// from world-DB rows and immediately feeds it to [`generate_txt`] /
/// [`generate_epub`].
pub struct ExportedNovel {
    /// Novel title. Required; emitted as the document title in both formats.
    pub title: String,
    /// Author name. Empty string means "unknown" — the TXT renderer omits the
    /// "by …" line and the EPUB renderer substitutes [`UNKNOWN_AUTHOR`].
    pub author: String,
    /// Optional book description / blurb. Empty string → omitted in both
    /// formats.
    pub description: String,
    /// Ordered chapters. In EPUB these become `chapter_1.xhtml`,
    /// `chapter_2.xhtml`, … (1-based file naming).
    pub chapters: Vec<ExportedChapter>,
    /// Optional cover image. The EPUB renderer accepts `image/jpeg` /
    /// `image/png` (pass through) and `image/webp` (transcoded to PNG via
    /// [`transcode_webp_to_png`]); any other mime is silently skipped as
    /// defense-in-depth. Ignored by the TXT renderer — TXT has no notion of
    /// a cover.
    pub cover: Option<CoverImage>,
}

/// One chapter: a heading and ordered scenes.
pub struct ExportedChapter {
    /// Chapter heading. Rendered as `<h1>` in EPUB; sits under a separator
    /// rule in TXT.
    pub title: String,
    /// Ordered scenes within the chapter.
    pub scenes: Vec<ExportedScene>,
}

/// One scene: the prose body plus its ordered illustrations.
pub struct ExportedScene {
    /// Plain-text prose body (NOT markdown — CONTEXT.md). Paragraphs are
    /// delimited by blank lines; the EPUB renderer wraps each in `<p>`.
    pub content: String,
    /// Ordered scene illustrations. Rendered AFTER the prose paragraphs in
    /// EPUB (each becomes `<p><img .../></p>`), in order. Ignored by the TXT
    /// renderer. Empty vec → no illustrations.
    pub images: Vec<ExportedImage>,
}

/// Cover image payload. The caller is responsible for fetching/decoding the
/// bytes; this struct only carries the raw payload + mime.
pub struct CoverImage {
    /// Raw encoded image bytes (WebP/JPEG/PNG — see [`Self::mime`]).
    pub bytes: Vec<u8>,
    /// `"image/webp"`, `"image/jpeg"`, or `"image/png"`. JPEG/PNG are embedded
    /// as-is; WebP is transcoded to PNG by the EPUB renderer (EPUB readers
    /// have inconsistent WebP support). Any other mime is silently skipped.
    pub mime: String,
}

/// One scene illustration. The caller (IPC command) loads these from the
/// `scene_images` table (`image_blob` / `image_mime`, ordered by `position`).
/// JPEG/PNG are embedded directly in EPUB; WebP is transcoded to PNG; any
/// other mime is silently skipped (same gating as [`CoverImage`]).
pub struct ExportedImage {
    /// Raw encoded image bytes (WebP/JPEG/PNG — see [`Self::mime`]).
    pub bytes: Vec<u8>,
    /// `"image/webp"`, `"image/jpeg"`, or `"image/png"`. Other values →
    /// silently skipped.
    pub mime: String,
}

// ─── error type ─────────────────────────────────────────────────────────────

/// Errors raised by [`generate_epub`].
///
/// Kept module-local (NOT folded into `crate::db::DbError`) so this module
/// stays pure — no `crate::` import. The IPC command maps these variants to
/// `DbError::NovelExportFailed` (added in a downstream task).
///
/// `Io` is reserved for direct IO on the sink; in practice epub-builder wraps
/// all underlying IO failures into `epub_builder::Error`, which lands in
/// [`ExportError::EpubBuild`]. The variant is kept on the type for API
/// stability and future direct-streaming use.
#[derive(Debug)]
pub enum ExportError {
    /// `epub-builder` returned an error at any stage (metadata, content, zip,
    /// generate). The dynamic message is the only useful information.
    EpubBuild(String),
    /// WebP → PNG transcode failed (malformed WebP bytes, decode error, or PNG
    /// encode error). Carries a human-readable detail string.
    ImageTranscode(String),
    /// Raw IO error writing to the caller-supplied sink. Preserved so callers
    /// can distinguish infrastructure failures from EPUB-structure failures.
    /// Currently unused — epub-builder wraps all IO into `EpubBuild` — but kept
    /// for API stability and future direct-streaming use.
    #[allow(dead_code)]
    Io(std::io::Error),
}

impl std::fmt::Display for ExportError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExportError::EpubBuild(msg) => write!(f, "epub build failed: {msg}"),
            ExportError::ImageTranscode(msg) => write!(f, "image transcode failed: {msg}"),
            ExportError::Io(err) => write!(f, "io error during epub generation: {err}"),
        }
    }
}

impl std::error::Error for ExportError {}

/// Glue letting `?` convert epub-builder errors into [`ExportError::EpubBuild`]
/// at every fallible call site without per-call `.map_err` noise.
impl From<epub_builder::Error> for ExportError {
    fn from(err: epub_builder::Error) -> Self {
        ExportError::EpubBuild(err.to_string())
    }
}

// ─── TXT renderer ───────────────────────────────────────────────────────────

/// Render `novel` to a plain-text `String`.
///
/// Format (see module docs): title block (title / `by author` / description),
/// then one block per chapter separated by [`TXT_CHAPTER_SEPARATOR`]. Scene
/// illustrations are omitted (TXT is prose-only). Each scene's `content` is
/// trimmed and scenes are joined by a blank line. The result always ends with
/// a trailing newline.
///
/// Empty `author` → no "by" line. Empty `description` → omitted with its
/// trailing blank line. Empty `chapters` → just the title block.
pub fn generate_txt(novel: &ExportedNovel) -> String {
    let mut out = String::new();

    // Title block.
    out.push_str(&novel.title);
    out.push('\n');
    if !novel.author.trim().is_empty() {
        out.push_str("by ");
        out.push_str(&novel.author);
        out.push('\n');
    }
    if !novel.description.is_empty() {
        out.push_str(&novel.description);
        out.push('\n');
    }

    // Chapters.
    if !novel.chapters.is_empty() {
        // Blank line between the title block and the first separator.
        out.push('\n');
        for (idx, chapter) in novel.chapters.iter().enumerate() {
            if idx > 0 {
                // Blank line separating one chapter's last scene from the next
                // chapter's separator rule.
                out.push('\n');
            }
            out.push_str(TXT_CHAPTER_SEPARATOR);
            out.push('\n');
            out.push('\n');
            out.push_str(&chapter.title);
            out.push('\n');
            out.push('\n');
            // Concatenate scene bodies (trimmed), dropping empty scenes so we
            // don't emit stray blank-line runs.
            let bodies: Vec<&str> = chapter
                .scenes
                .iter()
                .map(|scene| scene.content.trim())
                .filter(|body| !body.is_empty())
                .collect();
            out.push_str(&bodies.join("\n\n"));
            out.push('\n');
        }
    }

    out
}

// ─── EPUB renderer ──────────────────────────────────────────────────────────

/// Render `novel` to an EPUB written into `w`.
///
/// `w` is consumed by value (epub-builder's `generate` takes the writer by
/// value). The bound matches the contract the IPC command will offer:
/// `Write + Seek` (the underlying epub-builder only needs `Write`, but
/// requiring `Seek` keeps the signature stable for any future backend and
/// every realistic sink — `File`, `Cursor`, `Vec<u8>` — implements both).
///
/// Metadata: title (always), author ([`UNKNOWN_AUTHOR`] if empty),
/// description (only if non-empty), language ([`EPUB_LANGUAGE`]). A cover image
/// is attached iff `novel.cover` is `Some` AND its mime is one of
/// `image/jpeg` / `image/png` / `image/webp`; JPEG/PNG pass through directly,
/// WebP is transcoded to PNG via [`transcode_webp_to_png`]. Any other mime is
/// silently skipped. An inline TOC page is inserted at the front so the reader
/// shows a navigable contents listing. Each chapter becomes one
/// `chapter_{i}.xhtml` (1-based) containing an `<h1>` title, then per-scene
/// paragraph-wrapped prose followed by any scene illustrations (each a
/// `<p><img .../></p>` referencing an embedded resource at
/// `images/ch{N}_sc{N}_{N}.{ext}`; JPEG/PNG pass through, WebP is transcoded
/// to PNG, non-recognized mimes are silently skipped).
pub fn generate_epub<W: Write + Seek>(novel: &ExportedNovel, w: W) -> Result<(), ExportError> {
    let zip = ZipLibrary::new()?;
    let mut builder = EpubBuilder::new(zip)?;

    // Metadata.
    builder.metadata("title", novel.title.as_str())?;
    let author = if novel.author.trim().is_empty() {
        UNKNOWN_AUTHOR.to_string()
    } else {
        novel.author.clone()
    };
    // Owned String — consumed by `metadata` (S2: Into<String>).
    builder.metadata("author", author)?;
    if !novel.description.trim().is_empty() {
        builder.metadata("description", novel.description.as_str())?;
    }
    builder.metadata("lang", EPUB_LANGUAGE)?;

    // Stylesheet — linked by every chapter XHTML document.
    builder.stylesheet(MINIMAL_CSS.as_bytes())?;

    // Cover image (jpeg/png pass through; webp transcoded to png; others skipped).
    if let Some(cover) = &novel.cover {
        match cover.mime.as_str() {
            "image/jpeg" => {
                builder.add_cover_image("cover.jpeg", cover.bytes.as_slice(), "image/jpeg")?;
            }
            "image/png" => {
                builder.add_cover_image("cover.png", cover.bytes.as_slice(), "image/png")?;
            }
            "image/webp" => {
                // Transcode WebP → PNG (EPUB readers have inconsistent WebP
                // support). The transcoded bytes replace the original; the
                // manifest path is `cover.png`.
                let png = transcode_webp_to_png(&cover.bytes)?;
                builder.add_cover_image("cover.png", png.as_slice(), "image/png")?;
            }
            _ => {
                // Truly unsupported mime — skip. Defense-in-depth.
            }
        }
    }

    // Inline TOC at the front. Position is determined by call order relative to
    // add_content: calling it BEFORE any add_content places the TOC page at the
    // beginning of the spine, which is the conventional location.
    builder.inline_toc();

    // Chapters — one XHTML document each (1-based file naming). The body is
    // built inline (rather than via a pure helper) because each scene image
    // needs a `builder.add_resource(...)` side effect mid-build, and a pure
    // body-building fn cannot touch `&mut builder`.
    for (ch_idx, chapter) in novel.chapters.iter().enumerate() {
        let chapter_num = ch_idx + 1; // 1-based
        let file_path = format!("chapter_{chapter_num}.xhtml");

        let mut body = String::new();

        // Chapter heading.
        body.push_str("<h1>");
        body.push_str(&escape_xhtml(&chapter.title));
        body.push_str("</h1>\n");

        // Per scene: prose paragraphs first, then illustrations (AFTER prose).
        for (sc_idx, scene) in chapter.scenes.iter().enumerate() {
            let paragraphs = text_to_xhtml_paragraphs(&scene.content);
            if !paragraphs.is_empty() {
                body.push_str(&paragraphs);
                body.push('\n');
            }

            for (img_idx, image) in scene.images.iter().enumerate() {
                // JPEG/PNG pass through (borrowed); WebP is transcoded to PNG
                // (owned); any other mime is silently skipped.
                let (embed_bytes, ext): (Cow<[u8]>, &str) = match image.mime.as_str() {
                    "image/jpeg" => (Cow::Borrowed(image.bytes.as_slice()), "jpeg"),
                    "image/png" => (Cow::Borrowed(image.bytes.as_slice()), "png"),
                    "image/webp" => {
                        let png = transcode_webp_to_png(&image.bytes)?;
                        (Cow::Owned(png), "png")
                    }
                    _ => continue,
                };
                let mime = if ext == "jpeg" { "image/jpeg" } else { "image/png" };
                // Unique path across the whole book. epub-builder places
                // resources under `OEBPS/` automatically, so the path is given
                // WITHOUT an `OEBPS/` prefix; the `<img src>` is relative and
                // resolves correctly from the sibling chapter document.
                let img_path = format!("images/ch{chapter_num}_sc{sc_idx}_{img_idx}.{ext}");
                body.push_str("<p><img src=\"");
                body.push_str(&img_path);
                body.push_str("\" alt=\"\"/></p>\n");
                builder.add_resource(img_path.as_str(), embed_bytes.as_ref(), mime)?;
            }
        }

        let xhtml = wrap_xhtml_document(&chapter.title, &body);
        let content = EpubContent::new(file_path.as_str(), xhtml.as_bytes())
            .title(chapter.title.as_str())
            .reftype(ReferenceType::Text);
        builder.add_content(content)?;
    }

    builder.generate(w)?;
    Ok(())
}

// ─── helpers ────────────────────────────────────────────────────────────────

/// Decode WebP bytes and re-encode as PNG.
///
/// Used by [`generate_epub`] to convert WebP covers / scene illustrations into
/// PNG before embedding — EPUB readers have inconsistent WebP support, so the
/// EPUB renderer only embeds JPEG/PNG resources. Rather than silently dropping
/// WebP images (the previous behavior, which caused images to vanish from
/// exports with zero diagnostic), this helper transcodes them to PNG at export
/// time.
///
/// Errors are mapped to [`ExportError::ImageTranscode`] with a stage-tagged
/// detail string (`"decode webp: …"` / `"encode png: …"`).
fn transcode_webp_to_png(webp_bytes: &[u8]) -> Result<Vec<u8>, ExportError> {
    let img = image::load_from_memory_with_format(webp_bytes, image::ImageFormat::WebP)
        .map_err(|e| ExportError::ImageTranscode(format!("decode webp: {e}")))?;
    let mut png_bytes = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut png_bytes), image::ImageFormat::Png)
        .map_err(|e| ExportError::ImageTranscode(format!("encode png: {e}")))?;
    Ok(png_bytes)
}

/// Wrap a pre-built `<body>` inner-HTML string in a complete XHTML document
/// scaffold: XML declaration, root `<html>` (XHTML namespace), `<head>` with a
/// `<title>` + stylesheet link, and `<body>` around `body`.
///
/// epub-builder writes the bytes passed to [`EpubContent::new`] **verbatim** —
/// it does not wrap a bare fragment in `<html>/<body>` — so every chapter must
/// be a full document. This helper is pure (no `&mut builder`), which keeps it
/// unit-testable; the caller ([`generate_epub`]) builds the `body` string
/// inline so it can register scene-image resources mid-build via
/// `builder.add_resource`.
///
/// `title` is escaped here for the `<title>` element. The caller is responsible
/// for escaping any user text it places into `body`.
fn wrap_xhtml_document(title: &str, body: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <html xmlns=\"http://www.w3.org/1999/xhtml\">\n\
         <head>\n\
         \x20<title>{title}</title>\n\
         \x20<link rel=\"stylesheet\" type=\"text/css\" href=\"stylesheet.css\"/>\n\
         </head>\n\
         <body>\n\
         {body}\
         </body>\n\
         </html>\n",
        title = escape_xhtml(title),
    )
}

/// Escape the five XML-significant characters for safe inclusion in XHTML
/// text content / attribute values.
///
/// `&` is rewritten first (the entity introducer — if it were not first, the
/// `&` produced by escaping `<` would itself be re-escaped). Order matters:
/// `&` → `&amp;` → `<` → `&lt;` → `>` → `&gt;` → `"` → `&quot;` → `'` →
/// `&#39;`.
fn escape_xhtml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

/// Convert plain-text prose into `<p>…</p>` XHTML paragraphs.
///
/// The input is first trimmed (leading/trailing blank lines collapse). The
/// trimmed text is split into paragraphs on **blank-line** boundaries: a blank
/// line is any line whose trimmed form is empty (so `\n\n`, `\n   \n`, and
/// `\n\n\n` all separate paragraphs the same way). Consecutive non-blank lines
/// are joined with `\n` inside a single `<p>` (whitespace collapsing in XHTML
/// renders them as one paragraph). Each paragraph's text is escaped via
/// [`escape_xhtml`]. Paragraphs are joined with `\n`.
///
/// Edge cases: empty input → empty string (no `<p></p>`); whitespace-only
/// input → empty string.
fn text_to_xhtml_paragraphs(text: &str) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    // Group consecutive non-blank lines into paragraphs; a line whose trimmed
    // form is empty terminates the current group.
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in trimmed.lines() {
        if line.trim().is_empty() {
            if !current.is_empty() {
                paragraphs.push(current.join("\n"));
                current.clear();
            }
        } else {
            current.push(line);
        }
    }
    if !current.is_empty() {
        paragraphs.push(current.join("\n"));
    }

    paragraphs
        .iter()
        .map(|p| format!("<p>{}</p>", escape_xhtml(p)))
        .collect::<Vec<_>>()
        .join("\n")
}

// ─── tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
#[path = "tests/export.rs"]
mod tests;
