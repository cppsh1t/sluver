import { describe, expect, it } from "vitest";
import type { ModelMessage, ToolResultPart } from "ai";

import { compactToolCalls, deriveStatus } from "./tool-compactor";

// ─── Fixtures ─────────────────────────────────────────────────────────────

/** Policy shorthand for tests. */
const policy = (enabled: boolean, turnAge: number) => ({ enabled, turnAge });

/** A successful text tool-result output. */
const okOutput = (value: string) => ({ type: "text" as const, value });

/** A thread of one aged turn: user �?pure-tool assistant �?tool result. */
function pureToolTurn(
  messageId: string,
  userText: string,
): ModelMessage[] {
  return [
    { role: "user", content: userText },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: `call-${messageId}`,
          toolName: "lookup",
          input: { q: messageId },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: `call-${messageId}`,
          toolName: "lookup",
          output: okOutput(`result-${messageId}`),
        },
      ],
    },
  ];
}

/** Extract the single text-part (or string) content of a message. */
function textContent(message: ModelMessage | undefined): string {
  if (!message) return "";
  const { content } = message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

// ─── deriveStatus ─────────────────────────────────────────────────────────

describe("deriveStatus", () => {
  const part = (output: ToolResultPart["output"]): ToolResultPart => ({
    type: "tool-result",
    toolCallId: "call-x",
    toolName: "lookup",
    output,
  });

  it("maps execution-denied to denied", () => {
    expect(deriveStatus(part({ type: "execution-denied" }))).toBe("denied");
  });

  it("maps error-text and error-json to failed", () => {
    expect(deriveStatus(part({ type: "error-text", value: "boom" }))).toBe(
      "failed",
    );
    expect(deriveStatus(part({ type: "error-json", value: { err: 1 } }))).toBe(
      "failed",
    );
  });

  it("maps text, json and content outputs to succeeded", () => {
    expect(deriveStatus(part({ type: "text", value: "ok" }))).toBe(
      "succeeded",
    );
    expect(deriveStatus(part({ type: "json", value: { ok: true } }))).toBe(
      "succeeded",
    );
    expect(
      deriveStatus(part({ type: "content", value: [] })),
    ).toBe("succeeded");
  });
});

// ─── No-op cases ──────────────────────────────────────────────────────────

describe("compactToolCalls no-op cases", () => {
  it("returns the SAME array reference when the policy is disabled", () => {
    const messages = pureToolTurn("1", "hello");
    expect(compactToolCalls(messages, policy(false, 0))).toBe(messages);
  });

  it("returns the SAME array reference when nothing is aged enough", () => {
    // Single turn �?age 0; turnAge 3 keeps it verbatim.
    const messages = pureToolTurn("1", "hello");
    expect(compactToolCalls(messages, policy(true, 3))).toBe(messages);
  });

  it("returns the SAME array reference for an empty thread", () => {
    const messages: ModelMessage[] = [];
    expect(compactToolCalls(messages, policy(true, 0))).toBe(messages);
  });

  it("compacts nothing when there is no user message (sole age-0 turn)", () => {
    const messages: ModelMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-orphan",
            toolName: "lookup",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-orphan",
            toolName: "lookup",
            output: okOutput("x"),
          },
        ],
      },
    ];
    // No user message → the only turn is age 0 → nothing reaches turnAge 1.
    expect(compactToolCalls(messages, policy(true, 1))).toBe(messages);
  });
});

// ─── Rule 1: pure-tool assistant ─────────────────────────────────────────

describe("compactToolCalls Rule 1 (pure-tool assistant)", () => {
  it("collapses an aged assistant+tool pair into ONE user message with the stub line", () => {
    const messages = [...pureToolTurn("1", "first"), ...pureToolTurn("2", "second")];

    const out = compactToolCalls(messages, policy(true, 1));

    // Turn 0 (age 1) compacted; turn 1 (age 0) untouched.
    expect(out.map((m) => m.role)).toEqual([
      "user", // "first"
      "user", // stub for call-1
      "user", // "second"
      "assistant", // call-2 verbatim
      "tool", // result-2 verbatim
    ]);
    // The aged pair's assistant + tool messages are gone�?    expect(out[1]?.role).toBe("user");
    expect(textContent(out[1])).toBe(
      "[tool_call call-1] lookup \u2192 succeeded",
    );
    // …while the age-0 pair keeps its originals by identity (indices 4 and 5
    // of the input thread — the aged pair at 1–2 was replaced by one message).
    expect(out[3]).toBe(messages[4]);
    expect(out[4]).toBe(messages[5]);
  });

  it("joins one stub line per tool call with newlines", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-a",
            toolName: "alpha",
            input: {},
          },
          {
            type: "tool-call",
            toolCallId: "call-b",
            toolName: "beta",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-a",
            toolName: "alpha",
            output: okOutput("a"),
          },
          {
            type: "tool-result",
            toolCallId: "call-b",
            toolName: "beta",
            output: { type: "error-text", value: "nope" },
          },
        ],
      },
      { role: "user", content: "follow-up" },
    ];

    const out = compactToolCalls(messages, policy(true, 1));

    expect(out).toHaveLength(3); // user question, stub user, follow-up
    expect(textContent(out[1])).toBe(
      "[tool_call call-a] alpha \u2192 succeeded\n[tool_call call-b] beta \u2192 failed",
    );
  });

  it("uses the failed fallback when the tool result is missing entirely", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-lonely",
            toolName: "lookup",
            input: {},
          },
        ],
      },
      { role: "user", content: "next" },
    ];

    const out = compactToolCalls(messages, policy(true, 1));

    expect(textContent(out[1])).toBe(
      "[tool_call call-lonely] lookup \u2192 failed",
    );
  });

  it("does not mutate the input thread", () => {
    const messages = [...pureToolTurn("1", "first"), ...pureToolTurn("2", "second")];
    const snapshot = JSON.parse(JSON.stringify(messages)) as ModelMessage[];

    compactToolCalls(messages, policy(true, 0));

    expect(messages).toEqual(snapshot);
    expect(messages).toHaveLength(6);
  });
});

// ─── Rule 2: mixed-content assistant ─────────────────────────────────────

describe("compactToolCalls Rule 2 (mixed assistant content)", () => {
  function mixedThread(): ModelMessage[] {
    return [
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          {
            type: "tool-call",
            toolCallId: "call-mixed",
            toolName: "lookup",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-mixed",
            toolName: "lookup",
            output: okOutput("found"),
          },
        ],
      },
      { role: "user", content: "and now?" },
    ];
  }

  it("replaces the tool-call part IN PLACE with a text stub and drops the tool message", () => {
    const messages = mixedThread();
    const contentBefore = messages[1]?.content;
    if (typeof contentBefore === "string" || !Array.isArray(contentBefore)) {
      throw new Error("expected array content");
    }
    const originalTextPart = contentBefore.find((part) => part.type === "text");

    const out = compactToolCalls(messages, policy(true, 1));

    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const assistant = out[1];
    expect(assistant).not.toBe(messages[1]); // fresh message object
    const content = assistant?.content;
    if (typeof content === "string" || !Array.isArray(content)) {
      throw new Error("expected array content");
    }
    expect(content).toHaveLength(2);
    // Text part preserved verbatim, in position, by identity.
    expect(content[0]).toBe(originalTextPart);
    expect(content[0]).toEqual({ type: "text", text: "let me check" });
    // Tool-call part replaced in-place by a text part with the stub.
    expect(content[1]).toEqual({
      type: "text",
      text: "[tool_call call-mixed] lookup \u2192 succeeded",
    });
  });

  it("keeps a same-message tool-call that is NOT aged enough untouched", () => {
    // The mixed pair sits in turn 0 (age 1); turnAge 2 keeps it verbatim.
    const messages = mixedThread();
    expect(compactToolCalls(messages, policy(true, 2))).toBe(messages);
  });

  it("keeps the original thread immutable (Rule 2 path)", () => {
    const messages = mixedThread();
    const snapshot = JSON.parse(JSON.stringify(messages)) as ModelMessage[];

    compactToolCalls(messages, policy(true, 1));

    expect(messages).toEqual(snapshot);
    const originalContent = messages[1]?.content;
    expect(
      Array.isArray(originalContent)
        && originalContent.some((p) => p.type === "tool-call"),
    ).toBe(true);
  });
});

// ─── Skill-tool exemption (ADR-0043 §4 — amendment to ADR-0031) ───────────

describe("compactToolCalls skill-tool exemption (ADR-0043)", () => {
  /** A thread with one aged `activate_skill` pair AND one aged normal pair. */
  function mixedAgedThread(): ModelMessage[] {
    return [
      { role: "user", content: "use the skill" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-skill",
            toolName: "activate_skill",
            input: { name: "prose-style" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-skill",
            toolName: "activate_skill",
            output: okOutput("# skill instructions"),
          },
        ],
      },
      { role: "user", content: "look something up" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-lookup",
            toolName: "lookup",
            input: { q: "x" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-lookup",
            toolName: "lookup",
            output: okOutput("found"),
          },
        ],
      },
      { role: "user", content: "now" },
    ];
  }

  it("keeps an aged activate_skill pair uncompacted while an aged normal pair still stubs", () => {
    const messages = mixedAgedThread();

    const out = compactToolCalls(messages, policy(true, 1));

    // Both pairs sit in aged turns (ages 2 and 1, turnAge 1) — but only the
    // normal lookup pair stubs; the activate_skill pair survives verbatim.
    expect(out.map((m) => m.role)).toEqual([
      "user", // "use the skill"
      "assistant", // activate_skill call — VERBATIM (exempt)
      "tool", // activate_skill result — VERBATIM (exempt)
      "user", // "look something up"
      "user", // stub for call-lookup
      "user", // "now"
    ]);
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
    expect(textContent(out[4])).toBe(
      "[tool_call call-lookup] lookup \u2192 succeeded",
    );
  });

  it("keeps an aged activate_skill pair uncompacted even at turnAge 0", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-skill-0",
            toolName: "activate_skill",
            input: { name: "prose-style" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-skill-0",
            toolName: "activate_skill",
            output: okOutput("# skill instructions"),
          },
        ],
      },
      { role: "user", content: "current" },
    ];

    const out = compactToolCalls(messages, policy(true, 0));

    expect(out).toHaveLength(4);
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).toBe(messages[2]);
  });

  it("stubs read_skill_file pairs normally (only activate_skill is exempt)", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-read",
            toolName: "read_skill_file",
            input: { name: "prose-style", path: "refs/style.md" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-read",
            toolName: "read_skill_file",
            output: okOutput("reference text"),
          },
        ],
      },
      { role: "user", content: "current" },
    ];

    const out = compactToolCalls(messages, policy(true, 1));

    expect(out.map((m) => m.role)).toEqual(["user", "user", "user"]);
    expect(textContent(out[1])).toBe(
      "[tool_call call-read] read_skill_file \u2192 succeeded",
    );
  });
});

// ─── Turn-age semantics ───────────────────────────────────────────────────

describe("compactToolCalls turn-age semantics", () => {
  it("treats the last turn as age 0 and counts ages backwards", () => {
    // Three turns: t0 (age 2), t1 (age 1), t2 (age 0).
    const messages: ModelMessage[] = [
      ...pureToolTurn("1", "q1"),
      ...pureToolTurn("2", "q2"),
      { role: "user", content: "q3" },
    ];

    // turnAge 2 compacts ONLY t0 (age 2): t1 (age 1) survives verbatim.
    const out2 = compactToolCalls(messages, policy(true, 2));
    expect(out2.map((m) => m.role)).toEqual([
      "user", // q1
      "user", // stub call-1
      "user", // q2
      "assistant", // call-2 verbatim
      "tool", // result-2 verbatim
      "user", // q3
    ]);

    // turnAge 1 compacts both t0 and t1.
    const out1 = compactToolCalls(messages, policy(true, 1));
    expect(out1.map((m) => m.role)).toEqual([
      "user", // q1
      "user", // stub call-1
      "user", // q2
      "user", // stub call-2
      "user", // q3
    ]);
  });

  it("turnAge 0 compacts every prior turn but preserves the current one", () => {
    const messages: ModelMessage[] = [
      ...pureToolTurn("1", "q1"),
      { role: "user", content: "current" },
    ];

    const out = compactToolCalls(messages, policy(true, 0));

    expect(out.map((m) => m.role)).toEqual(["user", "user", "user"]);
    expect(textContent(out[1])).toBe(
      "[tool_call call-1] lookup \u2192 succeeded",
    );
    expect(textContent(out[2])).toBe("current");
  });

  it("keeps tool results with a fresh call when ONLY the older call aged", () => {
    // Turn ages: call-old's turn is age 2, call-new's turn is age 1, the last
    // user message is age 0. With turnAge 2 only call-old compacts; the
    // fresh call-new pair survives verbatim.
    const messages: ModelMessage[] = [
      { role: "user", content: "q1" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-old",
            toolName: "lookup",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-old",
            toolName: "lookup",
            output: okOutput("old"),
          },
        ],
      },
      { role: "user", content: "q2" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "again" },
          {
            type: "tool-call",
            toolCallId: "call-new",
            toolName: "lookup",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-new",
            toolName: "lookup",
            output: okOutput("new"),
          },
        ],
      },
      { role: "user", content: "q3" },
    ];

    const out = compactToolCalls(messages, policy(true, 2));

    expect(out.map((m) => m.role)).toEqual([
      "user", // q1
      "user", // stub call-old
      "user", // q2
      "assistant", // mixed — call-new untouched, identity preserved
      "tool", // result-new survives
      "user", // q3
    ]);
    expect(out[3]).toBe(messages[4]); // aged-below-threshold assistant verbatim
    expect(out[4]).toBe(messages[5]); // fresh tool message verbatim
    const toolMessage = out[4];
    const toolContent = toolMessage?.content;
    if (!Array.isArray(toolContent)) {
      throw new Error("expected tool message with array content");
    }
    expect(toolContent).toHaveLength(1);
    expect(toolContent[0]).toEqual({
      type: "tool-result",
      toolCallId: "call-new",
      toolName: "lookup",
      output: okOutput("new"),
    });
  });
});
