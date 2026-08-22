/**
 * Pair-expansion tests for user-initiated message mutations (ADR-0047).
 *
 * Fixtures follow the `SessionMessage` shapes used by
 * `src/lib/ai/session/agent.test.ts` (AI SDK v3 `ModelMessage` part unions:
 * assistant `tool-call` parts carry `toolCallId`; tool-role messages carry
 * `tool-result` parts with `toolCallId`). `SessionMessage.id` is a plain
 * string (not branded), so deterministic `msg-N` ids are fine.
 */

import { describe, expect, it } from "vitest";

import type { ModelMessage, SessionMessage } from "@/lib/ai";
import { expandDeleteIds, replaceMessageText } from "./message-mutations";

// ─── Fixtures ──────────────────────────────────────────────────────────────

/** Wrap a ModelMessage with deterministic persistence metadata. */
function sess(message: ModelMessage, n: number): SessionMessage {
  return {
    ...message,
    id: `msg-${n}`,
    sessionId: "conv-1",
    createdAt: `2026-01-01T00:00:${String(n).padStart(2, "0")}.000Z`,
  };
}

function user(content: string, n: number): SessionMessage {
  return sess({ role: "user", content }, n);
}

function assistantText(text: string, n: number): SessionMessage {
  return sess({ role: "assistant", content: [{ type: "text", text }] }, n);
}

function assistantCalls(
  calls: Array<{ id: string; name: string }>,
  n: number,
): SessionMessage {
  return sess(
    {
      role: "assistant",
      content: calls.map((c) => ({
        type: "tool-call" as const,
        toolCallId: c.id,
        toolName: c.name,
        input: { q: c.id },
      })),
    },
    n,
  );
}

function toolResults(
  callIds: string[],
  n: number,
): SessionMessage {
  return sess(
    {
      role: "tool",
      content: callIds.map((id) => ({
        type: "tool-result" as const,
        toolCallId: id,
        toolName: "lookup",
        output: { type: "text" as const, value: `out:${id}` },
      })),
    },
    n,
  );
}

/**
 * The canonical pair-aware thread: two full turns, each with an
 * assistant-tool group, plus a plain text-only turn in between.
 *
 * ```
 * msg-1 user        "q1"
 * msg-2 assistant   tool-call tc-1, tc-2
 * msg-3 tool        tool-result tc-1
 * msg-4 tool        tool-result tc-2
 * msg-5 user        "q2"
 * msg-6 assistant   tool-call tc-3
 * msg-7 tool        tool-result tc-3
 * msg-8 user        "q3"
 * msg-9 assistant   text "done"
 * ```
 */
function fullThread(): SessionMessage[] {
  return [
    user("q1", 1),
    assistantCalls(
      [
        { id: "tc-1", name: "lookup" },
        { id: "tc-2", name: "search" },
      ],
      2,
    ),
    toolResults(["tc-1"], 3),
    toolResults(["tc-2"], 4),
    user("q2", 5),
    assistantCalls([{ id: "tc-3", name: "lookup" }], 6),
    toolResults(["tc-3"], 7),
    user("q3", 8),
    assistantText("done", 9),
  ];
}

// ─── expandDeleteIds ───────────────────────────────────────────────────────

describe("expandDeleteIds", () => {
  it("user target → [target] only", () => {
    const ids = expandDeleteIds(fullThread(), "msg-1");
    expect(ids).toEqual(["msg-1"]);
  });

  it("assistant with 2 tool-calls + 2 answering tool messages → all 3 deleted; a LATER unrelated assistant/tool group survives", () => {
    const ids = expandDeleteIds(fullThread(), "msg-2");
    // The first group collapses wholesale…
    expect(ids).toEqual(["msg-2", "msg-3", "msg-4"]);
    // …and nothing from the later group (msg-6/msg-7) is touched: the
    // surviving ids (complement) keep the second pair fully intact.
    const survivors = fullThread()
      .map((m) => m.id)
      .filter((id) => !ids?.includes(id));
    expect(survivors).toEqual(["msg-1", "msg-5", "msg-6", "msg-7", "msg-8", "msg-9"]);
  });

  it("assistant target also swallows a single tool message answering BOTH calls (merged results)", () => {
    const thread = [
      user("q1", 1),
      assistantCalls(
        [
          { id: "tc-1", name: "lookup" },
          { id: "tc-2", name: "search" },
        ],
        2,
      ),
      toolResults(["tc-1", "tc-2"], 3),
      assistantText("after", 4),
    ];
    expect(expandDeleteIds(thread, "msg-2")).toEqual(["msg-2", "msg-3"]);
  });

  it("assistant target without tool calls → [target]", () => {
    expect(expandDeleteIds(fullThread(), "msg-9")).toEqual(["msg-9"]);
  });

  it("tool target → parent assistant + ALL sibling tool messages included", () => {
    // Targeting the FIRST tool message still removes its sibling (msg-4):
    // the parent's other call (tc-2) must not dangle.
    expect(expandDeleteIds(fullThread(), "msg-3")).toEqual([
      "msg-2",
      "msg-3",
      "msg-4",
    ]);
    // Targeting the SECOND tool message removes the same group.
    expect(expandDeleteIds(fullThread(), "msg-4")).toEqual([
      "msg-2",
      "msg-3",
      "msg-4",
    ]);
  });

  it("tool target from the LATER group → only that group's parent + siblings", () => {
    expect(expandDeleteIds(fullThread(), "msg-7")).toEqual(["msg-6", "msg-7"]);
  });

  it("orphan tool message (no parent assistant) → [target] (defensive)", () => {
    const thread = [user("q1", 1), toolResults(["tc-x"], 2)];
    expect(expandDeleteIds(thread, "msg-2")).toEqual(["msg-2"]);
  });

  it("unknown id → null", () => {
    expect(expandDeleteIds(fullThread(), "nope")).toBeNull();
  });

  it("empty thread → null", () => {
    expect(expandDeleteIds([], "msg-1")).toBeNull();
  });
});

// ─── replaceMessageText ────────────────────────────────────────────────────

describe("replaceMessageText", () => {
  it("user string content, partIndex null → new string content; input not mutated", () => {
    const original = user("q1", 1);
    const next = replaceMessageText(original, null, "edited");
    expect(next).not.toBeNull();
    expect(next).toMatchObject({ id: "msg-1", role: "user", content: "edited" });
    // Never mutates the input.
    expect(original.content).toBe("q1");
  });

  it("user array content → text part leads, file parts (data URL AND attachment:// ref) preserved in order", () => {
    const dataUrlFile = {
      type: "file" as const,
      mediaType: "image/png",
      filename: "sunset.png",
      data: "data:image/png;base64,QUJD",
    };
    const refFile = {
      type: "file" as const,
      mediaType: "text/markdown",
      filename: "notes.md",
      data: "attachment://a1",
    };
    const original = sess(
      {
        role: "user",
        content: [
          { type: "text", text: "look at these" },
          dataUrlFile,
          refFile,
        ],
      },
      2,
    );

    const next = replaceMessageText(original, null, "edited caption");

    expect(next).not.toBeNull();
    if (next?.role !== "user" || typeof next.content === "string") {
      throw new Error("expected user parts array");
    }
    expect(next.content).toEqual([
      { type: "text", text: "edited caption" },
      dataUrlFile, // untouched, same reference position
      refFile,
    ]);
    // Original untouched.
    const originalContent = original.content;
    if (typeof originalContent === "string") throw new Error("unreachable");
    expect(originalContent[0]).toEqual({ type: "text", text: "look at these" });
  });

  it("user with a non-null partIndex → null (no per-part user edits)", () => {
    expect(replaceMessageText(user("q1", 1), 0, "x")).toBeNull();
  });

  it("assistant string content, partIndex null → new string content", () => {
    const original = sess({ role: "assistant", content: "answer" }, 3);
    const next = replaceMessageText(original, null, "edited answer");
    expect(next).toMatchObject({ id: "msg-3", role: "assistant", content: "edited answer" });
    expect(original.content).toBe("answer");
  });

  it("assistant array content, partIndex n → replaces ONLY the text part at n; tool-call and other text parts survive", () => {
    const original = sess(
      {
        role: "assistant",
        content: [
          { type: "text", text: "first block" },
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "lookup",
            input: { q: "x" },
          },
          { type: "text", text: "second block" },
        ],
      },
      4,
    );

    const next = replaceMessageText(original, 2, "edited block");

    expect(next).not.toBeNull();
    if (next?.role !== "assistant" || typeof next.content === "string") {
      throw new Error("expected assistant parts array");
    }
    expect(next.content).toEqual([
      { type: "text", text: "first block" },
      {
        type: "tool-call",
        toolCallId: "tc-1",
        toolName: "lookup",
        input: { q: "x" },
      },
      { type: "text", text: "edited block" },
    ]);
    // Original untouched.
    const originalContent = original.content;
    if (typeof originalContent === "string") throw new Error("unreachable");
    expect(originalContent[2]).toEqual({ type: "text", text: "second block" });
  });

  it("assistant partIndex pointing at a non-text (tool-call) part → null", () => {
    const original = assistantCalls([{ id: "tc-1", name: "lookup" }], 5);
    expect(replaceMessageText(original, 0, "x")).toBeNull();
  });

  it("assistant partIndex out of range → null", () => {
    const original = assistantText("only block", 6);
    expect(replaceMessageText(original, 7, "x")).toBeNull();
    expect(replaceMessageText(original, -1, "x")).toBeNull();
  });

  it("assistant partIndex null on array content → null (ambiguous which text block)", () => {
    const original = sess(
      {
        role: "assistant",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      },
      7,
    );
    expect(replaceMessageText(original, null, "x")).toBeNull();
  });

  it("assistant non-null partIndex on string content → null", () => {
    const original = sess({ role: "assistant", content: "plain" }, 8);
    expect(replaceMessageText(original, 0, "x")).toBeNull();
  });

  it("tool / system roles → null", () => {
    expect(replaceMessageText(toolResults(["tc-1"], 9), null, "x")).toBeNull();
    expect(
      replaceMessageText(sess({ role: "system", content: "sys" }, 10), null, "x"),
    ).toBeNull();
  });
});
