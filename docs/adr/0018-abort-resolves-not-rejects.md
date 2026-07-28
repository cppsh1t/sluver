# All run terminations resolve; errors surface via `result.error`

**Status**: accepted (revised — originally only abort resolved; now all terminations resolve).

Every termination outcome of an `AgentLoop.run()` — success, abort, error, max-steps — resolves `handle.result` with an `AgentLoopRunResult`. The promise **never rejects**. Callers discriminate outcomes via `result.finishReason` (`'stop'` | `'aborted'` | `'error'` | `'max-steps'` | `'length'` | `'content-filter'` | `'other'`) and inspect `result.error` (present iff `finishReason === 'error'`).

The original version of this ADR (accepted pre-session-layer) made only abort resolve while stream-terminating errors rejected. That decision was revised when the session layer (`Agent`, ADR-0020) needed to persist partial messages even on error — rejecting threw away the entire `AgentLoopRunResult` (including accumulated messages from prior successful steps), making error recovery impossible at the persistence layer.

The `#executeStep` error path now best-effort salvages `result.responseMessages` (whatever the model produced before the error) and includes them as `partialMessages` on the errored step outcome. The `#runLoop` pushes those partials into the working message array. `#buildResult` returns the result (with `error` field set) instead of throwing.

Tradeoffs:

- Callers must check `result.finishReason` / `result.error` instead of using try/catch on `handle.result`. This is consistent — the same switch works for every termination, no doubled termination-handling surface.
- The rejected alternative was keeping error-as-reject and having the session layer subscribe to events to reconstruct partial messages from deltas. That duplicates the SDK's internal accumulation and is fragile (delta-to-message reassembly doesn't guarantee schema correctness).
- A truly unexpected bug inside the loop itself (not a model/stream error) would also resolve rather than throw. This is more robust — the caller always gets a result object to inspect, never a raw unhandled rejection.
