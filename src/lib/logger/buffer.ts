/**
 * Bootstrap buffer: holds log entries that arrived before the Tauri IPC
 * bridge became ready, then flushes them in arrival order on demand.
 *
 * Bounded at {@link MAX_SIZE} so an environment where IPC never comes up
 * (e.g. a misconfigured test harness) cannot grow memory unbounded — the
 * oldest entries are dropped with a one-line warning per drop.
 */

import type { LogEntry } from './index';
import * as bridge from './bridge';

const MAX_SIZE = 200;

const queue: LogEntry[] = [];

/** Number of entries currently buffered (mainly for tests/debugging). */
export function size(): number {
  return queue.length;
}

/**
 * Append an entry to the buffer.
 *
 * If the buffer is already at capacity, the OLDEST entry is dropped first
 * (FIFO eviction) and a single warning is emitted to the console. Dropping
 * the oldest preserves the most recent context, which is almost always
 * what's relevant when triaging a flood.
 */
export function push(entry: LogEntry): void {
  if (queue.length >= MAX_SIZE) {
    queue.shift();
    // oxlint-disable-next-line no-console
    console.warn('[logger] buffer overflow, dropping oldest entry');
  }
  queue.push(entry);
}

/**
 * Flush the buffer to the bridge, preserving arrival order.
 *
 * Takes a snapshot and clears the queue first so concurrent {@link push}
 * calls during the async drain append to the next batch rather than
 * racing the iterator. Each entry is sent sequentially (not in parallel)
 * so the unified log file (ADR-0015) shows entries in true arrival order.
 *
 * On the FIRST send failure: the failed entry plus everything after it
 * (and anything that arrived during the drain) is re-pushed to the front
 * of the buffer in original order, and the flush aborts. This prevents
 * an infinite flush loop when the bridge is flapping and preserves the
 * unflushed tail for a later retry. The ready flag is managed by
 * {@link bridge.send} itself (set true on success, never reset on failure).
 */
export async function flush(): Promise<void> {
  if (queue.length === 0) return;
  const snapshot = queue.splice(0, queue.length);
  for (let i = 0; i < snapshot.length; i++) {
    try {
      await bridge.send(snapshot[i]!);
    } catch {
      // Re-enqueue the unsent tail (failed entry + everything after) at
      // the front, preserving order. New entries that arrived during the
      // drain remain at the back.
      queue.unshift(...snapshot.slice(i));
      return;
    }
  }
}
