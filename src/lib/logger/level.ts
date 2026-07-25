/**
 * Log threshold state + pub/sub.
 *
 * Default level is "info": the frontend logger mostly captures user-facing
 * events. Debug is React Query internals (noisy); trace is per-render
 * granularity. The Settings UI (3-tier verbosity, separate task) will call
 * {@link setLevel} at runtime; subscribers are notified synchronously so
 * any UI showing the current verbosity stays in sync without a re-fetch.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

/**
 * Precedence rank of each level. Higher number = more severe.
 *
 * A message at level L is forwarded iff `precedence(L) >= precedence(currentLevel)`.
 */
const PRECEDENCE: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

let currentLevel: LogLevel = 'info';

const subscribers = new Set<(level: LogLevel) => void>();

/** Precedence rank of a level (0-4). Exported so the dispatcher in index.ts can do the threshold check without duplicating the map. */
export function precedence(level: LogLevel): number {
  return PRECEDENCE[level];
}

/** Current active threshold. Messages at lower precedence are dropped. */
export function getLevel(): LogLevel {
  return currentLevel;
}

/**
 * Set a new threshold and synchronously notify all subscribers.
 *
 * No-op when the value is unchanged (subscribers are not called).
 */
export function setLevel(level: LogLevel): void {
  if (level === currentLevel) return;
  currentLevel = level;
  for (const cb of subscribers) cb(level);
}

/**
 * Subscribe to threshold changes. The callback is invoked synchronously
 * on every {@link setLevel} call that actually changes the value.
 *
 * @returns An unsubscribe function — call it to remove the callback.
 */
export function onLevelChange(cb: (level: LogLevel) => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
