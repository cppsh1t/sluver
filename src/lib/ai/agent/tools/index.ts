/**
 * Test tools barrel — temporary stubs (add, time) exposed as a single
 * `testTools` ToolSet for end-to-end verification of the agent loop.
 * Replaced by real worldbook/novel tools in a future PR.
 */
import { addTool } from "./add";
import { timeTool } from "./time";
import type { ToolSet } from "ai";

export { addTool } from "./add";
export { timeTool } from "./time";

/** Temporary test tools to prove the tool-calling loop works. */
export const testTools: ToolSet = {
  add: addTool,
  time: timeTool,
};
