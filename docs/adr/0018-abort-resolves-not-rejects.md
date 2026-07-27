# Abort resolves the result promise, does not reject

**Status**: accepted.

When an Agent run is aborted, either via the external `abortSignal` passed to `agent.run()` or via `handle.abort(reason?)`, the `handle.result` promise resolves with `{ finishReason: 'aborted', messages: [...input, ...partialResponses], ... }` rather than rejecting with an `AbortError`. Stream-terminating errors still reject with an `AgentError`; abort does not.

Abort is user intent, not failure. The two are semantically distinct and deserve different control-flow shapes. Resolving lets callers inspect partial work uniformly: the same `await handle.result` shape works for every termination outcome. It also aligns with the errors-as-events pattern, where abort surfaces as a terminal event inside the stream rather than as a thrown exception crossing the loop boundary.

Tradeoffs:

- The rejected alternative was rejecting with `AbortError`, the JavaScript convention (e.g. `fetch`). That conflation of user intent with errors would force callers to write both `try/catch` and `finishReason` switching, doubling the termination-handling surface.
- Callers must check `result.finishReason === 'aborted'` rather than catching. This is consistent with how the other non-error terminations (`'stop'`, `'max-steps'`, `'length'`) are already handled, so it adds no new pattern.
