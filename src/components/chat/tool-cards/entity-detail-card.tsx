/**
 * Read-only rich entity card for the chat tool-result UI.
 *
 * Renders the FULL entity for `get_*` results and for `delete_*` snapshots
 * (contract: `{ deleted: true, id, snapshot?: Entity }`), mirroring the visual
 * vocabulary of the CRUD cards in `src/components/worldbook/` (avatar +
 * name/aliases header, full prose blocks, phase stepper rows, tag chips,
 * relative timestamps) — without importing or mutating them.
 *
 * Like {@link EntityPreview}, this is intentionally NOT wrapped in a `<Card>`:
 * it lives INSIDE the GenericToolCard body, and a second bordered container
 * would double up the chrome.
 *
 * Data safety: {@link parseEntityDetail} validates the (already
 * `unwrapToolOutput`-stripped) tool output against the canonical Zod schemas
 * from `@/types` — the single source of truth for entity shapes. On any parse
 * failure the caller falls back to the compact {@link EntityPreview}; this
 * module never throws.
 *
 * `spaceId` / `worldId` are self-sourced from the world route params (same
 * `useParams` pattern as `routes/world.$worldId/chat.tsx`) because the
 * ToolCard → ToolBody chain threads no ids down. This component is therefore
 * only mountable inside the `/space/$spaceId/world/$worldId/*` tree — which
 * is the only place ToolCard renders.
 */

import { useMemo, type ReactNode } from "react";
import { useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, ShieldAlert } from "@hugeicons/core-free-icons";

import { useCharacters, useLocations } from "@/hooks";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EntityAvatar } from "@/components/ui/entity-avatar";
import { FormattedTime } from "@/components/timemapper/formatted-time";
import {
  characterPhaseSchema,
  characterSchema,
  eventSchema,
  itemSchema,
  loreSchema,
  locationSchema,
  type Character,
  type CharacterPhase,
  type Event,
  type Item,
  type Lore,
  type Location,
  type SpaceId,
  type WorldId,
} from "@/types";
import type { EntityType } from "../tool-summary";
import { ENTITY_ICONS } from "./entity-icons";

// ─── Parsed-entity model ───────────────────────────────────────────────────

/** Entity kinds that render a rich detail card (worldbook scope only). */
export type EntityDetailKind =
  | "character"
  | "location"
  | "item"
  | "lore"
  | "event"
  | "phase";

/** Discriminated union of a successfully Zod-parsed entity payload. */
export type EntityDetail =
  | { readonly kind: "character"; readonly data: Character }
  | { readonly kind: "location"; readonly data: Location }
  | { readonly kind: "item"; readonly data: Item }
  | { readonly kind: "lore"; readonly data: Lore }
  | { readonly kind: "event"; readonly data: Event }
  | { readonly kind: "phase"; readonly data: CharacterPhase };

const DETAIL_KINDS: ReadonlySet<string> = new Set([
  "character",
  "location",
  "item",
  "lore",
  "event",
  "phase",
]);

/** Narrow an {@link EntityType} to the rich-card scope (excludes novel/chapter/scene). */
export function isDetailEntityKind(t: EntityType | null): t is EntityDetailKind {
  return t !== null && DETAIL_KINDS.has(t);
}

/**
 * Validate an unwrapped tool output (or delete snapshot) against the canonical
 * entity schema. Returns `null` on any mismatch — callers must treat that as
 * "render the legacy compact preview" rather than an error.
 */
export function parseEntityDetail(
  kind: EntityDetailKind,
  value: unknown,
): EntityDetail | null {
  switch (kind) {
    case "character": {
      const r = characterSchema.safeParse(value);
      return r.success ? { kind, data: r.data } : null;
    }
    case "location": {
      const r = locationSchema.safeParse(value);
      return r.success ? { kind, data: r.data } : null;
    }
    case "item": {
      const r = itemSchema.safeParse(value);
      return r.success ? { kind, data: r.data } : null;
    }
    case "lore": {
      const r = loreSchema.safeParse(value);
      return r.success ? { kind, data: r.data } : null;
    }
    case "event": {
      const r = eventSchema.safeParse(value);
      return r.success ? { kind, data: r.data } : null;
    }
    case "phase": {
      const r = characterPhaseSchema.safeParse(value);
      return r.success ? { kind, data: r.data } : null;
    }
  }
}

// ─── Small presentational atoms ────────────────────────────────────────────

/** Micro section label — matches the INPUT/OUTPUT label style of the tool-card chrome. */
function FieldLabel({ children }: { readonly children: ReactNode }) {
  return (
    <span className="text-[0.625rem] font-medium uppercase tracking-wide text-muted-foreground/70">
      {children}
    </span>
  );
}

/**
 * Full-length prose block (description / notes / …). No line-clamp — the
 * content is capped by a scroll region instead so long text stays complete
 * without stretching the chat column unboundedly.
 */
function ProseBlock({ label, text }: { readonly label: string; readonly text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <FieldLabel>{label}</FieldLabel>
      <p className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
        {text}
      </p>
    </div>
  );
}

/** Read-only tag chips — ALL tags, never sliced. */
function TagList({ tags }: { readonly tags: readonly string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span
          key={tag}
          className="rounded bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

/** Character phases — the two-line stepper vocabulary from the CRUD character card. */
function PhaseList({ phases }: { readonly phases: readonly CharacterPhase[] }) {
  const { t } = useTranslation("chat");
  if (phases.length === 0) {
    return (
      <span className="text-xs text-muted-foreground/60">
        {t("chat:tool.detail.noPhases")}
      </span>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <FieldLabel>
        {t("chat:tool.detail.phases")} · {phases.length}
      </FieldLabel>
      <div className="flex flex-col gap-1.5">
        {phases.map((phase) => (
          <div key={phase.id} className="flex flex-col">
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              {phase.name}
            </span>
            {phase.triggerEventName && (
              <span className="whitespace-nowrap text-[0.625rem] text-muted-foreground/60">
                ↓ {phase.triggerEventName}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Event meta line ───────────────────────────────────────────────────────

/**
 * "Participants · location · time" line for event cards, mirroring
 * `worldbook/event-card.tsx`. Resolves `characterRefs` / `locationId` to names
 * via the same `useCharacters` / `useLocations` hooks the events route uses;
 * degrades to a participant count while (or if) names are unavailable.
 */
function EventMetaLine({
  event,
  spaceId,
  worldId,
}: {
  readonly event: Event;
  readonly spaceId: string;
  readonly worldId: WorldId;
}) {
  const { t } = useTranslation("chat");
  const { data: locations } = useLocations(spaceId, worldId);
  const { data: characters } = useCharacters(spaceId, worldId);

  const locationText = useMemo(() => {
    const name = event.locationId
      ? (locations?.find((l) => l.id === event.locationId)?.name ?? null)
      : null;
    return name ?? t("chat:tool.detail.noLocation");
  }, [locations, event.locationId, t]);

  const participantsText = useMemo(() => {
    // Dedupe character ids — the same character at two phases is one participant.
    const seen = new Set<string>();
    const uniqueIds: string[] = [];
    for (const ref of event.characterRefs) {
      if (!seen.has(ref.characterId)) {
        seen.add(ref.characterId);
        uniqueIds.push(ref.characterId);
      }
    }
    if (uniqueIds.length === 0) return t("chat:tool.detail.noParticipants");
    // Names only when the character list is loaded AND every ref resolves
    // (a deleted participant degrades the whole line to a count).
    const names: string[] = [];
    for (const id of uniqueIds) {
      const name = characters?.find((c) => c.id === id)?.name;
      if (name === undefined) {
        return t("chat:tool.detail.participantsCount", { count: uniqueIds.length });
      }
      names.push(name);
    }
    return names.join(", ");
  }, [characters, event.characterRefs, t]);

  // Story-time via the World's TimeMapper — same pattern as event-card.tsx.
  let timeNode: ReactNode;
  if (event.startAt && event.endAt) {
    timeNode = (
      <>
        <FormattedTime iso={event.startAt} /> – <FormattedTime iso={event.endAt} />
      </>
    );
  } else if (event.startAt) {
    timeNode = <FormattedTime iso={event.startAt} />;
  } else if (event.endAt) {
    timeNode = <FormattedTime iso={event.endAt} />;
  } else {
    timeNode = t("chat:tool.detail.noTime");
  }

  return (
    <p className="text-xs text-muted-foreground">
      {participantsText} · {locationText} · {timeNode}
    </p>
  );
}

// ─── Main card ─────────────────────────────────────────────────────────────

interface EntityDetailCardProps {
  readonly detail: EntityDetail;
  /**
   * Post-delete presentation: muted card, struck-through name, and a
   * "deleted" badge so the user sees WHAT was removed, not a bare id.
   */
  readonly deleted?: boolean;
  /**
   * Pending-approval presentation (ADR-0025): normal card with a
   * "pending deletion" badge — the entity still exists and is being shown
   * for consent review. Mutually exclusive with {@link deleted} by caller
   * construction (pending ⇒ no output yet, deleted ⇒ output arrived).
   */
  readonly pendingDelete?: boolean;
}

export function EntityDetailCard({
  detail,
  deleted = false,
  pendingDelete = false,
}: EntityDetailCardProps) {
  const { t } = useTranslation("chat");
  const { spaceId, worldId: routeWorldId } = useParams({
    from: "/space/$spaceId/world/$worldId",
  });
  const sid = spaceId as SpaceId;
  const wid = routeWorldId as WorldId;

  const { kind, data } = detail;
  const Icon = ENTITY_ICONS[kind];

  // Shared fields (present on every kind in the union).
  const notes = "notes" in data ? data.notes : "";
  const tags = "tags" in data ? data.tags : [];

  return (
    <div className={cn("flex flex-col gap-2", deleted && "opacity-80")}>
      {/* Header: avatar + identity column (character-card layout vocabulary). */}
      <div className="flex items-start gap-3">
        <EntityAvatar
          kind={kind}
          spaceId={sid}
          worldId={wid}
          id={data.id}
          alt={data.name}
          fallbackIcon={
            <HugeiconsIcon
              icon={Icon}
              strokeWidth={2}
              className="size-8 text-muted-foreground"
            />
          }
          className="h-20 w-15 shrink-0 rounded-md"
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "truncate text-sm font-medium",
                deleted && "line-through decoration-muted-foreground/60",
              )}
            >
              {data.name}
            </span>
            {(deleted || pendingDelete) && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded bg-destructive/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-destructive">
                <HugeiconsIcon
                  icon={deleted ? Delete02Icon : ShieldAlert}
                  strokeWidth={2}
                  className="size-3"
                />
                {t(
                  deleted
                    ? "chat:tool.detail.deleted"
                    : "chat:tool.detail.pendingDeletion",
                )}
              </span>
            )}
          </div>
          {kind === "character" && data.aliases.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("chat:tool.detail.aliases")}: {data.aliases.join(", ")}
            </p>
          )}
          {kind === "event" && (
            <EventMetaLine event={data} spaceId={spaceId} worldId={wid} />
          )}
          {kind === "phase" && data.triggerEventName && (
            <p className="text-xs text-muted-foreground">
              {t("chat:tool.detail.triggerEvent")}: {data.triggerEventName}
            </p>
          )}
        </div>
      </div>

      {data.description.length > 0 && (
        <ProseBlock label={t("chat:tool.detail.description")} text={data.description} />
      )}
      {kind === "phase" && data.appearance.length > 0 && (
        <ProseBlock label={t("chat:tool.detail.appearance")} text={data.appearance} />
      )}
      {kind === "phase" && data.conversationStyle.length > 0 && (
        <ProseBlock
          label={t("chat:tool.detail.conversationStyle")}
          text={data.conversationStyle}
        />
      )}
      {kind === "character" && <PhaseList phases={data.phases} />}
      {notes.length > 0 && (
        <ProseBlock label={t("chat:tool.detail.notes")} text={notes} />
      )}
      {tags.length > 0 && <TagList tags={tags} />}

      <p className="text-xs text-muted-foreground/70">
        {t("chat:tool.detail.createdAt", {
          time: formatRelativeTime(data.createdAt),
        })}
        {" · "}
        {t("chat:tool.detail.updatedAt", {
          time: formatRelativeTime(data.updatedAt),
        })}
      </p>
    </div>
  );
}
