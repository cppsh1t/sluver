/**
 * Pure tool-call summarizer — derives a human-readable summary of an AI tool
 * call from its name + args + result, with NO React or i18n dependencies.
 *
 * The React layer ({@link ToolBody}, consent-banner) consumes the structured
 * {@link ToolSummary} to render entity-shaped preview cards instead of raw
 * JSON. All field access narrows on `unknown` defensively — this module never
 * throws; it degrades to fewer rows when shapes don't match expectations.
 *
 * Covers all 49 tools exposed by the worldbuilding roles, keyed off the
 * tool-name prefix (e.g. `create_character` → action `create`, entity
 * `character`).
 */

// ─── Public types ─────────────────────────────────────────────────────────

export type ToolAction =
  | "create"
  | "get"
  | "list"
  | "search"
  | "update"
  | "delete"
  | "reorder"
  | "count"
  | "addPhase"
  | "getTime"
  | "webSearch"
  | "webFetch";

export type EntityType =
  | "character"
  | "location"
  | "item"
  | "lore"
  | "event"
  | "novel"
  | "chapter"
  | "scene"
  | "phase";

export interface ToolSummary {
  /** Semantic action — drives the action-label i18n key. */
  readonly action: ToolAction;
  /** Entity the tool operates on — null for `get_current_time`. */
  readonly entityType: EntityType | null;
  /** Best-effort headline (entity name/title) extracted from input OR output. */
  readonly headline?: string;
  /** Key parameter rows to preview (label key → display value). Truncated. */
  readonly paramRows: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}

/**
 * Per-entity metadata. `headlineKey` is the field carrying the display name
 * ("name" for characters/events/locations/items/lore/phases; "title" for
 * novels/chapters/scenes). `iconField` is a stable key the React layer maps to
 * a hugeicons glyph.
 */
export const ENTITY_META: Record<
  EntityType,
  { readonly iconField: string; readonly headlineKey: "name" | "title" }
> = {
  character: { iconField: "character", headlineKey: "name" },
  location: { iconField: "location", headlineKey: "name" },
  item: { iconField: "item", headlineKey: "name" },
  lore: { iconField: "lore", headlineKey: "name" },
  event: { iconField: "event", headlineKey: "name" },
  phase: { iconField: "phase", headlineKey: "name" },
  novel: { iconField: "novel", headlineKey: "title" },
  chapter: { iconField: "chapter", headlineKey: "title" },
  scene: { iconField: "scene", headlineKey: "title" },
};

// ─── Defensive narrowing primitives (reused by the React layer) ────────────

/** True if `v` is a plain object (not null, not an array). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce a value to a string, or `undefined` if not string-typed. */
export function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Coerce a value to a string array, dropping non-string entries. */
export function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * Strip the AI SDK ToolResultOutput wrapper (`{type:'json'|'text'|…, value}`).
 * Returns the inner `value` when present, otherwise the input unchanged. Used
 * by both this module and {@link ToolBody} so they unwrap consistently.
 */
export function unwrapToolOutput(value: unknown): unknown {
  if (isRecord(value) && typeof value.type === "string" && "value" in value) {
    return value.value;
  }
  return value;
}

// ─── Internal helpers ─────────────────────────────────────────────────────

/** Truncate an id to its first 8 characters + ellipsis. */
function truncateId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** Truncate prose to `max` characters + ellipsis. */
function truncateProse(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const ENTITY_VALUES = new Set<string>([
  "character",
  "location",
  "item",
  "lore",
  "event",
  "novel",
  "chapter",
  "scene",
  "phase",
]);

function asEntityType(v: string): EntityType | null {
  return ENTITY_VALUES.has(v) ? (v as EntityType) : null;
}

/** Strip a trailing "s" so `reorder_phases` → `phase`, `chapters` → `chapter`. */
function singularize(word: string): string {
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/**
 * Best-effort host extraction from a URL string — never throws.
 *
 * Used by the web-fetch summary headline (`读取「en.wikipedia.org」`) and the
 * fetch-card meta line. Malformed input returns `undefined`.
 */
export function domainFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Parse a tool name into its semantic action + entity.
 *
 * Special cases: `get_current_time`, `web_search`, `web_fetch`,
 * `web_fetch_via_browser`, `add_phase`, `count_character_refs`,
 * `count_phase_refs`. Generic tools follow `{action}_{entity}`; reorder tools
 * use the plural entity (`reorder_phases`) which is singularized.
 */
function parseToolName(toolName: string): {
  readonly action: ToolAction;
  readonly entityType: EntityType | null;
} {
  if (toolName === "get_current_time") {
    return { action: "getTime", entityType: null };
  }
  if (toolName === "web_search") {
    return { action: "webSearch", entityType: null };
  }
  if (toolName === "web_fetch" || toolName === "web_fetch_via_browser") {
    return { action: "webFetch", entityType: null };
  }
  if (toolName === "add_phase") {
    return { action: "addPhase", entityType: "phase" };
  }
  if (toolName === "count_character_refs") {
    return { action: "count", entityType: "character" };
  }
  if (toolName === "count_phase_refs") {
    return { action: "count", entityType: "phase" };
  }

  const sep = toolName.indexOf("_");
  if (sep < 0) return { action: "get", entityType: null };

  const actionRaw = toolName.slice(0, sep);
  const rest = toolName.slice(sep + 1);
  // The entity segment is plural for list_*/reorder_* ("characters", "phases")
  // and singular for get/create/update/delete ("character"). Singularize
  // uniformly so list tools resolve their entity type correctly — without this,
  // asEntityType("characters") returns null and list calls fall back to JSON.
  const entity = asEntityType(singularize(rest));

  switch (actionRaw) {
    case "list":
    case "search":
    case "get":
    case "create":
    case "update":
    case "delete":
    case "reorder":
      return { action: actionRaw, entityType: entity };
    default:
      return { action: "get", entityType: null };
  }
}

/** Pick the first present string field from a record (priority order). */
function firstString(rec: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = asString(rec[k]);
    if (v) return v;
  }
  return undefined;
}

/** Prose fields to scan for a description-style preview, with their label key. */
const PROSE_FIELDS: ReadonlyArray<{ readonly field: string; readonly label: string }> = [
  { field: "description", label: "description" },
  { field: "summary", label: "summary" },
  { field: "appearance", label: "description" },
  { field: "changes", label: "description" },
];

/** id-style input fields (delete uses `id` or `phaseId`). */
const ID_FIELDS = ["id", "phaseId"] as const;

/** array-style input fields (reorder). */
const ARRAY_FIELDS = ["phaseIds", "chapterIds", "sceneIds"] as const;

/** scope-id input fields (list/count). */
const SCOPE_ID_FIELDS = ["novelId", "chapterId", "characterId", "phaseId"] as const;

/** Build the param rows for a given action from the input record. */
function buildParamRows(
  action: ToolAction,
  input: Record<string, unknown>,
): ToolSummary["paramRows"] {
  const rows: Array<{ readonly label: string; readonly value: string }> = [];

  switch (action) {
    case "create":
    case "update":
    case "addPhase": {
      const aliases = asStringArray(input.aliases);
      if (aliases.length > 0) rows.push({ label: "aliases", value: aliases.join(", ") });
      const tags = asStringArray(input.tags);
      if (tags.length > 0) rows.push({ label: "tags", value: tags.join(", ") });
      for (const { field, label } of PROSE_FIELDS) {
        const prose = asString(input[field]);
        if (prose) {
          rows.push({ label, value: truncateProse(prose) });
          break;
        }
      }
      return rows.slice(0, 3);
    }
    case "delete": {
      const id = firstString(input, ID_FIELDS);
      return id ? [{ label: "id", value: truncateId(id) }] : [];
    }
    case "reorder": {
      for (const f of ARRAY_FIELDS) {
        const arr = input[f];
        if (Array.isArray(arr)) {
          return [{ label: "count", value: String(arr.length) }];
        }
      }
      return [];
    }
    case "count": {
      const id = firstString(input, SCOPE_ID_FIELDS);
      return id ? [{ label: "id", value: truncateId(id) }] : [];
    }
    case "list": {
      const id = firstString(input, SCOPE_ID_FIELDS);
      return id ? [{ label: "id", value: truncateId(id) }] : [];
    }
    case "search": {
      const query = asString(input.query);
      return query ? [{ label: "query", value: truncateProse(query) }] : [];
    }
    case "get": {
      const id = firstString(input, ID_FIELDS);
      return id ? [{ label: "id", value: truncateId(id) }] : [];
    }
    case "getTime": {
      const tz = asString(input.timezone);
      return tz ? [{ label: "timezone", value: tz }] : [];
    }
    case "webSearch": {
      const query = asString(input.query);
      const rows: Array<{ readonly label: string; readonly value: string }> = [];
      if (query) rows.push({ label: "query", value: truncateProse(query) });
      const maxResults = typeof input.maxResults === "number" ? input.maxResults : undefined;
      if (maxResults !== undefined) rows.push({ label: "maxResults", value: String(maxResults) });
      return rows;
    }
    case "webFetch": {
      const url = asString(input.url);
      return url ? [{ label: "url", value: truncateProse(url) }] : [];
    }
    default:
      return [];
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────

/**
 * Summarize a tool call into a display-friendly shape.
 *
 * `input` and `output` are `unknown` — every access narrows defensively. The
 * headline prefers the entity's name/title from the OUTPUT (post-execution
 * entity object), falling back to the INPUT. Param rows are derived from the
 * INPUT only (they describe what the user is approving / what was requested).
 *
 * @param toolName the raw tool name (e.g. `create_character`).
 * @param input    parsed tool args; may be `undefined` while streaming.
 * @param output   tool result; `undefined` when pending. May be wrapped in an
 *   AI SDK `{type:'json', value}` envelope — unwrapped transparently.
 */
export function summarizeToolCall(
  toolName: string,
  input: unknown,
  output: unknown,
): ToolSummary {
  const { action, entityType } = parseToolName(toolName);
  const inRec = isRecord(input) ? input : {};

  // Headline: prefer the name/title from the output entity, then the input.
  let headline: string | undefined;
  if (entityType) {
    const key = ENTITY_META[entityType].headlineKey;
    const outRec = isRecord(unwrapToolOutput(output)) ? (unwrapToolOutput(output) as Record<string, unknown>) : {};
    headline = asString(outRec[key]) ?? asString(inRec[key]);
  } else if (action === "webSearch") {
    headline = asString(inRec.query);
  } else if (action === "webFetch") {
    // Prefer the final (post-redirect) URL from the output, fall back to the
    // input URL the agent requested. Either way, surface only the host.
    const outRec = isRecord(unwrapToolOutput(output))
      ? (unwrapToolOutput(output) as Record<string, unknown>)
      : {};
    const pageRec = isRecord(outRec.page) ? (outRec.page as Record<string, unknown>) : null;
    const url = (pageRec ? asString(pageRec.url) : undefined) ?? asString(inRec.url);
    headline = domainFromUrl(url);
  }

  const paramRows = buildParamRows(action, inRec);

  return { action, entityType, headline, paramRows };
}
