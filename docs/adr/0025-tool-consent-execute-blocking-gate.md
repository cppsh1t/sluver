# Tool consent via execute-blocking approval gate

The AI agent runtime needs a tool consent mechanism — some tool calls must be explicitly approved by the user before executing. We implement this by injecting an `ApprovalGate` into each tool's `execute` closure, which blocks on a Promise resolved by the UI, rather than using the AI SDK v7's native `toolApproval` two-call pattern.

The SDK's native `toolApproval` would require modifying the pure `AgentLoop` (ADR-0017) to handle `tool-approval-request` stream parts, add new event variants, and change the loop's control flow to pause between steps. This conflicts with ADR-0019's purity boundary — the loop header explicitly lists "approval" as a concern the runtime "deliberately does not own."

The execute-blocking approach requires zero changes to `loop.ts`: the existing `tool_call` → `tool_result` event flow naturally handles the UI transitions. The tool's `execute` function simply awaits the gate before doing real work. When denied, `execute` throws a `ToolDeniedError`, which the SDK treats as a non-fatal `tool-error` — the model sees the denial and can adapt its approach.

Trade-off: this is not the SDK's "blessed" approval pattern. If Vercel adds features around `toolApproval` (automatic re-validation, HMAC signing), we won't benefit. But those features target HTTP request/response architectures (serverless functions where the client sends messages back); this is a desktop app where the Rust layer owns the runtime and the tool `execute` closures are long-lived, so they don't apply.
