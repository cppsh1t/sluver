/**
 * Client-side tree helpers for Notes (ADR-0038).
 *
 * `list_notes` returns the whole tree as a flat summary list; grouping into
 * `NoteTreeNode[]` happens here (the `list_x` no-N+1 convention). Display
 * order is purely `position` ASC — deliberately NOT kind-grouped: storage
 * order is position-only, so a kind-major display would make cross-kind
 * same-parent drags silently revert after refetch (the drop "doesn't stick")
 * and shift cross-parent drop indices. Folders and notes interleave by
 * position, exactly as the user arranged them.
 */

import type { NoteId, NoteSummary, NoteTreeNode } from "@/types";

/** Map key for root-level siblings (`parentId` is NULL at the root). */
export const ROOT_KEY = "\u0000root";

/** Group flat summaries by parent, preserving a stable sibling order. */
export function groupByParent(
  summaries: readonly NoteSummary[],
): Map<string, NoteSummary[]> {
  const byParent = new Map<string, NoteSummary[]>();
  for (const s of summaries) {
    const key = s.parentId ?? ROOT_KEY;
    const list = byParent.get(key);
    if (list) {
      list.push(s);
    } else {
      byParent.set(key, [s]);
    }
  }
  return byParent;
}

/** Sort siblings by `position` ASC (see module docstring for why this must
 * match the storage order — no kind grouping). */
function compareSiblings(a: NoteSummary, b: NoteSummary): number {
  return a.position - b.position;
}

/** Build the recursive UI tree from the flat `list_notes` payload. */
export function buildNoteTree(
  summaries: readonly NoteSummary[],
): NoteTreeNode[] {
  const byParent = groupByParent(summaries);
  const build = (parentKey: string): NoteTreeNode[] =>
    (byParent.get(parentKey) ?? [])
      .slice()
      .sort(compareSiblings)
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        title: s.title,
        position: s.position,
        children: build(s.id),
      }));
  return build(ROOT_KEY);
}

export interface SubtreeCounts {
  /** Every id in the subtree, including the root itself. */
  ids: Set<string>;
  noteCount: number;
  folderCount: number;
}

/**
 * Collect a node's whole subtree (folders cascade on delete — ADR-0038 §6;
 * the pre-delete disclosure needs these counts, ADR-0006 style).
 */
export function collectSubtree(
  summaries: readonly NoteSummary[],
  rootId: NoteId,
): SubtreeCounts {
  const byParent = groupByParent(summaries);
  const ids = new Set<string>();
  let noteCount = 0;
  let folderCount = 0;
  const stack: string[] = [rootId];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (ids.has(id)) continue;
    ids.add(id);
    const summary = summaries.find((s) => s.id === id);
    if (summary?.kind === "folder") folderCount += 1;
    else if (summary?.kind === "note") noteCount += 1;
    for (const child of byParent.get(id) ?? []) stack.push(child.id);
  }
  return { ids, noteCount, folderCount };
}

/**
 * True when `nodeId` is `ancestorId` itself or lives anywhere inside its
 * subtree — the client-side half of the move cycle guard (ADR-0038 §4; the
 * authoritative walk runs inside `move_note`'s transaction).
 */
export function isInsideSubtree(
  summaries: readonly NoteSummary[],
  nodeId: NoteId,
  ancestorId: NoteId,
): boolean {
  const byId = new Map(summaries.map((s) => [s.id as string, s]));
  let cur: string | undefined = nodeId;
  while (cur !== undefined) {
    if (cur === ancestorId) return true;
    cur = byId.get(cur)?.parentId ?? undefined;
  }
  return false;
}
