/**
 * Tool-call body renderer — prefix-dispatches on the semantic action derived
 * by {@link summarizeToolCall} to render entity-shaped previews instead of raw
 * JSON.
 *
 * Action matrix:
 * - `create`/`get`/`update`/`addPhase` → {@link EntityPreview} built from the
 *   output entity (done) or the input args (pending/running).
 * - `list`   → "found N" + up to 5 name chips, or a pending label.
 * - `delete` → deleted label + truncated id.
 * - `reorder`→ count label.
 * - `count`  → events/scenes ref counts.
 * - `getTime`→ formatted timestamp.
 *
 * Returns `null` for unrecognized tools so the parent ({@link ToolCard}) can
 * fall back to the raw-JSON view as the primary body.
 */

import { useTranslation } from "react-i18next";

import type { ToolBlockData } from "../message-render";
import {
  asString,
  asStringArray,
  ENTITY_META,
  isRecord,
  summarizeToolCall,
  unwrapToolOutput,
  type EntityType,
  type ToolSummary,
} from "../tool-summary";
import { EntityPreview } from "./entity-preview";

// ─── One-line summary (shared by tool-card header + consent-banner) ─────────

/**
 * Render a single-line human summary: "{action}{entity}" plus the entity
 * headline in locale-aware quotes when present (e.g. "创建角色「张三」").
 */
export function ToolSummaryLine({ summary }: { readonly summary: ToolSummary }) {
  const { t } = useTranslation("chat");
  const actionLabel = t(`chat:tool.action.${summary.action}`);
  const entityLabel = summary.entityType
    ? t(`chat:tool.entity.${summary.entityType}`)
    : "";
  const base = `${actionLabel}${entityLabel}`;
  if (!summary.headline) return <>{base}</>;
  return (
    <>
      {base}
      {t("chat:tool.nameQuote", { name: summary.headline })}
    </>
  );
}

// ─── Helpers (operate on unknown tool args/results) ────────────────────────

/** Pull the name/title field from an entity object, honoring the entity type. */
function entityName(rec: Record<string, unknown>, entityType: EntityType | null): string | undefined {
  if (entityType) {
    return asString(rec[ENTITY_META[entityType].headlineKey]);
  }
  return asString(rec.name) ?? asString(rec.title);
}

/** Extract name/title strings from an array of entity objects. */
function namesFromArray(arr: readonly unknown[], entityType: EntityType | null): string[] {
  return arr
    .map((item) => {
      const rec = isRecord(item) ? item : null;
      return rec ? entityName(rec, entityType) : undefined;
    })
    .filter((s): s is string => typeof s === "string" && s.length > 0);
}

/** Read the first present id-style field from an input record. */
function idFromInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return asString(input.id) ?? asString(input.phaseId);
}

/** Read the first present array-style field (reorder inputs). */
function arrayFromInput(input: unknown): unknown[] | null {
  if (!isRecord(input)) return null;
  for (const f of ["phaseIds", "chapterIds", "sceneIds"] as const) {
    const v = input[f];
    if (Array.isArray(v)) return v;
  }
  return null;
}

// ─── Small presentational atoms ────────────────────────────────────────────

function MetaLine({ children }: { readonly children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function NameChip({ name }: { readonly name: string }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground">
      {name}
    </span>
  );
}

// ─── Main body renderer ────────────────────────────────────────────────────

export function ToolBody({ tool }: { readonly tool: ToolBlockData }) {
  const { t } = useTranslation("chat");
  const summary = summarizeToolCall(tool.toolName, tool.input, tool.output);
  const { action, entityType } = summary;

  const out = unwrapToolOutput(tool.output);
  const hasOutput = out != null;

  // ── create / get / update / addPhase → entity preview ─────────────────
  if (action === "create" || action === "get" || action === "update" || action === "addPhase") {
    if (!entityType) return null;
    const outRec = isRecord(out) ? out : null;
    const inRec = isRecord(tool.input) ? tool.input : null;
    const src = outRec ?? inRec;
    if (src) {
      const headline =
        asString(src[ENTITY_META[entityType].headlineKey]) ?? summary.headline;
      const description =
        asString(src.description) ?? asString(src.summary) ?? asString(src.appearance);
      const tags = asStringArray(src.tags);
      return (
        <EntityPreview
          entityType={entityType}
          headline={headline}
          description={description}
          tags={tags}
        />
      );
    }
    // No entity object yet (streaming) — show the action label.
    return <MetaLine><ToolSummaryLine summary={summary} /></MetaLine>;
  }

  // ── list → count + name chips ─────────────────────────────────────────
  if (action === "list") {
    if (!entityType) return null;
    const entityLabel = t(`chat:tool.entity.${entityType}`);
    if (Array.isArray(out)) {
      const names = namesFromArray(out, entityType).slice(0, 5);
      const extra = out.length - names.length;
      return (
        <div className="flex flex-col gap-1">
          <MetaLine>{t("chat:tool.listResult", { count: out.length, entity: entityLabel })}</MetaLine>
          {names.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {names.map((n, i) => <NameChip key={`${n}-${i}`} name={n} />)}
              {extra > 0 && (
                <span className="px-1.5 py-0.5 text-[0.625rem] text-muted-foreground/70">
                  +{extra}
                </span>
              )}
            </div>
          )}
        </div>
      );
    }
    const actionLabel = t(`chat:tool.action.list`);
    return <MetaLine>{t("chat:tool.listPending", { action: actionLabel, entity: entityLabel })}</MetaLine>;
  }

  // ── delete → label + truncated id ─────────────────────────────────────
  if (action === "delete") {
    if (!entityType) return null;
    const entityLabel = t(`chat:tool.entity.${entityType}`);
    const deleted = hasOutput && isRecord(out) && out.deleted === true;
    const id = idFromInput(tool.input);
    return (
      <div className="flex flex-col gap-0.5">
        <MetaLine>
          {deleted
            ? t("chat:tool.deleted", { entity: entityLabel })
            : <ToolSummaryLine summary={summary} />}
        </MetaLine>
        {id && (
          <MetaLine>{t("chat:tool.idLabel")}: {id.length > 8 ? `${id.slice(0, 8)}…` : id}</MetaLine>
        )}
      </div>
    );
  }

  // ── reorder → count label ─────────────────────────────────────────────
  if (action === "reorder") {
    if (!entityType) return null;
    const entityLabel = t(`chat:tool.entity.${entityType}`);
    const arr = arrayFromInput(tool.input);
    const count = arr?.length ?? 0;
    const actionLabel = t(`chat:tool.action.reorder`);
    return (
      <MetaLine>
        {hasOutput
          ? t("chat:tool.reorderDone", { count, entity: entityLabel })
          : t("chat:tool.reorderPending", { action: actionLabel, count, entity: entityLabel })}
      </MetaLine>
    );
  }

  // ── count → events/scenes ref counts ──────────────────────────────────
  if (action === "count") {
    if (hasOutput && isRecord(out)) {
      const events = typeof out.events === "number" ? out.events : undefined;
      const scenes = typeof out.scenes === "number" ? out.scenes : undefined;
      if (events !== undefined && scenes !== undefined) {
        return <MetaLine>{t("chat:tool.countResult", { events, scenes })}</MetaLine>;
      }
    }
    // Pending → action label + truncated scope id.
    const id = idFromInput(tool.input) ?? (isRecord(tool.input) ? asString(tool.input.characterId) : undefined);
    return (
      <div className="flex flex-col gap-0.5">
        <MetaLine>{t(`chat:tool.action.count`)}</MetaLine>
        {id && <MetaLine>{t("chat:tool.idLabel")}: {id.length > 8 ? `${id.slice(0, 8)}…` : id}</MetaLine>}
      </div>
    );
  }

  // ── getTime → formatted timestamp ─────────────────────────────────────
  if (action === "getTime") {
    if (hasOutput && isRecord(out)) {
      const formatted = asString(out.formatted);
      if (formatted) return <MetaLine>{formatted}</MetaLine>;
    }
    return <MetaLine>{t(`chat:tool.action.getTime`)}</MetaLine>;
  }

  // Unrecognized tool — parent falls back to raw JSON.
  return null;
}
