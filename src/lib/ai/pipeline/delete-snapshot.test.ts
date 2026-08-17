import { describe, expect, it } from "vitest";
import type { ModelMessage, ToolResultPart } from "ai";

// stripDeleteSnapshots is NOT re-exported from the top-level @/lib/ai barrel —
// import it from the pipeline barrel (per its module docstring).
import { stripDeleteSnapshots } from "@/lib/ai/pipeline";

// ─── Fixtures ─────────────────────────────────────────────────────────────

/** The json variant of a tool-result output. */
type JsonOutput = Extract<ToolResultPart["output"], { type: "json" }>;

function toolMessage(toolCallId: string, output: JsonOutput): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId, toolName: "delete_world", output }],
  };
}

function deleteSnapshotThread(): ModelMessage[] {
  return [
    { role: "user", content: "delete Rome" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-del",
          toolName: "delete_world",
          input: { id: "w-1" },
        },
      ],
    },
    toolMessage("call-del", {
      type: "json",
      value: {
        deleted: true,
        id: "w-1",
        snapshot: { id: "w-1", name: "Rome", description: "very long prose…" },
      },
    }),
  ];
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("stripDeleteSnapshots", () => {
  it("returns the SAME array reference when nothing matches", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];
    expect(stripDeleteSnapshots(messages)).toBe(messages);
  });

  it("ignores legacy { deleted: true, id } results without a snapshot", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "delete" },
      toolMessage("call-legacy", {
        type: "json",
        value: { deleted: true, id: "w-legacy" },
      }),
    ];
    expect(stripDeleteSnapshots(messages)).toBe(messages);
  });

  it("ignores deleted: false results", () => {
    const messages: ModelMessage[] = [
      toolMessage("call-false", {
        type: "json",
        value: { deleted: false, id: "w-2", snapshot: { name: "x" } },
      }),
    ];
    expect(stripDeleteSnapshots(messages)).toBe(messages);
  });

  it("rewrites the output to { deleted, id, name } when snapshot.name is a string", () => {
    const messages = deleteSnapshotThread();

    const out = stripDeleteSnapshots(messages);

    expect(out).not.toBe(messages);
    // Untouched messages keep their identity.
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);
    // The tool message is rebuilt with the compact echo.
    expect(out[2]).not.toBe(messages[2]);
    const content = out[2]?.content;
    if (!Array.isArray(content)) {
      throw new Error("expected tool message with array content");
    }
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({
      type: "tool-result",
      toolCallId: "call-del",
      toolName: "delete_world",
      output: { type: "json", value: { deleted: true, id: "w-1", name: "Rome" } },
    });
    // The snapshot prose never reaches the model.
    expect(JSON.stringify(out)).not.toContain("very long prose");
    expect(JSON.stringify(out)).not.toContain("snapshot");
  });

  it("omits name when the snapshot has no string name", () => {
    const messages = [
      toolMessage("call-noname", {
        type: "json",
        value: {
          deleted: true,
          id: "w-3",
          snapshot: { id: "w-3", title: "no name field" },
        },
      }),
    ];

    const out = stripDeleteSnapshots(messages);

    const content = out[0]?.content;
    if (!Array.isArray(content)) {
      throw new Error("expected tool message with array content");
    }
    expect(content[0]).toEqual({
      type: "tool-result",
      toolCallId: "call-noname",
      toolName: "delete_world",
      output: { type: "json", value: { deleted: true, id: "w-3" } },
    });
  });

  it("keeps non-json outputs (e.g. text) untouched inside a matching thread", () => {
    const messages: ModelMessage[] = [
      toolMessage("call-text", {
        type: "json",
        value: { deleted: true, id: "w-4", snapshot: { name: "Venice" } },
      }),
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-plain",
            toolName: "other_tool",
            output: { type: "text", value: "not a delete" },
          },
        ],
      },
    ];

    const out = stripDeleteSnapshots(messages);

    // Second message has no matching result → keeps identity.
    expect(out[1]).toBe(messages[1]);
    const plainContent = out[1]?.content;
    if (!Array.isArray(plainContent)) {
      throw new Error("expected array content");
    }
    expect(plainContent[0]).toEqual({
      type: "tool-result",
      toolCallId: "call-plain",
      toolName: "other_tool",
      output: { type: "text", value: "not a delete" },
    });
  });

  it("does not mutate the input thread", () => {
    const messages = deleteSnapshotThread();
    const snapshot = JSON.parse(JSON.stringify(messages));

    stripDeleteSnapshots(messages);

    expect(JSON.parse(JSON.stringify(messages))).toEqual(snapshot);
  });

  it("is pure — the same input twice yields equal, distinct arrays", () => {
    const messages = deleteSnapshotThread();
    const a = stripDeleteSnapshots(messages);
    const b = stripDeleteSnapshots(messages);
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
