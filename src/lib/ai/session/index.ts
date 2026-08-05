/**
 * Session layer barrel — stateful conversation wrapper + persistence contracts.
 *
 * - {@link ./store} — `SessionStore` interface, `SessionMessage`, `SessionRecord`.
 * - {@link ./agent}  — `Agent` class (stateful, wraps `AgentLoop`).
 * - {@link ./plan}   — `Plan` / `PlanItem` / `PlanStatus` types (ADR-0028).
 *
 * Related: ADR-0020 (session layer), ADR-0028 (three-layer message model).
 */

export { Agent, type AgentOptions } from "./agent";

export type { Plan, PlanItem, PlanStatus } from "./plan";

export {
  toModelMessage,
  toSessionMessage,
  type SessionInit,
  type SessionMessage,
  type SessionRecord,
  type SessionStore,
} from "./store";
