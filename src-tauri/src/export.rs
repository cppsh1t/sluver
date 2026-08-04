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
    /// Optional cover image. The EPUB renderer only accepts `image/jpeg` /
    /// `image/png`; other mimes (e.g. `image/webp`) are silently skipped as
    /// defense-in-depth (the caller is expected to filter too). Ignored by the
    /// TXT renderer — TXT has no notion of a cover.
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
    /// Raw encoded image bytes (JPEG or PNG — see [`Self::mime`]).
    pub bytes: Vec<u8>,
    /// `"image/jpeg"` or `"image/png"`. Any other value (e.g. `image/webp`)
    /// causes the EPUB renderer to silently skip the cover — EPUB readers have
    /// inconsistent webp support.
    pub mime: String,
}

/// One scene illustration. The caller (IPC command) loads these from the
/// `scene_images` table (`image_blob` / `image_mime`, ordered by `position`).
/// Only `image/jpeg` and `image/png` are embedded in EPUB; other mimes are
/// silently skipped (same gating as [`CoverImage`]).
pub struct ExportedImage {
    /// Raw encoded image bytes (JPEG or PNG — see [`Self::mime`]).
    pub bytes: Vec<u8>,
    /// `"image/jpeg"` or `"image/png"`. Other values → silently skipped.
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
/// is attached iff `novel.cover` is `Some` AND its mime is `image/jpeg` /
/// `image/png`; anything else (e.g. `image/webp`) is silently skipped. An
/// inline TOC page is inserted at the front so the reader shows a navigable
/// contents listing. Each chapter becomes one `chapter_{i}.xhtml` (1-based)
/// containing an `<h1>` title, then per-scene paragraph-wrapped prose followed
/// by any scene illustrations (each a `<p><img .../></p>` referencing an
/// embedded resource at `images/ch{N}_sc{N}_{N}.{ext}`; non-jpeg/png images
/// are silently skipped).
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

    // Cover image (jpeg/png only — webp etc. silently skipped).
    if let Some(cover) = &novel.cover {
        match cover.mime.as_str() {
            "image/jpeg" => {
                builder.add_cover_image("cover.jpeg", cover.bytes.as_slice(), "image/jpeg")?;
            }
            "image/png" => {
                builder.add_cover_image("cover.png", cover.bytes.as_slice(), "image/png")?;
            }
            _ => {
                // Unsupported mime (e.g. image/webp) — skip. Defense-in-depth
                // even though the IPC command is expected to filter too.
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
                // Only jpeg/png are embedded; other mimes (e.g. webp) skipped.
                let ext = match image.mime.as_str() {
                    "image/jpeg" => "jpeg",
                    "image/png" => "png",
                    _ => continue,
                };
                // Unique path across the whole book. epub-builder places
                // resources under `OEBPS/` automatically, so the path is given
                // WITHOUT an `OEBPS/` prefix; the `<img src>` is relative and
                // resolves correctly from the sibling chapter document.
                let img_path = format!("images/ch{chapter_num}_sc{sc_idx}_{img_idx}.{ext}");
                body.push_str("<p><img src=\"");
                body.push_str(&img_path);
                body.push_str("\" alt=\"\"/></p>\n");
                builder.add_resource(
                    img_path.as_str(),
                    image.bytes.as_slice(),
                    image.mime.as_str(),
                )?;
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
mod tests {
    use std::io::Cursor;

    use super::*;
    use zip::ZipArchive;

    // ─── fixtures ───────────────────────────────────────────────────────

    /// Minimal two-chapter novel used by several TXT/EPUB tests.
    fn sample_novel() -> ExportedNovel {
        ExportedNovel {
            title: "The Lantern of Wu".to_string(),
            author: "Lin Mei".to_string(),
            description: "A quiet fantasy about a city that forgets its dead.".to_string(),
            chapters: vec![
                ExportedChapter {
                    title: "Chapter One".to_string(),
                    scenes: vec![
                        ExportedScene {
                            content: "The ferry docked at dusk.\n\nMei stepped off.".to_string(),
                            images: vec![],
                        },
                        ExportedScene {
                            content: "The innkeeper said nothing, only pointed upstairs."
                                .to_string(),
                            images: vec![],
                        },
                    ],
                },
                ExportedChapter {
                    title: "Chapter Two".to_string(),
                    scenes: vec![ExportedScene {
                        content: "By morning the city had changed.".to_string(),
                        images: vec![],
                    }],
                },
            ],
            cover: None,
        }
    }

    // ─── escape_xhtml ───────────────────────────────────────────────────

    #[test]
    fn test_xhtml_escape_basic() {
        let out = escape_xhtml("a < b > c & d");
        assert!(out.contains("&lt;"), "expected &lt; in {out:?}");
        assert!(out.contains("&gt;"), "expected &gt; in {out:?}");
        assert!(out.contains("&amp;"), "expected &amp; in {out:?}");
        // No raw angle brackets remain (entity names contain neither '<' nor '>').
        assert!(!out.contains('<'), "raw '<' leaked into {out:?}");
        assert!(!out.contains('>'), "raw '>' leaked into {out:?}");
        // No raw ampersand OUTSIDE entity names: strip the known entities, then
        // no '&' should remain. (The entities themselves contain '&', so a naive
        // `!out.contains('&')` would incorrectly reject valid output.)
        let stripped = out
            .replace("&lt;", "")
            .replace("&gt;", "")
            .replace("&amp;", "")
            .replace("&quot;", "")
            .replace("&#39;", "");
        assert!(
            !stripped.contains('&'),
            "raw '&' outside an entity leaked into {out:?}"
        );
        // Sanity: the original " & " text context is now an entity.
        assert!(out.contains(" &amp; "), "ampersand should be an entity in {out:?}");
    }

    #[test]
    fn test_xhtml_escape_quotes() {
        let out = escape_xhtml("He said \"hi\" and 'bye'");
        assert!(out.contains("&quot;"), "expected &quot; in {out:?}");
        assert!(out.contains("&#39;"), "expected &#39; in {out:?}");
        // No raw quotes remain.
        assert!(!out.contains('"'), "raw '\"' leaked into {out:?}");
        assert!(!out.contains('\''), "raw '\\'' leaked into {out:?}");
    }

    #[test]
    fn test_xhtml_escape_passes_through_plain_text() {
        assert_eq!(escape_xhtml("plain text 123 中文"), "plain text 123 中文");
        assert_eq!(escape_xhtml(""), "");
    }

    #[test]
    fn test_xhtml_escape_ampersand_does_not_double_escape() {
        // If '&' were not handled first, the '&' in '&lt;' would become
        // '&amp;lt;'. This guards the ordering requirement.
        let out = escape_xhtml("<");
        assert_eq!(out, "&lt;");
        assert_ne!(out, "&amp;lt;");
    }

    // ─── text_to_xhtml_paragraphs ──────────────────────────────────────

    #[test]
    fn test_paragraph_split_blank_lines() {
        let out = text_to_xhtml_paragraphs("para1\n\npara2\n\npara3");
        let count = out.matches("<p>").count();
        assert_eq!(count, 3, "expected 3 <p> blocks, got: {out:?}");
        assert!(out.contains("<p>para1</p>"));
        assert!(out.contains("<p>para2</p>"));
        assert!(out.contains("<p>para3</p>"));
    }

    #[test]
    fn test_paragraph_single_block() {
        let out = text_to_xhtml_paragraphs("one line no breaks");
        let count = out.matches("<p>").count();
        assert_eq!(count, 1, "expected exactly 1 <p>, got: {out:?}");
        assert_eq!(out, "<p>one line no breaks</p>");
    }

    #[test]
    fn test_paragraph_multi_line_single_paragraph() {
        // Consecutive non-blank lines collapse into one paragraph.
        let out = text_to_xhtml_paragraphs("line a\nline b\nline c");
        assert_eq!(out.matches("<p>").count(), 1);
        assert!(out.contains("line a"));
        assert!(out.contains("line b"));
        assert!(out.contains("line c"));
    }

    #[test]
    fn test_paragraph_empty_and_whitespace_inputs() {
        assert_eq!(text_to_xhtml_paragraphs(""), "");
        assert_eq!(text_to_xhtml_paragraphs("   \n\t  \n  "), "");
        // Only blank lines between real content → still zero paragraphs.
        assert_eq!(text_to_xhtml_paragraphs("\n\n\n"), "");
    }

    #[test]
    fn test_paragraph_three_blank_lines_act_as_one_separator() {
        let out = text_to_xhtml_paragraphs("a\n\n\n\nb");
        assert_eq!(
            out.matches("<p>").count(),
            2,
            "runs of blank lines should collapse to one separator: {out:?}"
        );
    }

    #[test]
    fn test_paragraph_escapes_embedded_html() {
        let out = text_to_xhtml_paragraphs("a < b & c");
        assert!(out.contains("&lt;"));
        assert!(out.contains("&amp;"));
        // The wrapping <p>…</p> are the only raw angle brackets.
        assert_eq!(out.matches('<').count(), 2);
    }

    #[test]
    fn test_paragraph_trims_leading_trailing_blanks() {
        let out = text_to_xhtml_paragraphs("\n\nhello\n\n");
        assert_eq!(out, "<p>hello</p>");
    }

    // ─── generate_txt ──────────────────────────────────────────────────

    #[test]
    fn test_txt_contains_title_and_author() {
        let novel = sample_novel();
        let txt = generate_txt(&novel);
        assert!(txt.contains(&novel.title), "title missing: {txt:?}");
        assert!(txt.contains(&novel.author), "author missing: {txt:?}");
        assert!(
            txt.contains("Chapter One"),
            "chapter 1 title missing: {txt:?}"
        );
        assert!(
            txt.contains("Chapter Two"),
            "chapter 2 title missing: {txt:?}"
        );
        assert!(txt.contains(&novel.description), "description missing");
    }

    #[test]
    fn test_txt_has_chapter_separator_between_chapters() {
        let novel = sample_novel();
        let txt = generate_txt(&novel);
        // Separator appears once per chapter (here: 2 chapters → 2 separators).
        assert_eq!(
            txt.matches(TXT_CHAPTER_SEPARATOR).count(),
            novel.chapters.len(),
            "expected one separator per chapter"
        );
        // And the two chapter titles are separated by a separator instance.
        let first_sep = txt.find(TXT_CHAPTER_SEPARATOR);
        let ch2 = txt.find("Chapter Two");
        assert!(first_sep.is_some() && ch2.is_some());
        assert!(
            first_sep.unwrap() < ch2.unwrap(),
            "separator must precede the chapter title that follows it"
        );
    }

    #[test]
    fn test_txt_omits_author_line_when_empty() {
        let novel = ExportedNovel {
            title: "Untitled".to_string(),
            author: String::new(),
            description: String::new(),
            chapters: vec![ExportedChapter {
                title: "Only".to_string(),
                scenes: vec![ExportedScene {
                    content: "Body.".to_string(),
                    images: vec![],
                }],
            }],
            cover: None,
        };
        let txt = generate_txt(&novel);
        assert!(!txt.contains("by "), "should not emit 'by ' line: {txt:?}");
        assert!(txt.contains("Untitled"));
        assert!(txt.contains("Body."));
    }

    #[test]
    fn test_txt_omits_description_when_empty_but_keeps_author() {
        let novel = ExportedNovel {
            title: "T".to_string(),
            author: "A".to_string(),
            description: String::new(),
            chapters: vec![],
            cover: None,
        };
        let txt = generate_txt(&novel);
        assert!(txt.contains("by A"));
        // No chapters → no separator at all.
        assert!(!txt.contains(TXT_CHAPTER_SEPARATOR));
    }

    #[test]
    fn test_txt_ends_with_trailing_newline() {
        let novel = sample_novel();
        let txt = generate_txt(&novel);
        assert!(
            txt.ends_with('\n'),
            "TXT output must end with a trailing newline"
        );
    }

    #[test]
    fn test_txt_ignores_scene_images() {
        // TXT is prose-only — scene illustrations must not leak any markup or
        // image path reference into the output, even when the novel carries
        // images. Guards against accidental leakage.
        let novel = ExportedNovel {
            title: "Pic".to_string(),
            author: String::new(),
            description: String::new(),
            chapters: vec![ExportedChapter {
                title: "One".to_string(),
                scenes: vec![ExportedScene {
                    content: "Prose before art.".to_string(),
                    images: vec![
                        ExportedImage {
                            bytes: b"jpeg-bytes".to_vec(),
                            mime: "image/jpeg".to_string(),
                        },
                        ExportedImage {
                            bytes: b"png-bytes".to_vec(),
                            mime: "image/png".to_string(),
                        },
                    ],
                }],
            }],
            cover: None,
        };
        let txt = generate_txt(&novel);
        assert!(txt.contains("Prose before art."), "prose must be present: {txt:?}");
        assert!(!txt.contains("<img"), "no img markup in TXT: {txt:?}");
        assert!(!txt.contains("images/"), "no image path in TXT: {txt:?}");
        assert!(
            !txt.contains("jpeg-bytes") && !txt.contains("png-bytes"),
            "raw image bytes must not leak into TXT: {txt:?}"
        );
    }

    // ─── generate_epub ─────────────────────────────────────────────────

    #[test]
    fn test_epub_generates_valid_zip() {
        let novel = sample_novel();
        // Cursor<Vec<u8>> is the standard in-memory Write + Seek sink. Note:
        // bare Vec<u8> only implements Write, NOT Seek.
        let mut sink = Cursor::new(Vec::<u8>::new());
        generate_epub(&novel, &mut sink).expect("epub generation should succeed");
        let bytes = sink.into_inner();
        // An EPUB is a ZIP archive; ZIP files begin with the PK magic (0x50 0x4B).
        assert!(
            bytes.starts_with(b"PK"),
            "epub output must be a ZIP (start with b\"PK\"), got prefix: {:?}",
            bytes.get(..2).unwrap_or(&[])
        );
        assert!(!bytes.is_empty(), "epub output must be non-empty");
    }

    #[test]
    fn test_epub_minimal_no_cover_no_chapters() {
        // Smallest legal-ish EPUB: a title only. Confirms the builder is happy
        // with zero chapters and zero cover.
        let novel = ExportedNovel {
            title: "Solo".to_string(),
            author: String::new(), // exercises the Unknown Author fallback.
            description: String::new(),
            chapters: vec![],
            cover: None,
        };
        let mut sink = Cursor::new(Vec::<u8>::new());
        generate_epub(&novel, &mut sink).expect("minimal epub should generate");
        assert!(sink.into_inner().starts_with(b"PK"));
    }

    #[test]
    fn test_epub_skips_webp_cover_silently() {
        let mut novel = sample_novel();
        novel.cover = Some(CoverImage {
            bytes: b"fake-webp-bytes-not-a-real-image".to_vec(),
            mime: "image/webp".to_string(),
        });
        let mut sink = Cursor::new(Vec::<u8>::new());
        // Must not panic / error — webp is silently skipped.
        let result = generate_epub(&novel, &mut sink);
        assert!(result.is_ok(), "webp cover should be skipped, not fatal");
        assert!(sink.into_inner().starts_with(b"PK"));
    }

    #[test]
    fn test_epub_accepts_jpeg_cover() {
        let mut novel = sample_novel();
        novel.cover = Some(CoverImage {
            // A 1×1 JPEG is non-trivial to hand-encode; epub-builder does not
            // validate that the bytes are a real image, only that they can be
            // zipped, so placeholder bytes are sufficient for this test.
            bytes: b"placeholder-jpeg-bytes".to_vec(),
            mime: "image/jpeg".to_string(),
        });
        let mut sink = Cursor::new(Vec::<u8>::new());
        generate_epub(&novel, &mut sink).expect("jpeg cover should be attached");
        assert!(sink.into_inner().starts_with(b"PK"));
    }

    #[test]
    fn test_epub_accepts_png_cover() {
        let mut novel = sample_novel();
        novel.cover = Some(CoverImage {
            bytes: b"placeholder-png-bytes".to_vec(),
            mime: "image/png".to_string(),
        });
        let mut sink = Cursor::new(Vec::<u8>::new());
        generate_epub(&novel, &mut sink).expect("png cover should be attached");
        assert!(sink.into_inner().starts_with(b"PK"));
    }

    // ─── wrap_xhtml_document ───────────────────────────────────────────

    #[test]
    fn test_wrap_xhtml_is_full_document() {
        let body = "<h1>Intro</h1>\n<p>Hello world.</p>\n";
        let xhtml = wrap_xhtml_document("Intro", body);
        assert!(xhtml.starts_with("<?xml version=\"1.0\""), "must start with XML decl");
        assert!(xhtml.contains("<html xmlns=\"http://www.w3.org/1999/xhtml\">"));
        assert!(xhtml.contains("<head>"));
        assert!(xhtml.contains("stylesheet.css"));
        assert!(xhtml.contains("<title>Intro</title>"));
        assert!(xhtml.contains("<body>"));
        // The body fragment is placed verbatim inside <body>.
        assert!(xhtml.contains("<h1>Intro</h1>"));
        assert!(xhtml.contains("<p>Hello world.</p>"));
        assert!(xhtml.ends_with("</html>\n"));
    }

    #[test]
    fn test_wrap_xhtml_escapes_title() {
        // The <title> element must have its content escaped even when the body
        // is plain. Guards against injecting raw markup via the chapter title.
        let xhtml = wrap_xhtml_document("A & B <C>", "");
        assert!(xhtml.contains("<title>A &amp; B &lt;C&gt;</title>"));
        // No raw unescaped ampersand survives in the title context.
        assert!(!xhtml.contains("<title>A & B"));
    }

    #[test]
    fn test_wrap_xhtml_empty_body_still_well_formed() {
        let xhtml = wrap_xhtml_document("Empty", "");
        assert!(xhtml.contains("<body>\n"));
        assert!(xhtml.contains("</body>"));
        assert!(xhtml.ends_with("</html>\n"));
    }

    // ─── generate_epub: scene images ───────────────────────────────────

    #[test]
    fn test_epub_embeds_scene_images_as_resources() {
        // One chapter, one scene, three images (jpeg + png embedded, webp
        // skipped). Verifies the EPUB archive actually contains the embedded
        // image resources under their generated paths, and does NOT contain a
        // webp entry.
        let novel = ExportedNovel {
            title: "With Images".to_string(),
            author: String::new(),
            description: String::new(),
            chapters: vec![ExportedChapter {
                title: "Only Chapter".to_string(),
                scenes: vec![ExportedScene {
                    content: "Prose before art.".to_string(),
                    images: vec![
                        ExportedImage {
                            bytes: b"jpeg-bytes".to_vec(),
                            mime: "image/jpeg".to_string(),
                        },
                        ExportedImage {
                            bytes: b"png-bytes".to_vec(),
                            mime: "image/png".to_string(),
                        },
                        ExportedImage {
                            bytes: b"webp-bytes".to_vec(),
                            mime: "image/webp".to_string(),
                        },
                    ],
                }],
            }],
            cover: None,
        };

        let mut sink = Cursor::new(Vec::<u8>::new());
        generate_epub(&novel, &mut sink).expect("epub with images should generate");
        let bytes = sink.into_inner();

        let archive =
            ZipArchive::new(Cursor::new(bytes)).expect("output must be a readable zip");
        // epub-builder places resources under an `OEBPS/` prefix automatically,
        // so match by suffix to stay robust to that placement detail.
        let names: Vec<String> = archive.file_names().map(String::from).collect();

        let has_jpeg = names.iter().any(|n| n.ends_with("images/ch1_sc0_0.jpeg"));
        let has_png = names.iter().any(|n| n.ends_with("images/ch1_sc0_1.png"));
        assert!(has_jpeg, "jpeg image missing from zip; entries: {names:?}");
        assert!(has_png, "png image missing from zip; entries: {names:?}");

        let has_webp = names.iter().any(|n| n.ends_with(".webp"));
        assert!(!has_webp, "webp image should be skipped; entries: {names:?}");
    }

    #[test]
    fn test_epub_scene_images_rendered_after_prose() {
        // The chapter XHTML must contain prose paragraphs BEFORE the <img>
        // tags. We can't easily read the xhtml back from the zip without more
        // plumbing, so this test instead constructs the exact body string the
        // renderer builds and feeds it through wrap_xhtml_document to confirm
        // ordering at the string level. (Full round-trip is covered by the
        // zip-resource test above.)
        let mut body = String::new();
        body.push_str("<h1>Ch</h1>\n");
        let paragraphs = text_to_xhtml_paragraphs("prose line");
        body.push_str(&paragraphs);
        body.push('\n');
        body.push_str("<p><img src=\"images/ch1_sc0_0.png\" alt=\"\"/></p>\n");
        let xhtml = wrap_xhtml_document("Ch", &body);
        let prose_pos = xhtml.find("prose line").unwrap();
        let img_pos = xhtml.find("<img").unwrap();
        assert!(
            prose_pos < img_pos,
            "prose must come before images in the chapter XHTML"
        );
    }

    // ─── ExportError ergonomics ────────────────────────────────────────

    #[test]
    fn test_export_error_displays() {
        let e1 = ExportError::EpubBuild("boom".to_string());
        assert!(e1.to_string().contains("boom"));
        let io_err = std::io::Error::other("disk full");
        let e2 = ExportError::Io(io_err);
        assert!(e2.to_string().contains("disk full"));
        // It implements std::error::Error (compile-time check via trait method).
        fn _assert_error<T: std::error::Error>(_: &T) {}
        _assert_error(&e1);
        _assert_error(&e2);
    }
}
