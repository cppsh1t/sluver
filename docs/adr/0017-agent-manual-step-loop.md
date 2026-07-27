# Agent drives a manual step loop over `streamText`

**Status**: accepted.

The Agent class wraps AI SDK v7's `streamText` in a manually-driven step loop. Each iteration calls `streamText({ stopWhen: stepCountIs(1), ... })` for exactly one LLM step, consumes the resulting stream to emit lifecycle events, awaits the step's `responseMessages` and `finalStep`, appends them to the running message list, then checks termination conditions (abort, error, model-natural-stop, or `maxSteps`) before continuing or exiting.

The decisive reason is control over event emission at step boundaries. This is the core invariant borrowed from the pi-agent architecture: the loop emits, it never decides how to display. The SDK's built-in multi-step loop (`stopWhen: hasToolCall(...)`) and the `ToolLoopAgent` class both hide iteration internals, which makes inter-step recovery awkward and reduces the Agent to a thin event-pass-through. A manual loop also creates a natural seam where a future recovery wrapper (retry, context-compaction, model-fallback) can plug in between steps without fighting the SDK's internal control flow.

Tradeoffs:

- The Agent class owns roughly 150 lines of loop-driving logic that the SDK would otherwise handle. In exchange, the event taxonomy, the error-as-event pattern (ADR-0018), and the future recovery seam are all first-class.
- The two rejected alternatives remain viable if the manual loop proves brittle in practice. Switching back is mostly a matter of removing the wrapper, since the message-list shape and event names are unchanged.
