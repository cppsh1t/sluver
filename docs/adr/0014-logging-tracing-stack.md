# Logging stack: `tracing` + custom frontend bridge over `tauri-plugin-log`

**Status**: accepted.

Production-grade logging is built on the `tracing` ecosystem (`tracing`, `tracing-subscriber`, `tracing-appender`, `tracing-log`) plus a single custom Tauri command (`frontend_log`) that forwards frontend log calls into the same `tracing` subscriber, rather than using the official `tauri-plugin-log`.

The decisive factor is structured fields and spans. This app's three riskiest debugging surfaces all demand them:

- **Multi-database lock contention (ADR-0007).** `meta` + `space` + `worlds/{uuid}` connections are acquired in a strict order; getting it wrong deadlocks (ADR-0001 called this out explicitly). When a `SQLITE_BUSY` or lock-ordering bug shows up in production, the difference between "I can see which command, on which Space, hit which World" and "I have a string with the words glued in" is exactly the difference between `tracing` spans+fields and the `log` crate's flat facade.
- **Multi-window (ADR-0011).** Every Space runs in its own OS window. Untangling interleaved log lines requires `window_label` and `space_id` as first-class fields on every event.
- **Future AI provider HTTP calls (ADR-0012).** ~15 providers, each with latency/retry/malformed-response failure modes. Grepping `provider="openai" model="gpt-4o" tokens=1234 latency_ms=820` is the only sane way to read those events; string concatenation is not viable.

`tauri-plugin-log` uses the `log` facade and gives free webview console capture plus built-in file rotation, but it cannot express structured fields or spans. The `tracing-log` bridge ensures every `log::*` emit from dependencies (tauri, rusqlite, reqwest, tokio, etc.) is absorbed into the `tracing` subscriber, so no dependency output is lost.

Tradeoffs:

- The frontend forwarding shim costs roughly one day upfront (one Tauri command + a `src/lib/logger/` module with bootstrap buffering, level sync, and `windowLabel` auto-injection). This is small relative to the value of structured fields for this codebase.
- `tracing-appender` only supports time-based rotation (daily/hourly/minutely), not size-based. Accepted for a desktop writing app where daily INFO volume is bounded to a few MB.
- `EnvFilter` provides per-module verbosity (`RUST_LOG=sluver::ai=trace,reqwest=warn`), which is significantly more capable than `tauri-plugin-log`'s level-only control.
