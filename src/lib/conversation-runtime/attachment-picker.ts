/**
 * Attachment picking (ADR-0044 §D10 / plan P4) — pure File → DraftAttachment
 * pipeline shared by the composer's three entry points (attach button, paste,
 * drag-drop).
 *
 * Validation order per file (plan task spec):
 *   1. count cap — once `accepted` holds `remaining` items, every later file
 *      is rejected as `"too-many"` (in input order);
 *   2. kind detection — image MIME allowlist (magic-byte-verified later) or
 *      text by extension/MIME;
 *   3. size — image ≤ 5 MiB, text ≤ 1 MiB (raw file size);
 *   4. read as data URL — images are magic-byte-sniffed against the declared
 *      MIME (mismatch → `"unsupported-type"`); text is strict-UTF-8 decoded,
 *      then auto-converted when possible (UTF-16 by BOM / GB18030 — the
 *      deterministic legacy cases), and size-revalidated POST-conversion
 *      (UTF-8 CJK is ~1.5× GBK — a converted file may exceed the 1 MiB cap
 *      Rust enforces → `"too-large"`). Undecodable in every encoding →
 *      `"invalid-text"`.
 *
 * Rust re-validates authoritatively at persist time (`util.rs`); this
 * pre-validation is for instant feedback only. Pure with respect to app
 * state — takes Files, returns accepted/rejected lists, touches no store.
 */

import { base64Encode, imageMimeAllowList, sniffImageMime } from "@/lib/image-bytes";
import type { ConvertedFromEncoding, DraftAttachment } from "./store";

// NOTE: keep in sync with `src-tauri/src/util.rs`
// (`MAX_ATTACHMENT_IMAGE_BYTES` / `MAX_ATTACHMENT_TEXT_BYTES`).
/** Max DECODED image payload (plan D6). Mirror of the Rust-side constant. */
export const IMAGE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** Max DECODED text payload (plan D6). Mirror of the Rust-side constant. */
export const TEXT_ATTACHMENT_MAX_BYTES = 1024 * 1024;

/** Why a picked file was not staged. */
export type AttachmentRejectionReason =
  | "too-large"
  | "unsupported-type"
  | "too-many"
  | "read-failed"
  | "invalid-text";

export interface AttachmentRejection {
  readonly file: File;
  readonly reason: AttachmentRejectionReason;
}

export interface PickedAttachments {
  readonly accepted: DraftAttachment[];
  readonly rejected: AttachmentRejection[];
}

/** Text extensions accepted (lowercase, with the leading dot). */
const TEXT_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".csv", "text/csv"],
]);

/** Text MIMEs accepted (must match `ALLOWED_ATTACHMENT_TEXT_MIMES` in util.rs). */
const TEXT_MIMES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
]);

/** Lowercase extension of a filename ("" when none). */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

/**
 * Detect the attachment kind + normalized MIME for a file.
 *
 * Images: declared MIME must be in the image allowlist (the `<input
 * accept>` hints it, but drag-drop can bring anything). Text: detected by
 * extension OR MIME; extension-detected files get the canonical MIME for
 * that extension (dropped files often carry `application/octet-stream`,
 * which the Rust validator would reject verbatim). Returns `null` for
 * anything else.
 */
function detectKind(
  file: File,
): { kind: "image"; mime: string } | { kind: "text"; mime: string } | null {
  const mime = file.type.toLowerCase();
  if (imageMimeAllowList.includes(mime)) return { kind: "image", mime };
  const byExtension = TEXT_EXTENSIONS.get(extensionOf(file.name));
  if (byExtension) return { kind: "text", mime: byExtension };
  if (TEXT_MIMES.has(mime)) return { kind: "text", mime };
  return null;
}

/**
 * Result of {@link decodeTextAttachment}: the decoded string plus, when a
 * legacy encoding was converted, which one.
 */
export interface DecodedTextAttachment {
  readonly str: string;
  readonly convertedFrom?: ConvertedFromEncoding;
}

/**
 * Deterministic text-decoding cascade for text attachments:
 *
 * 1. strict UTF-8 — the zero-change fast path;
 * 2. UTF-16 by byte-order mark — `FF FE` → LE, `FE FF` → BE (no heuristics,
 *    the BOM decides); the mark is stripped by the decoder by default;
 * 3. GB18030 — superset of GB2312/GBK, the realistic zh-CN legacy case.
 *
 * Returns `null` when every step fails (`"invalid-text"` upstream). On a
 * step-2/3 success the caller re-encodes to UTF-8 via TextEncoder.
 */
export function decodeTextAttachment(
  bytes: ArrayBuffer,
): DecodedTextAttachment | null {
  const u8 = new Uint8Array(bytes);
  try {
    return { str: new TextDecoder("utf-8", { fatal: true }).decode(u8) };
  } catch {
    // Not valid UTF-8 — try the deterministic conversions below.
  }
  if (u8[0] === 0xff && u8[1] === 0xfe) {
    try {
      // BOM present → this IS UTF-16LE (the mark decides, not a guess);
      // ignoreBOM defaults to false so the mark is stripped from the result.
      return {
        str: new TextDecoder("utf-16le", { fatal: true }).decode(u8),
        convertedFrom: "utf-16le",
      };
    } catch {
      // Fall through — a BOM-prefixed buffer can't be valid GB18030 either
      // (0xFF/0xFE leads are outside its 2-byte second-byte range), so this
      // lands on `null` below, but flat structure beats special cases.
    }
  } else if (u8[0] === 0xfe && u8[1] === 0xff) {
    try {
      return {
        str: new TextDecoder("utf-16be", { fatal: true }).decode(u8),
        convertedFrom: "utf-16be",
      };
    } catch {
      // Same as above.
    }
  }
  try {
    return {
      str: new TextDecoder("gb18030", { fatal: true }).decode(u8),
      convertedFrom: "gb18030",
    };
  } catch {
    return null;
  }
}

/**
 * Convert picked files into draft attachments, validating cap / kind / size
 * / magic bytes along the way.
 *
 * @param files     picked files (attach-button change, paste, or drop).
 * @param remaining free attachment slots (`maxAttachments -
 *                  draftAttachments.length`) — files beyond it are rejected
 *                  as `"too-many"`.
 */
export async function filesToDraftAttachments(
  files: File[] | FileList,
  remaining: number,
): Promise<PickedAttachments> {
  const accepted: DraftAttachment[] = [];
  const rejected: AttachmentRejection[] = [];

  for (const file of Array.from(files)) {
    if (accepted.length >= remaining) {
      rejected.push({ file, reason: "too-many" });
      continue;
    }
    const detected = detectKind(file);
    if (!detected) {
      rejected.push({ file, reason: "unsupported-type" });
      continue;
    }
    const maxBytes =
      detected.kind === "image"
        ? IMAGE_ATTACHMENT_MAX_BYTES
        : TEXT_ATTACHMENT_MAX_BYTES;
    if (file.size > maxBytes) {
      rejected.push({ file, reason: "too-large" });
      continue;
    }
    let bytes: ArrayBuffer;
    try {
      bytes = await file.arrayBuffer();
    } catch {
      rejected.push({ file, reason: "read-failed" });
      continue;
    }
    if (detected.kind === "image" && sniffImageMime(bytes) !== detected.mime) {
      // Bytes don't match the declared image type — reject rather than
      // stage something the Rust validator (or the model) would choke on.
      rejected.push({ file, reason: "unsupported-type" });
      continue;
    }
    if (detected.kind === "text") {
      const decoded = decodeTextAttachment(bytes);
      if (!decoded) {
        rejected.push({ file, reason: "invalid-text" });
        continue;
      }
      const utf8Bytes = new TextEncoder().encode(decoded.str);
      // POST-conversion size re-validation: UTF-8 CJK is ~1.5× GBK, so a
      // raw-≤1 MiB legacy file can exceed the cap AFTER conversion — Rust
      // would then reject it at persist time and roll back the entire turn
      // (user msg + assistant reply). Catch it here instead.
      if (utf8Bytes.length > TEXT_ATTACHMENT_MAX_BYTES) {
        rejected.push({ file, reason: "too-large" });
        continue;
      }
      accepted.push({
        id: crypto.randomUUID(),
        kind: detected.kind,
        mime: detected.mime,
        filename: file.name,
        sizeBytes: utf8Bytes.length,
        ...(decoded.convertedFrom
          ? { convertedFrom: decoded.convertedFrom }
          : {}),
        dataUrl: `data:${detected.mime};base64,${base64Encode(utf8Bytes)}`,
      });
      continue;
    }
    accepted.push({
      id: crypto.randomUUID(),
      kind: detected.kind,
      mime: detected.mime,
      filename: file.name,
      sizeBytes: file.size,
      dataUrl: `data:${detected.mime};base64,${base64Encode(new Uint8Array(bytes))}`,
    });
  }

  return { accepted, rejected };
}

/**
 * Decode the text payload of a `data:{mime};base64,…` data URL into a JS
 * string (UTF-8 aware — `atob` alone would mangle multi-byte content).
 * Returns "" for malformed input; never throws.
 */
export function decodeDataUrlText(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return "";
  try {
    const binary = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

/** Human-readable byte size for attachment chips (`"2.4 KB"`, `"1.1 MB"`). */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) {
    const kb = bytes / 1024;
    return `${Number.isInteger(kb) ? kb : kb.toFixed(1)} KB`;
  }
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}
