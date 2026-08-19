import { describe, expect, it } from "vitest";
import type { FilePart, ModelMessage, TextPart } from "ai";

import { inlineTextFileParts } from "@/lib/ai/pipeline";

// ─── Fixtures ─────────────────────────────────────────────────────────────

/** Encode `text` as a base64 data URL (multi-byte UTF-8 safe). */
function textDataUrl(text: string, mime = "text/markdown"): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

function textFilePart(
  filename: string,
  text: string,
  mime = "text/markdown",
): FilePart {
  return {
    type: "file",
    data: textDataUrl(text, mime),
    filename,
    mediaType: mime,
  };
}

function imageFilePart(filename: string): FilePart {
  return {
    type: "file",
    data: "data:image/png;base64,aVdhRkFLRU5QTkCW==",
    filename,
    mediaType: "image/png",
  };
}

function userPartsMessage(
  parts: Array<TextPart | FilePart>,
): ModelMessage {
  return { role: "user", content: parts };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("inlineTextFileParts", () => {
  it("returns the SAME array reference when nothing matches", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "plain string" },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
    ];
    expect(inlineTextFileParts(messages)).toBe(messages);
  });

  it("replaces a data-URL text FilePart with the EXACT sentinel format", () => {
    const textPart: TextPart = { type: "text", text: "see the notes" };
    const file = textFilePart("notes.md", "line one\nline two");
    const messages = [userPartsMessage([textPart, file])];

    const out = inlineTextFileParts(messages);

    expect(out).not.toBe(messages);
    const content = out[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected array content");
    expect(content).toHaveLength(2);
    // The leading TextPart keeps its identity.
    expect(content[0]).toBe(textPart);
    // The FilePart becomes a sentinel TextPart with the exact D4 shape.
    expect(content[1]).toEqual({
      type: "text",
      text: '<attachment filename="notes.md" mime="text/markdown">\nline one\nline two\n</attachment>',
    });
  });

  it("attribute-escapes a filename containing quotes and angle brackets", () => {
    const file = textFilePart(
      `draft "final" & <v2>.md`,
      "body",
      "text/plain",
    );
    const messages = [userPartsMessage([file])];

    const out = inlineTextFileParts(messages);

    const content = out[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected array content");
    const sentinel = (content[0] as TextPart).text;
    expect(sentinel).toBe(
      '<attachment filename="draft &quot;final&quot; &amp; &lt;v2&gt;.md" mime="text/plain">\nbody\n</attachment>',
    );
  });

  it("decodes multi-byte UTF-8 content correctly (Chinese fixture)", () => {
    const file = textFilePart("世界观.md", "# 世界观设定\n角色：林墨\n地点：云隐城");
    const messages = [userPartsMessage([file])];

    const out = inlineTextFileParts(messages);

    const content = out[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected array content");
    const sentinel = (content[0] as TextPart).text;
    expect(sentinel).toBe(
      '<attachment filename="世界观.md" mime="text/markdown">\n# 世界观设定\n角色：林墨\n地点：云隐城\n</attachment>',
    );
  });

  it("leaves image FileParts untouched BY REFERENCE", () => {
    const image = imageFilePart("sunset.png");
    const file = textFilePart("notes.md", "hello");
    const messages = [userPartsMessage([image, file])];

    const out = inlineTextFileParts(messages);

    const content = out[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected array content");
    expect(content[0]).toBe(image);
    expect(content[1]).toEqual({ type: "text", text: expect.stringContaining("<attachment") });
  });

  it("leaves non-user messages untouched BY REFERENCE", () => {
    const assistant: ModelMessage = {
      role: "assistant",
      content: [{ type: "text", text: "earlier" }],
    };
    const tool: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "tc-1",
          toolName: "lookup",
          output: { type: "text", value: "found" },
        },
      ],
    };
    const file = textFilePart("notes.md", "hello");
    const user = userPartsMessage([file]);
    const messages = [assistant, tool, user];

    const out = inlineTextFileParts(messages);

    expect(out[0]).toBe(assistant);
    expect(out[1]).toBe(tool);
    expect(out[2]).not.toBe(user);
  });

  it("leaves string-content user messages untouched BY REFERENCE", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "just text" }];
    expect(inlineTextFileParts(messages)).toBe(messages);
  });

  it("passes a text FilePart with NON-data-URL data through unchanged", () => {
    // Future hydration edge: an attachment:// ref must not be inlined.
    const ref: FilePart = {
      type: "file",
      data: "attachment://0a1b2c3d",
      filename: "notes.md",
      mediaType: "text/markdown",
    };
    const messages = [userPartsMessage([ref])];

    const out = inlineTextFileParts(messages);

    // Nothing eligible → same array reference, part untouched.
    expect(out).toBe(messages);
    const content = out[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected array content");
    expect(content[0]).toBe(ref);
  });

  it("preserves message count and order", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      userPartsMessage([
        { type: "text", text: "docs" },
        textFilePart("a.md", "aaa"),
        imageFilePart("b.png"),
        textFilePart("c.csv", "x,y", "text/csv"),
      ]),
    ];

    const out = inlineTextFileParts(messages);

    expect(out).toHaveLength(messages.length);
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const last = out[2]?.content;
    if (!Array.isArray(last)) throw new Error("expected array content");
    // Part count also preserved: text, sentinel, image, sentinel.
    expect(last).toHaveLength(4);
    expect(last.map((p) => p.type)).toEqual(["text", "text", "file", "text"]);
  });
});
