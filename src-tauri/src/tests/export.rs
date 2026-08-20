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
                        content: "The innkeeper said nothing, only pointed upstairs.".to_string(),
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

/// Generate a minimal valid WebP image (1×1 white pixel) for testing the
/// WebP → PNG transcode path. Uses the same `image` crate the production
/// transcoder uses, guaranteeing the output is decodable.
fn make_test_webp() -> Vec<u8> {
    let img = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
        1,
        1,
        image::Rgba([255, 255, 255, 255]),
    ));
    let mut bytes = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut bytes),
        image::ImageFormat::WebP,
    )
    .expect("test fixture: encode webp");
    bytes
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
    assert!(
        out.contains(" &amp; "),
        "ampersand should be an entity in {out:?}"
    );
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
    assert!(
        txt.contains("Prose before art."),
        "prose must be present: {txt:?}"
    );
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
fn test_epub_transcodes_webp_cover_to_png() {
    // A WebP cover should be transcoded to PNG and embedded in the archive
    // as `cover.png` — NOT silently skipped (the previous behavior).
    let mut novel = sample_novel();
    novel.cover = Some(CoverImage {
        bytes: make_test_webp(),
        mime: "image/webp".to_string(),
    });
    let mut sink = Cursor::new(Vec::<u8>::new());
    generate_epub(&novel, &mut sink).expect("webp cover should be transcoded, not fail");
    let bytes = sink.into_inner();
    assert!(bytes.starts_with(b"PK"), "epub output must be a ZIP");

    let archive = ZipArchive::new(Cursor::new(bytes)).expect("output must be a readable zip");
    let names: Vec<String> = archive.file_names().map(String::from).collect();
    let has_cover_png = names.iter().any(|n| n.ends_with("cover.png"));
    assert!(
        has_cover_png,
        "webp cover should be transcoded to cover.png; entries: {names:?}"
    );
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
    assert!(
        xhtml.starts_with("<?xml version=\"1.0\""),
        "must start with XML decl"
    );
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
    // One chapter, one scene, three images (jpeg + png pass through, webp
    // transcoded to png). Verifies the EPUB archive actually contains the
    // embedded image resources under their generated paths, including the
    // transcoded webp → png entry.
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
                        bytes: make_test_webp(),
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

    let archive = ZipArchive::new(Cursor::new(bytes)).expect("output must be a readable zip");
    // epub-builder places resources under an `OEBPS/` prefix automatically,
    // so match by suffix to stay robust to that placement detail.
    let names: Vec<String> = archive.file_names().map(String::from).collect();

    let has_jpeg = names.iter().any(|n| n.ends_with("images/ch1_sc0_0.jpeg"));
    let has_png = names.iter().any(|n| n.ends_with("images/ch1_sc0_1.png"));
    assert!(has_jpeg, "jpeg image missing from zip; entries: {names:?}");
    assert!(has_png, "png image missing from zip; entries: {names:?}");

    // The webp image (index 2) should be transcoded to PNG and appear at
    // the same path slot with a `.png` extension — NOT silently dropped.
    let has_transcoded_webp = names.iter().any(|n| n.ends_with("images/ch1_sc0_2.png"));
    assert!(
        has_transcoded_webp,
        "webp image should be transcoded to png at ch1_sc0_2.png; entries: {names:?}"
    );

    // No raw .webp files should exist in the archive.
    let has_webp = names.iter().any(|n| n.ends_with(".webp"));
    assert!(
        !has_webp,
        "no raw webp should be in the archive; entries: {names:?}"
    );
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
    let e2 = ExportError::ImageTranscode("decode failed".to_string());
    assert!(e2.to_string().contains("decode failed"));
    let io_err = std::io::Error::other("disk full");
    let e3 = ExportError::Io(io_err);
    assert!(e3.to_string().contains("disk full"));
    // It implements std::error::Error (compile-time check via trait method).
    fn _assert_error<T: std::error::Error>(_: &T) {}
    _assert_error(&e1);
    _assert_error(&e2);
    _assert_error(&e3);
}
