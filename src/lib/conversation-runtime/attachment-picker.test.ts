/**
 * Attachment picker tests (ADR-0044 §D10) — validation order, cap, magic
 * byte sniffing, and MIME normalization. Pure: File/Blob/FileReader all
 * exist under jsdom; no store or React involved.
 */

import { describe, expect, it } from "vitest";

import {
  IMAGE_ATTACHMENT_MAX_BYTES,
  TEXT_ATTACHMENT_MAX_BYTES,
  decodeDataUrlText,
  filesToDraftAttachments,
} from "./attachment-picker";

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** Minimal PNG header (magic bytes `89 50 4E 47` + filler). */
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Minimal JPEG header (`FF D8 FF`). */
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

function pngFile(bytes: number = 64, name = "photo.png", type = "image/png"): File {
  const buf = new Uint8Array(bytes);
  buf.set(PNG_MAGIC.subarray(0, Math.min(8, bytes)));
  return new File([buf], name, { type });
}

function textFile(content: string, name: string, type?: string): File {
  return type === undefined
    ? new File([content], name)
    : new File([content], name, { type });
}

// ─── tests ─────────────────────────────────────────────────────────────────

describe("filesToDraftAttachments", () => {
  it("accepts a valid PNG with matching magic bytes", async () => {
    const { accepted, rejected } = await filesToDraftAttachments([pngFile()], 8);
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    const a = accepted[0]!;
    expect(a.kind).toBe("image");
    expect(a.mime).toBe("image/png");
    expect(a.filename).toBe("photo.png");
    expect(a.sizeBytes).toBe(64);
    expect(a.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(a.id).toMatch(/[0-9a-f-]{36}/);
  });

  it("accepts a JPEG whose declared mime matches its magic bytes", async () => {
    const buf = new Uint8Array(32);
    buf.set(JPEG_MAGIC);
    const file = new File([buf], "img.jpeg", { type: "image/jpeg" });
    const { accepted, rejected } = await filesToDraftAttachments([file], 8);
    expect(rejected).toEqual([]);
    expect(accepted[0]?.mime).toBe("image/jpeg");
  });

  it("rejects an oversized image (5 MiB + 1)", async () => {
    const file = pngFile(IMAGE_ATTACHMENT_MAX_BYTES + 1);
    const { accepted, rejected } = await filesToDraftAttachments([file], 8);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ file, reason: "too-large" }]);
  });

  it("rejects an oversized text file (1 MiB + 1)", async () => {
    const content = "x".repeat(TEXT_ATTACHMENT_MAX_BYTES + 1);
    const file = textFile(content, "big.txt", "text/plain");
    const { accepted, rejected } = await filesToDraftAttachments([file], 8);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ file, reason: "too-large" }]);
  });

  it("rejects unsupported types (pdf by extension and mime)", async () => {
    const pdf = new File([new Uint8Array(16)], "doc.pdf", {
      type: "application/pdf",
    });
    const bmp = new File([new Uint8Array(16)], "x.bmp", { type: "image/bmp" });
    const { accepted, rejected } = await filesToDraftAttachments([pdf, bmp], 8);
    expect(accepted).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual([
      "unsupported-type",
      "unsupported-type",
    ]);
  });

  it("rejects an image whose bytes do not match the declared mime (sniff mismatch)", async () => {
    // Text bytes declared as PNG: sniff falls back to webp ≠ png → reject.
    const file = textFile("hello world, definitely not an image", "fake.png", "image/png");
    const { accepted, rejected } = await filesToDraftAttachments([file], 8);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ file, reason: "unsupported-type" }]);
  });

  it("marks files beyond the remaining slots as too-many, in input order", async () => {
    const a = pngFile(64, "a.png");
    const b = pngFile(64, "b.png");
    const { accepted, rejected } = await filesToDraftAttachments([a, b], 1);
    expect(accepted.map((x) => x.filename)).toEqual(["a.png"]);
    expect(rejected).toEqual([{ file: b, reason: "too-many" }]);
  });

  it("rejects everything as too-many when remaining is 0", async () => {
    const file = pngFile();
    const { accepted, rejected } = await filesToDraftAttachments([file], 0);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ file, reason: "too-many" }]);
  });

  it("accepts a .md file with an explicit text/markdown mime", async () => {
    const file = textFile("# Title\nbody", "notes.md", "text/markdown");
    const { accepted, rejected } = await filesToDraftAttachments([file], 8);
    expect(rejected).toEqual([]);
    expect(accepted[0]?.kind).toBe("text");
    expect(accepted[0]?.mime).toBe("text/markdown");
  });

  it("normalizes the mime for extension-detected text files (empty file.type)", async () => {
    // Drag-dropped files often carry an empty or octet-stream MIME; the
    // extension decides, and the canonical MIME is staged so the Rust
    // validator accepts it.
    const md = textFile("outline", "outline.md");
    const csv = new File(["a,b\n1,2"], "data.csv", {
      type: "application/octet-stream",
    });
    const { accepted, rejected } = await filesToDraftAttachments([md, csv], 8);
    expect(rejected).toEqual([]);
    expect(accepted.map((a) => a.mime)).toEqual([
      "text/markdown",
      "text/csv",
    ]);
  });

  it("round-trips text content through the staged data URL", async () => {
    const content = "# 中文标题\n\n— em dash —";
    const file = textFile(content, "utf8.md", "text/markdown");
    const { accepted } = await filesToDraftAttachments([file], 8);
    expect(decodeDataUrlText(accepted[0]!.dataUrl)).toBe(content);
  });

  it("converts a GBK-encoded .txt (gb18030) and round-trips the text", async () => {
    // 0xd6 0xd0 = GBK "中" (2 bytes) + 'A'. Invalid as UTF-8 (0xd0 is a
    // lead, not a continuation), decodes cleanly under gb18030.
    const file = new File([new Uint8Array([0xd6, 0xd0, 0x41])], "gbk.txt", {
      type: "text/plain",
    });
    const { accepted, rejected } = await filesToDraftAttachments([file], 8);
    expect(rejected).toEqual([]);
    expect(accepted).toHaveLength(1);
    const a = accepted[0]!;
    expect(a.convertedFrom).toBe("gb18030");
    expect(a.sizeBytes).toBe(4); // "中A" = 3 UTF-8 bytes + 1
    expect(decodeDataUrlText(a.dataUrl)).toBe("中A");
  });

  it("converts a BOM'd UTF-16LE .txt and strips the BOM", async () => {
    // FF FE BOM + U+4E2D (中) + U+0041 (A) as little-endian units.
    const file = new File(
      [new Uint8Array([0xff, 0xfe, 0x2d, 0x4e, 0x41, 0x00])],
      "le.txt",
      { type: "text/plain" },
    );
    const { accepted, rejected } = await filesToDraftAttachments([file], 8);
    expect(rejected).toEqual([]);
    const a = accepted[0]!;
    expect(a.convertedFrom).toBe("utf-16le");
    const text = decodeDataUrlText(a.dataUrl);
    expect(text).toBe("中A");
    expect(text.includes("\uFEFF")).toBe(false);
  });

  it("converts a BOM'd UTF-16BE .txt", async () => {
    // FE FF BOM + U+4E2D + U+0041 as big-endian units.
    const file = new File(
      [new Uint8Array([0xfe, 0xff, 0x4e, 0x2d, 0x00, 0x41])],
      "be.txt",
      { type: "text/plain" },
    );
    const { accepted, rejected } = await filesToDraftAttachments([file], 8);
    expect(rejected).toEqual([]);
    const a = accepted[0]!;
    expect(a.convertedFrom).toBe("utf-16be");
    expect(decodeDataUrlText(a.dataUrl)).toBe("中A");
  });

  it("accepts valid multi-byte UTF-8 Chinese text WITHOUT conversion", async () => {
    const content = "中文内容 — 验证多字节";
    const file = textFile(content, "zh.txt", "text/plain");
    const { accepted, rejected } = await filesToDraftAttachments([file], 8);
    expect(rejected).toEqual([]);
    expect(accepted[0]?.convertedFrom).toBeUndefined();
    expect(decodeDataUrlText(accepted[0]!.dataUrl)).toBe(content);
  });

  it("rejects a legacy file that exceeds 1 MiB only AFTER conversion", async () => {
    // 370,000 GBK "中" pairs: raw 740,000 bytes pass the size pre-check,
    // but convert to 370,000 × 3 = 1,110,000 UTF-8 bytes > 1 MiB — the
    // exact silent-turn-loss hole Rust's validator would otherwise catch
    // too late (batch rollback).
    const pairs = 370_000;
    const bytes = new Uint8Array(pairs * 2);
    for (let i = 0; i < pairs; i++) {
      bytes[i * 2] = 0xd6;
      bytes[i * 2 + 1] = 0xd0;
    }
    expect(bytes.length).toBeLessThanOrEqual(TEXT_ATTACHMENT_MAX_BYTES); // raw passes
    const file = new File([bytes], "big-gbk.txt", { type: "text/plain" });
    const { accepted, rejected } = await filesToDraftAttachments([file], 8);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ file, reason: "too-large" }]);
  });

  it("still rejects bytes undecodable in every cascade encoding as invalid-text", async () => {
    // 0x81 is a GB18030 2-byte lead but 0x39 ('9') is below its second-byte
    // floor (0x40) — fails gb18030; 0x81 is also an invalid UTF-8 lead
    // continuation; no BOM → skips UTF-16. Fails everything.
    const file = new File([new Uint8Array([0x81, 0x39])], "bin.txt", {
      type: "text/plain",
    });
    const { accepted, rejected } = await filesToDraftAttachments([file], 8);
    expect(accepted).toEqual([]);
    expect(rejected).toEqual([{ file, reason: "invalid-text" }]);
  });

  it("accepts an empty file list", async () => {
    const result = await filesToDraftAttachments([], 8);
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([]);
  });
});

describe("decodeDataUrlText", () => {
  it("returns empty string for input without a comma", () => {
    expect(decodeDataUrlText("not-a-data-url")).toBe("");
  });

  it("decodes base64 payload as UTF-8", () => {
    // Build REAL UTF-8 bytes first (btoa alone would emit latin-1).
    const bytes = new TextEncoder().encode("héllo");
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    const url = `data:text/plain;base64,${btoa(binary)}`;
    expect(decodeDataUrlText(url)).toBe("héllo");
  });
});
