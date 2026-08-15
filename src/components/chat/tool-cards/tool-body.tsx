/**
 * Tool-call body renderer — prefix-dispatches on the semantic action derived
 * by {@link summarizeToolCall} to render entity-shaped previews instead of raw
 * JSON.
 *
 * Action matrix:
 * - `get`   → {@link EntityDetailCard} rich read-only card for worldbook
 *   entities (Character/Location/Item/Lore/Event), Zod-validated against the
 *   canonical schemas; falls back to {@link EntityPreview} on parse failure
 *   and to a compact action line while running.
 * - `create`/`update`/`addPhase` → {@link EntityPreview} built from the
 *   output entity (done) or the input args (pending/running).
 * - `list`   → "found N" + up to 5 name chips, or a pending label.
 * - `delete` → while pending (consent gate, ADR-0025): {@link EntityDetailCard}
 *   with a "pending deletion" badge, live-fetched by id via
 *   {@link PendingDeletePreview}; once done: the card rendered from the
 *   pre-delete snapshot (`{ deleted: true, id, snapshot? }`) with the deleted
 *   treatment; legacy snapshot-less results keep the id-only line.
 * - `reorder`→ count label.
 * - `count`  → events/scenes ref counts.
 * - `getTime`→ formatted timestamp.
 * - `webSearch` → result count + scrollable list of result previews
 *   (title / domain / snippet).
 * - `webFetch`  → page title + meta line (domain · chars · author · date) +
 *   content excerpt.
 *
 * Returns `null` for unrecognized tools so the parent ({@link ToolCard}) can
 * fall back to the raw-JSON view as the primary body.
 */

import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import { Globe02Icon } from "@hugeicons/core-free-icons";

import type { ToolBlockData } from "../message-render";
import {
  asString,
  asStringArray,
  domainFromUrl,
  ENTITY_META,
  isRecord,
  summarizeToolCall,
  unwrapToolOutput,
  type EntityType,
  type ToolSummary,
} from "../tool-summary";
import { EntityDetailCard, isDetailEntityKind, parseEntityDetail } from "./entity-detail-card";
import { EntityPreview } from "./entity-preview";
import { PendingDeletePreview } from "./pending-delete-preview";

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

  // ── get → rich read-only entity card (worldbook scope) ────────────────
  if (action === "get") {
    if (!entityType) return null;
    // Full entity present in the output → validate against the canonical Zod
    // schema and render the rich detail card (CRUD-card vocabulary).
    if (isDetailEntityKind(entityType)) {
      const detail = hasOutput ? parseEntityDetail(entityType, out) : null;
      if (detail) {
        return <EntityDetailCard detail={detail} />;
      }
    }
    // Output exists but failed parsing (corrupted / unexpected shape) — fall
    // back to the compact EntityPreview built from raw fields. Never throw.
    if (hasOutput && isRecord(out)) {
      const headline =
        asString(out[ENTITY_META[entityType].headlineKey]) ?? summary.headline;
      const description =
        asString(out.description) ?? asString(out.summary) ?? asString(out.appearance);
      const tags = asStringArray(out.tags);
      return (
        <EntityPreview
          entityType={entityType}
          headline={headline}
          description={description}
          tags={tags}
        />
      );
    }
    // Running (no output yet) — compact placeholder line.
    return <MetaLine><ToolSummaryLine summary={summary} /></MetaLine>;
  }

  // ── create / update / addPhase → entity preview ─────────────────
  if (action === "create" || action === "update" || action === "addPhase") {
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

  // ── search → query echo + count + name chips ────────────────────────
  if (action === "search") {
    if (!entityType) return null;
    const entityLabel = t(`chat:tool.entity.${entityType}`);
    const query = isRecord(tool.input) ? asString(tool.input.query) : undefined;
    if (Array.isArray(out)) {
      const names = namesFromArray(out, entityType).slice(0, 5);
      const extra = out.length - names.length;
      return (
        <div className="flex flex-col gap-1">
          {query && <MetaLine>{t("chat:tool.searchQuery", { query })}</MetaLine>}
          {out.length === 0 ? (
            <MetaLine>{t("chat:tool.searchNoResult", { entity: entityLabel })}</MetaLine>
          ) : (
            <MetaLine>{t("chat:tool.searchResult", { count: out.length, entity: entityLabel })}</MetaLine>
          )}
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
    // Pending / running.
    return (
      <div className="flex flex-col gap-0.5">
        {query && <MetaLine>{t("chat:tool.searchQuery", { query })}</MetaLine>}
        <MetaLine>{t("chat:tool.searchPending", { entity: entityLabel })}</MetaLine>
      </div>
    );
  }

  // ── delete → pending preview / rich snapshot card / legacy id line ───
  if (action === "delete") {
    if (!entityType) return null;
    const entityLabel = t(`chat:tool.entity.${entityType}`);
    const outRec = isRecord(out) ? out : null;
    const deleted = outRec !== null && outRec.deleted === true;
    const id = idFromInput(tool.input);
    // Done + fresh: delete results carry the pre-delete entity snapshot (same
    // shape as the corresponding get_* result) — render the SAME rich card as
    // `get` with the deleted treatment so the user sees WHAT was removed.
    // Legacy results (snapshot absent / unparseable / out of worldbook scope)
    // keep the id-only display below.
    if (deleted && isDetailEntityKind(entityType) && outRec.snapshot !== undefined) {
      const detail = parseEntityDetail(entityType, outRec.snapshot);
      if (detail) {
        return <EntityDetailCard detail={detail} deleted />;
      }
    }
    // Pending: delete_* tools are consent-gated (ADR-0025) — while the gate
    // (or the post-approval execution) is in flight, status is "running" and
    // no output exists yet. Live-fetch the entity by id and show the SAME
    // rich card with a "pending deletion" badge, so approval happens with
    // full knowledge of what will be removed. Denied/errored deletes
    // (status "error") and fetch failures fall back to the compact line.
    if (tool.status === "running" && isDetailEntityKind(entityType) && id) {
      return (
        <PendingDeletePreview
          kind={entityType}
          id={id}
          fallback={
            <div className="flex flex-col gap-0.5">
              <MetaLine>
                <ToolSummaryLine summary={summary} />
              </MetaLine>
              <MetaLine>
                {t("chat:tool.idLabel")}: {id.length > 8 ? `${id.slice(0, 8)}…` : id}
              </MetaLine>
            </div>
          }
        />
      );
    }
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

  // ── webSearch → result count + scrollable result previews ────────────
  if (action === "webSearch") {
    if (hasOutput && isRecord(out) && Array.isArray(out.results)) {
      const results = out.results;
      if (results.length === 0) {
        return <MetaLine>{t("chat:tool.search.noResults")}</MetaLine>;
      }
      return (
        <div className="flex flex-col gap-1.5">
          <MetaLine>{t("chat:tool.search.resultCount", { count: results.length })}</MetaLine>
          <div className="flex max-h-64 flex-col gap-1.5 overflow-auto pr-1">
            {results.map((item, idx) => {
              if (!isRecord(item)) return null;
              const title = asString(item.title);
              const url = asString(item.url);
              const snippet = asString(item.snippet);
              const domain = domainFromUrl(url);
              return (
                <div key={idx} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1">
                    <HugeiconsIcon
                      icon={Globe02Icon}
                      strokeWidth={2}
                      aria-hidden
                      className="size-3 shrink-0 text-muted-foreground/70"
                    />
                    {title ? (
                      <span className="truncate text-[0.75rem] font-medium">{title}</span>
                    ) : (
                      <span className="truncate text-[0.75rem] font-medium text-muted-foreground/60">—</span>
                    )}
                  </div>
                  {domain && (
                    <span className="pl-4 text-[0.625rem] text-muted-foreground/70">{domain}</span>
                  )}
                  {snippet && (
                    <p className="line-clamp-2 pl-4 text-[0.6875rem] leading-relaxed text-muted-foreground">
                      {snippet}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    // Pending / running — the header summary line already shows the query.
    return <MetaLine>{t("chat:tool.search.pending")}</MetaLine>;
  }

  // ── webFetch → page title + meta line + content excerpt ──────────────
  if (action === "webFetch") {
    if (hasOutput && isRecord(out) && isRecord(out.page)) {
      const page = out.page;
      const title = asString(page.title);
      const url = asString(page.url);
      const content = asString(page.content) ?? "";
      const author = asString(page.author);
      const publishedAt = asString(page.publishedAt);
      const domain = domainFromUrl(url);

      // Meta line: domain · char count · author · published date (middot-joined).
      const metaParts: string[] = [];
      if (domain) metaParts.push(domain);
      if (content.length > 0) metaParts.push(t("chat:tool.search.chars", { count: content.length }));
      if (author) metaParts.push(`${t("chat:tool.search.author")}: ${author}`);
      if (publishedAt) metaParts.push(`${t("chat:tool.search.published")}: ${publishedAt}`);

      // Prefer excerpt for the preview when present (Readability meta desc is a
      // tighter summary than the truncated body); fall back to the body content.
      const excerpt = asString(page.excerpt) ?? content;

      return (
        <div className="flex flex-col gap-1">
          {title ? (
            <span className="truncate text-[0.75rem] font-medium">{title}</span>
          ) : domain ? (
            <span className="truncate text-[0.75rem] font-medium">{domain}</span>
          ) : null}
          {metaParts.length > 0 && (
            <MetaLine>{metaParts.join(" · ")}</MetaLine>
          )}
          {excerpt && (
            <p className="line-clamp-3 text-[0.6875rem] leading-relaxed text-muted-foreground">
              {excerpt}
            </p>
          )}
        </div>
      );
    }
    // Pending / running — the header summary line already shows the domain.
    return <MetaLine>{t("chat:tool.search.fetching")}</MetaLine>;
  }

  // Unrecognized tool — parent falls back to raw JSON.
  return null;
}
