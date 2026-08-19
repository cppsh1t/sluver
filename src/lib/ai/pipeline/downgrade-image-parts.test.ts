import { describe, expect, it } from "vitest";
import type { FilePart, ModelMessage, TextPart } from "ai";

import { downgradeImageParts } from "@/lib/ai/pipeline";

// ─── Fixtures ─────────────────────────────────────────────────────────────

function imageFilePart(filename?: string): FilePart {
  return {
    type: "file",
    data: "data:image/png;base64,aVdhRkFLRU5QTkCW==",
    ...(filename === undefined ? {} : { filename }),
    mediaType: "image/png",
  };
}

function userPartsMessage(parts: Array<TextPart | FilePart>): ModelMessage {
  return { role: "user", content: parts };
}

const MARKER = (filename: string) =>
  `[image attachment: "${filename}" — image content NOT delivered: the bound model does not accept image input]`;

// ─── Tests ────────────────────────────────────────────────────────────────

describe("downgradeImageParts", () => {
  it("returns the SAME array reference when imageInputSupported is true", () => {
    const messages = [userPartsMessage([imageFilePart("sunset.png")])];
    expect(downgradeImageParts(messages, true)).toBe(messages);
  });

  it("returns the SAME array reference when imageInputSupported is undefined", () => {
    const messages = [userPartsMessage([imageFilePart("sunset.png")])];
    expect(downgradeImageParts(messages, undefined)).toBe(messages);
  });

  it("replaces an image FilePart with the EXACT marker text when false", () => {
    const textPart: TextPart = { type: "text", text: "look at this" };
    const image = imageFilePart("sunset.png");
    const messages = [userPartsMessage([textPart, image])];

    const out = downgradeImageParts(messages, false);

    expect(out).not.toBe(messages);
    const content = out[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected array content");
    expect(content).toHaveLength(2);
    // The leading TextPart keeps its identity.
    expect(content[0]).toBe(textPart);
    // The image becomes a marker TextPart with the exact D9 wording.
    expect(content[1]).toEqual({ type: "text", text: MARKER("sunset.png") });
  });

  it("falls back to \"unnamed\" when the part has no filename", () => {
    const messages = [userPartsMessage([imageFilePart()])];

    const out = downgradeImageParts(messages, false);

    const content = out[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected array content");
    expect(content[0]).toEqual({ type: "text", text: MARKER("unnamed") });
  });

  it("carries the filename verbatim (no escaping)", () => {
    const messages = [userPartsMessage([imageFilePart(`shot & "draft".png`)])];

    const out = downgradeImageParts(messages, false);

    const content = out[0]?.content;
    if (!Array.isArray(content)) throw new Error("expected array content");
    expect(content[0]).toEqual({
      type: "text",
      text: MARKER(`shot & "draft".png`),
    });
  });

  it("leaves non-user messages untouched even when false", () => {
    const assistant: ModelMessage = {
      role: "assistant",
      // Assistant file parts exist in the SDK union; the transform only
      // touches USER messages.
      content: [{ type: "text", text: "reply" }],
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
    const messages: ModelMessage[] = [assistant, tool];

    const out = downgradeImageParts(messages, false);

    expect(out[0]).toBe(assistant);
    expect(out[1]).toBe(tool);
  });

  it("leaves string-content user messages untouched even when false", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "no images" }];
    expect(downgradeImageParts(messages, false)).toBe(messages);
  });

  it("leaves NON-image file parts untouched when false", () => {
    const textFile: FilePart = {
      type: "file",
      data: "data:text/markdown;base64,aGVsbG8=",
      filename: "notes.md",
      mediaType: "text/markdown",
    };
    const messages = [userPartsMessage([textFile])];

    const out = downgradeImageParts(messages, false);

    // Nothing downgradable → same array reference.
    expect(out).toBe(messages);
  });

  it("preserves message count and order when false", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "first" },
      userPartsMessage([
        imageFilePart("a.png"),
        { type: "text", text: "mid" },
        imageFilePart("b.png"),
      ]),
      { role: "assistant", content: "answer" },
    ];

    const out = downgradeImageParts(messages, false);

    expect(out).toHaveLength(messages.length);
    expect(out.map((m) => m.role)).toEqual(["user", "user", "assistant"]);
    const mid = out[1]?.content;
    if (!Array.isArray(mid)) throw new Error("expected array content");
    expect(mid).toHaveLength(3);
    expect(mid.map((p) => p.type)).toEqual(["text", "text", "text"]);
  });
});
