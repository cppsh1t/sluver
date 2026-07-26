/**
 * Test tool — returns the current time. Temporary stub to prove the
 * tool-calling loop works end-to-end; replaced by real tools later.
 */
import { tool } from "ai";
import { z } from "zod";

export const timeTool = tool({
  description: "Get the current date and time in ISO 8601 format.",
  inputSchema: z.object({}),
  execute: async () => ({ iso: new Date().toISOString() }),
});
