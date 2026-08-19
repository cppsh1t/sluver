/**
 * Text-file inliner — Derived Model Input transform for chat text
 * attachments (ADR-0028, ADR-0044 D4).
 *
 * User messages can carry text attachments as `FilePart`s whose `data` is a
 * base64 data URL (the runtime thread form — ADR-0044 D3). Provider support
 * for text `FilePart`s varies; a plain {@link TextPart} works on every model.
 * This transform therefore converts each eligible FilePart into a
 * sentinel-wrapped TextPart at model-input build time:
 *
 * ```
 * <attachment filename="notes.md" mime="text/markdown">
 * …file content verbatim…
 * </attachment>
 * ```
 *
 * The sentinel is **write-only**: the persisted truth is the FilePart (with
 * its `attachment://{id}` ref at rest), so no parsing ever happens — no
 * round-trip fragility. This is exactly what ADR-0028's Persisted Thread /
 * Derived Model Input split anticipates: layers may reshape.
 *
 * ## Purity (CRITICAL — ADR-0028 invariant 2, ADR-0019)
 *
 * PURE: same input always produces the same output. No React, no IPC, no
 * logger, no Node-only APIs — decoding uses the platform globals `atob` and
 * `TextDecoder` (available in the browser/WebView runtime this library
 * targets). The input array and every element are treated as immutable;
 * freshly constructed message objects are emitted only where a rewrite was
 * required. When nothing matches, the input array reference is returned
 * verbatim (zero allocation).
 *
 * ## Eligibility
 *
 * A part is inlined iff ALL hold:
 * - the message is a USER message with array content;
 * - the part is a `FilePart` whose `mediaType` starts with `text/`;
 * - `data` is a bare string in base64 data-URL form (`data:text/…;base64,…`).
 *
 * Everything else — non-user messages, string content, image/other file
 * parts, non-data-URL data (e.g. a future `attachment://` ref pre-hydration)
 * — passes through untouched, BY REFERENCE. Message count and order are
 * strictly preserved (parts are mapped WITHIN messages — the invariant the
 * `Agent.run` `inputLength` slicing relies on).
 *
 * Related: ADR-0028 (three-layer model), ADR-0044 (chat file attachments).
 */

import type {
  FilePart,
  ImagePart,
  ModelMessage,
  TextPart,
} from "ai";

// ─── Data-URL decoding ───────────────────────────────────────────────────

/**
 * Whether `data` is a base64 data URL (`data:<mime>[;params];base64,<payload>`).
 * Bare-prefix, cheap, allocation-free — used by the pass-1 fast scan.
 */
function isBase64DataUrl(data: string): boolean {
  if (!data.startsWith("data:")) return false;
  const comma = data.indexOf(",");
  if (comma === -1) return false;
  return data.slice(0, comma).includes(";base64");
}

/**
 * Decode a base64 data URL to UTF-8 text, multi-byte-safe: `atob` yields a
 * binary string (one char per byte), which is re-packed into a `Uint8Array`
 * and decoded as UTF-8 by `TextDecoder`.
 */
function decodeBase64DataUrl(data: string): string {
  const payload = data.slice(data.indexOf(",") + 1);
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

// ─── Sentinel formatting ──────────────────────────────────────────────────

/**
 * Escape a string for use inside a double-quoted XML-ish attribute. Covers
 * the four characters that can break out of the attribute or confuse a
 * tag-aware reader: `&`, `<`, `>`, `"`.
 */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the sentinel TextPart for one inlined text FilePart (D4 format).
 * `filename` falls back to `"unnamed"` when the part carries none.
 */
function toSentinelPart(part: FilePart): TextPart | FilePart {
  // Defensive: callers gate on `typeof part.data === "string"` — a
  // non-string `data` can only arrive here through direct misuse.
  if (typeof part.data !== "string") return part;
  const filename = part.filename ?? "unnamed";
  const text =
    `<attachment filename="${escapeXmlAttribute(filename)}" mime="${part.mediaType}">\n` +
    `${decodeBase64DataUrl(part.data)}\n` +
    `</attachment>`;
  return { type: "text", text };
}

// ─── Eligibility ──────────────────────────────────────────────────────────

/** A user-content array element eligible for inlining. */
function isInlinableTextFilePart(
  part: TextPart | ImagePart | FilePart,
): part is FilePart {
  return (
    part.type === "file" &&
    part.mediaType.startsWith("text/") &&
    typeof part.data === "string" &&
    isBase64DataUrl(part.data)
  );
}

// ─── Core transform ───────────────────────────────────────────────────────

/**
 * Replace data-URL text FileParts in USER messages with sentinel-wrapped
 * TextParts (ADR-0044 D4).
 *
 * @param messages  The Derived Model Input (Persisted Thread + the
 *                  just-appended user message), all converted to
 *                  `ModelMessage`. Treated as immutable.
 * @returns A new array with matching FileParts inlined. Message count and
 *          order are preserved. When nothing matched, the input array
 *          reference is returned verbatim.
 */
export function inlineTextFileParts(
  messages: ModelMessage[],
): ModelMessage[] {
  // Pass 1: fast scan — bail out with the input reference when no user
  // message carries an eligible part (the overwhelmingly common case).
  let found = false;
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    const { content } = msg;
    if (typeof content === "string" || !Array.isArray(content)) continue;
    for (const part of content) {
      if (isInlinableTextFilePart(part)) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) return messages;

  // Pass 2: rebuild — rewrite only the user messages that contain a match;
  // every other message (and every non-matching part) keeps its identity.
  const out: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") {
      out.push(msg);
      continue;
    }
    const { content } = msg;
    if (typeof content === "string" || !Array.isArray(content)) {
      out.push(msg);
      continue;
    }
    let touched = false;
    const rewritten = content.map((part) => {
      if (isInlinableTextFilePart(part)) {
        touched = true;
        return toSentinelPart(part);
      }
      return part;
    });
    out.push(touched ? { ...msg, content: rewritten } : msg);
  }
  return out;
}
