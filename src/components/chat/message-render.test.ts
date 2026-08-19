/**
 * buildBlocks attachment widening tests (ADR-0044 §D5/D7): user messages
 * with file parts produce `attachments` on the user block; the optimistic
 * pending turn carries both text and attachments; `attachment://` refs and
 * non-data-URL parts are skipped defensively.
 */

import { describe, expect, it } from "vitest";
import type { UserContent } from "ai";

import type { SessionMessage } from "@/lib/ai";
import { buildBlocks, messageAttachments } from "./message-render";

function userMessage(id: string, content: UserContent): SessionMessage {
  return {
    id,
    sessionId: "s1",
    createdAt: "2026-01-01T00:00:00.000Z",
    role: "user",
    content,
  };
}

const PNG_URL = "data:image/png;base64,aVBob3Rv";
const MD_URL = "data:text/markdown;base64,IyBUaXRsZQ==";

describe("messageAttachments", () => {
  it("returns [] for string content", () => {
    expect(messageAttachments(userMessage("u1", "hello"))).toEqual([]);
  });

  it("collects image + text file parts with data URLs", () => {
    const msg = userMessage("u1", [
      { type: "text", text: "look at this" },
      { type: "file", data: PNG_URL, mediaType: "image/png", filename: "p.png" },
      { type: "file", data: MD_URL, mediaType: "text/markdown", filename: "n.md" },
    ]);
    expect(messageAttachments(msg)).toEqual([
      { kind: "image", mime: "image/png", filename: "p.png", dataUrl: PNG_URL },
      { kind: "text", mime: "text/markdown", filename: "n.md", dataUrl: MD_URL },
    ]);
  });

  it("skips attachment:// refs, non-file parts, and unknown media types", () => {
    const msg = userMessage("u1", [
      { type: "text", text: "mixed" },
      { type: "file", data: "attachment://abc", mediaType: "image/png", filename: "r.png" },
      { type: "file", data: new Uint8Array([1, 2]), mediaType: "image/png", filename: "w.png" },
      { type: "file", data: "data:video/mp4;base64,AAAA", mediaType: "video/mp4", filename: "v.mp4" },
    ]);
    expect(messageAttachments(msg)).toEqual([]);
  });
});

describe("buildBlocks with attachments", () => {
  it("user blocks carry attachments only when present", () => {
    const withFiles = userMessage("u1", [
      { type: "text", text: "see" },
      { type: "file", data: PNG_URL, mediaType: "image/png", filename: "p.png" },
    ]);
    const plain = userMessage("u2", "plain turn");
    const blocks = buildBlocks([withFiles, plain], null, false, null);
    const u1 = blocks.find((b) => b.id === "u1");
    const u2 = blocks.find((b) => b.id === "u2");
    expect(u1?.kind).toBe("user");
    if (u1?.kind === "user") {
      expect(u1.text).toBe("see");
      expect(u1.attachments).toEqual([
        { kind: "image", mime: "image/png", filename: "p.png", dataUrl: PNG_URL },
      ]);
    }
    expect(u2?.kind).toBe("user");
    if (u2?.kind === "user") expect(u2.attachments).toBeUndefined();
  });

  it("pending turn echoes text + attachments; guard compares text + filenames", () => {
    const attachments = [
      { kind: "image" as const, mime: "image/png", filename: "p.png", dataUrl: PNG_URL },
    ];
    const blocks = buildBlocks([], null, true, {
      text: "draft",
      attachments,
    });
    const pending = blocks.find((b) => b.id === "__pending_user__");
    expect(pending?.kind).toBe("user");
    if (pending?.kind === "user") {
      expect(pending.text).toBe("draft");
      expect(pending.attachments).toEqual(attachments);
      expect(pending.optimistic).toBe(true);
    }

    // Matching text + filename sequence already persisted → suppressed.
    const persisted = buildBlocks(
      [
        userMessage("u1", [
          { type: "text", text: "draft" },
          { type: "file", data: PNG_URL, mediaType: "image/png", filename: "p.png" },
        ]),
      ],
      null,
      true,
      { text: "draft", attachments },
    );
    expect(
      persisted.some((b) => b.id === "__pending_user__"),
    ).toBe(false);

    // Same text but a DIFFERENT filename sequence → echo stays.
    const renamed = buildBlocks(
      [
        userMessage("u1", [
          { type: "text", text: "draft" },
          { type: "file", data: PNG_URL, mediaType: "image/png", filename: "other.png" },
        ]),
      ],
      null,
      true,
      { text: "draft", attachments },
    );
    expect(renamed.some((b) => b.id === "__pending_user__")).toBe(true);
  });

  it("attachment-only pending turn (empty text) still echoes", () => {
    const attachments = [
      { kind: "text" as const, mime: "text/csv", filename: "d.csv", dataUrl: "data:text/csv;base64,YTEsYg==" },
    ];
    const blocks = buildBlocks([], null, true, { text: "", attachments });
    const pending = blocks.find((b) => b.id === "__pending_user__");
    expect(pending?.kind).toBe("user");
    if (pending?.kind === "user") expect(pending.text).toBe("");
  });

  it("consecutive attachment-only turns: different filenames keep the echo, identical suppress it", () => {
    const turn = (filename: string) => [
      {
        kind: "image" as const,
        mime: "image/png",
        filename,
        dataUrl: PNG_URL,
      },
    ];

    // Persisted first turn (attachment-only, text ""); pending second turn
    // carries a DIFFERENT file — text "" would match text-only and
    // false-suppress the echo.
    const different = buildBlocks(
      [
        userMessage("u1", [
          { type: "file", data: PNG_URL, mediaType: "image/png", filename: "a.png" },
        ]),
      ],
      null,
      true,
      { text: "", attachments: turn("b.png") },
    );
    expect(different.some((b) => b.id === "__pending_user__")).toBe(true);

    // Identical filename sequence → suppressed (guard working).
    const identical = buildBlocks(
      [
        userMessage("u1", [
          { type: "file", data: PNG_URL, mediaType: "image/png", filename: "a.png" },
        ]),
      ],
      null,
      true,
      { text: "", attachments: turn("a.png") },
    );
    expect(identical.some((b) => b.id === "__pending_user__")).toBe(false);
  });

  it("text-only pending turn still suppresses against matching text-only message (0 === 0 attachments)", () => {
    const persisted = buildBlocks(
      [userMessage("u1", "draft")],
      null,
      true,
      { text: "draft", attachments: [] },
    );
    expect(
      persisted.some((b) => b.id === "__pending_user__"),
    ).toBe(false);
  });

  it("null pending turn renders no optimistic block", () => {
    const blocks = buildBlocks([], null, false, null);
    expect(blocks.some((b) => b.id === "__pending_user__")).toBe(false);
  });
});
