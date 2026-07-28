/**
 * Session layer barrel — stateful conversation wrapper + persistence contracts.
 *
 * - {@link ./store} — `SessionStore` interface, `SessionMessage`, `SessionRecord`.
 * - {@link ./agent}  — `Agent` class (stateful, wraps `AgentLoop`).
 *
 * Related: ADR-0020 (session layer).
 */

export { Agent, type AgentOptions } from "./agent";

export {
  toModelMessage,
  toSessionMessage,
  type SessionInit,
  type SessionMessage,
  type SessionRecord,
  type SessionStore,
} from "./store";
