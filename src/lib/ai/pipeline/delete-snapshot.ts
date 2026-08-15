/**
 * Delete-snapshot stripper — Derived Model Input payload hygiene
 * (ADR-0028, companion to the delete_* tool snapshot contract).
 *
 * The worldbook `delete_*` tools return `{ deleted: true, id, snapshot }`
 * where `snapshot` is the FULL pre-delete entity — the chat UI needs it to
 * render the rich "what was deleted" card, and the Persisted Thread keeps it
 * verbatim (ADR-0028 invariant 1: the persisted thread is the source of
 * truth; `context_read` / `findToolPair` read the originals there). The MODEL,
 * however, gains nothing from the prose of an entity that no longer exists —
 * it only needs the confirmation plus the name to reference in its reply.
 * Feeding every delete's full entity into the context would add 1–3k+ tokens
 * per deleted entity, cutting against the "agent tool payloads stay small"
 * principle (see `CharacterSummary` in the Rust models).
 *
 * This transform rewrites matching tool-result outputs in the Derived Model
 * Input to a compact echo: `{ deleted: true, id, name? }`. It is applied at
 * every model-input boundary (each `streamText` step via
 * `AgentLoopRunInput.inputTransform`), so both the in-run multi-delete case
 * and all future turns are covered.
 *
 * ## Purity (ADR-0028 invariant 2)
 *
 * PURE: same input always produces the same output. The input array and every
 * element are treated as immutable; freshly constructed message objects are
 * emitted only where a rewrite was required. When nothing matches, the input
 * array reference is returned verbatim (zero allocation).
 *
 * ## Shape matching
 *
 * A tool-result is rewritten iff its output is the SDK's `json` variant
 * (`{ type: 'json', value }` — the shape `execute`'s object returns take on
 * in `ToolResultPart.output`) AND `value` matches
 * `{ deleted: true, id: string, snapshot: object }`. The `name` is carried
 * over from `snapshot.name` when it is a string. Anything else — legacy
 * `{ deleted: true, id }` results, non-delete tools, unexpected shapes —
 * passes through untouched.
 *
 * Related: ADR-0028 (three-layer model), ADR-0031 (tool-pair compaction —
 * orthogonal: this transform rewrites payloads, compaction removes pairs).
 */

import type { ModelMessage, ToolResultPart } from "ai";

// ─── Shape guards ─────────────────────────────────────────────────────────

/** The full delete-tool result payload this transform compacts. */
interface DeleteSnapshotValue {
  deleted: true;
  id: string;
  snapshot: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isDeleteSnapshotValue(v: unknown): v is DeleteSnapshotValue {
  return (
    isRecord(v)
    && v.deleted === true
    && typeof v.id === "string"
    && isRecord(v.snapshot)
  );
}

/** A tool-result whose output carries a compactable delete snapshot. */
function isSnapshotResult(part: ToolResultPart): boolean {
  const { output } = part;
  return output.type === "json" && isDeleteSnapshotValue(output.value);
}

/**
 * Build the compact replacement part: same identity fields (`toolCallId`,
 * `toolName`, …), output reduced to `{ deleted: true, id, name? }`.
 */
function compactResultPart(part: ToolResultPart): ToolResultPart {
  const { output } = part;
  if (output.type !== "json" || !isDeleteSnapshotValue(output.value)) {
    return part; // unreachable via isSnapshotResult; defensive
  }
  const { id, snapshot } = output.value;
  const name = typeof snapshot.name === "string" ? snapshot.name : undefined;
  return {
    ...part,
    output: {
      type: "json",
      value:
        name === undefined
          ? { deleted: true, id }
          : { deleted: true, id, name },
    },
  };
}

// ─── Core transform ───────────────────────────────────────────────────────

/**
 * Replace delete-snapshot tool-result payloads with a compact `{ deleted,
 * id, name? }` echo in the Derived Model Input.
 *
 * @param messages  Model messages treated as immutable.
 * @returns A new array with matching tool-result outputs compacted. When
 *          nothing matched, the input array reference is returned verbatim.
 */
export function stripDeleteSnapshots(messages: ModelMessage[]): ModelMessage[] {
  // Pass 1: fast scan — bail out with the input reference when no tool-result
  // carries a delete snapshot (the overwhelmingly common case).
  let found = false;
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    const { content } = msg;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part.type === "tool-result" && isSnapshotResult(part)) {
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) return messages;

  // Pass 2: rebuild — rewrite only the tool messages that contain a match;
  // every other message keeps its identity.
  const out: ModelMessage[] = [];
  for (const msg of messages) {
    if (msg.role !== "tool") {
      out.push(msg);
      continue;
    }
    const { content } = msg;
    if (!Array.isArray(content)) {
      out.push(msg);
      continue;
    }
    let touched = false;
    const rewritten = content.map((part) => {
      if (part.type === "tool-result" && isSnapshotResult(part)) {
        touched = true;
        return compactResultPart(part);
      }
      return part;
    });
    out.push(touched ? { ...msg, content: rewritten } : msg);
  }
  return out;
}
