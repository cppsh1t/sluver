import { describe, expect, it } from "vitest";

import { composeSystemPrompt } from "./plan-injector";
import type { Plan } from "../session/plan";

const STATIC_PROMPT = "You are the Explorer role.";

const plan = (items: Plan["items"]): Plan => ({ items });

describe("composeSystemPrompt no-op cases", () => {
  it("returns the SAME string reference when the plan is null", () => {
    const out = composeSystemPrompt({ staticPrompt: STATIC_PROMPT, plan: null });
    expect(out).toBe(STATIC_PROMPT);
  });

  it("returns the SAME string reference when the plan has no items", () => {
    const out = composeSystemPrompt({
      staticPrompt: STATIC_PROMPT,
      plan: plan([]),
    });
    expect(out).toBe(STATIC_PROMPT);
  });
});

describe("composeSystemPrompt with an active plan", () => {
  const activePlan = plan([
    { text: "draft the outline", status: "done" },
    { text: "flesh out the harbor scene", status: "in_progress" },
    { text: "write the ending", status: "pending" },
  ]);

  it("appends a reminder block with counts, markers and active items in plan order", () => {
    const out = composeSystemPrompt({
      staticPrompt: STATIC_PROMPT,
      plan: activePlan,
    });

    expect(out).not.toBe(STATIC_PROMPT);
    expect(out.startsWith(STATIC_PROMPT)).toBe(true);
    expect(out).toContain("---");
    expect(out).toContain("## Current Plan (1 of 3 done), 1 in progress");
    // Active items rendered as bullets, in original order, with markers.
    expect(out).toContain("- [~] flesh out the harbor scene");
    expect(out).toContain("- [ ] write the ending");
    expect(
      out.indexOf("- [~] flesh out the harbor scene")
        < out.indexOf("- [ ] write the ending"),
    ).toBe(true);
    // Done items are hidden — only their count appears.
    expect(out).not.toContain("draft the outline");
    // Resume guidance is present when something is in progress.
    expect(out).toContain("resume them and mark each `done`");
  });

  it("uses the pending-only intro when nothing is in progress", () => {
    const out = composeSystemPrompt({
      staticPrompt: STATIC_PROMPT,
      plan: plan([
        { text: "first", status: "pending" },
        { text: "second", status: "done" },
      ]),
    });

    expect(out).toContain("## Current Plan (1 of 2 done)");
    expect(out).not.toContain("in progress");
    expect(out).toContain("Continue working through the pending items below");
    expect(out).toContain("- [ ] first");
    expect(out).not.toContain("second");
  });

  it("signals completion when every item is done (header kept, no bullets)", () => {
    const out = composeSystemPrompt({
      staticPrompt: STATIC_PROMPT,
      plan: plan([
        { text: "all done", status: "done" },
        { text: "also done", status: "done" },
      ]),
    });

    expect(out).toContain("## Current Plan (2 of 2 done)");
    expect(out).toContain(
      "All items complete; consider whether a new Plan is needed.",
    );
    expect(out).not.toContain("- [ ]");
    expect(out).not.toContain("- [~]");
  });

  it("is pure — repeated calls produce identical output", () => {
    const a = composeSystemPrompt({
      staticPrompt: STATIC_PROMPT,
      plan: activePlan,
    });
    const b = composeSystemPrompt({
      staticPrompt: STATIC_PROMPT,
      plan: activePlan,
    });
    expect(a).toBe(b);
  });
});
