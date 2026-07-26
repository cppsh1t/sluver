/**
 * Test tool — adds two numbers. Temporary stub to prove the tool-calling
 * loop works end-to-end; replaced by real worldbook/novel tools later.
 */
import { tool } from "ai";
import { z } from "zod";

export const addTool = tool({
  description: "Add two numbers and return the sum. Use for any math addition.",
  inputSchema: z.object({
    a: z.number().describe("First number"),
    b: z.number().describe("Second number"),
  }),
  execute: async ({ a, b }) => ({ sum: a + b }),
});
