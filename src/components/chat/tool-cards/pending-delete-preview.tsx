/**
 * Live-fetch preview for PENDING delete_* tool calls (ADR-0025 consent gate).
 *
 * Delete tools are `consentLevel: "always"` — before execution the tool block
 * has NO output (the snapshot only exists post-delete), and the input carries
 * just `{ id }` / `{ phaseId }`. This wrapper resolves the id against the
 * live database during the pending/running window and renders the SAME rich
 * {@link EntityDetailCard} the post-delete snapshot path uses, with a
 * "pending deletion" badge instead of the deleted treatment — the user
 * approves (or reviews the inline card) knowing exactly WHAT will be removed.
 *
 * Fetches use the shared entity hooks (`useCharacter`, `useLocations`, …) so
 * the react-query cache is shared with the CRUD pages — an entity the user
 * just viewed renders instantly. There is no single-phase fetch API (phases
 * live embedded in `Character.phases`), so the phase variant lists
 * characters and finds the phase by id — the same lookup the tool layer's
 * `delete_phase` performs.
 *
 * Renders {@link PendingDeletePreviewProps.fallback} while loading and on ANY
 * fetch failure (entity already gone, list unavailable) — never a blank card,
 * never a throw. Only mountable inside the `/space/$spaceId/world/$worldId`
 * tree (ids self-sourced from route params, like {@link EntityDetailCard}).
 */

import type { ReactNode } from "react";
import { useParams } from "@tanstack/react-router";

import {
  useCharacter,
  useCharacters,
  useEvent,
  useItem,
  useLocation,
  useLore,
} from "@/hooks";
import type {
  CharacterId,
  EventId,
  ItemId,
  LocationId,
  LoreId,
  WorldId,
} from "@/types";

import {
  EntityDetailCard,
  type EntityDetail,
  type EntityDetailKind,
} from "./entity-detail-card";

interface PendingDeletePreviewProps {
  /** Entity kind being deleted (worldbook scope — `phase` for `delete_phase`). */
  readonly kind: EntityDetailKind;
  /** Entity id from the tool input, or the `phaseId` when kind is "phase". */
  readonly id: string;
  /**
   * Compact fallback (the id-only line) rendered while the fetch is in flight
   * and whenever it fails or finds nothing.
   */
  readonly fallback: ReactNode;
}

/** Shared props of the per-kind fetcher subcomponents. */
interface FetcherProps {
  readonly spaceId: string;
  readonly worldId: WorldId;
  readonly fallback: ReactNode;
}

/**
 * Resolve the pending delete into a rich card, or the fallback. Splits per
 * kind so each subcomponent calls exactly ONE entity hook unconditionally.
 */
export function PendingDeletePreview({
  kind,
  id,
  fallback,
}: PendingDeletePreviewProps) {
  const { spaceId, worldId: routeWorldId } = useParams({
    from: "/space/$spaceId/world/$worldId",
  });
  const worldId = routeWorldId as WorldId;

  switch (kind) {
    case "character":
      return (
        <CharacterFetcher
          spaceId={spaceId}
          worldId={worldId}
          id={id}
          fallback={fallback}
        />
      );
    case "location":
      return (
        <LocationFetcher
          spaceId={spaceId}
          worldId={worldId}
          id={id}
          fallback={fallback}
        />
      );
    case "item":
      return (
        <ItemFetcher
          spaceId={spaceId}
          worldId={worldId}
          id={id}
          fallback={fallback}
        />
      );
    case "lore":
      return (
        <LoreFetcher
          spaceId={spaceId}
          worldId={worldId}
          id={id}
          fallback={fallback}
        />
      );
    case "event":
      return (
        <EventFetcher
          spaceId={spaceId}
          worldId={worldId}
          id={id}
          fallback={fallback}
        />
      );
    case "phase":
      return (
        <PhaseFetcher
          spaceId={spaceId}
          worldId={worldId}
          phaseId={id}
          fallback={fallback}
        />
      );
  }
}

// ─── Per-kind fetchers ────────────────────────────────────────────────────

function CharacterFetcher({
  spaceId,
  worldId,
  id,
  fallback,
}: FetcherProps & { readonly id: string }) {
  const { data, isLoading, isError } = useCharacter(
    spaceId,
    worldId,
    id as CharacterId,
  );
  if (isLoading || isError || !data) return <>{fallback}</>;
  const detail: EntityDetail = { kind: "character", data };
  return <EntityDetailCard detail={detail} pendingDelete />;
}

function LocationFetcher({
  spaceId,
  worldId,
  id,
  fallback,
}: FetcherProps & { readonly id: string }) {
  const { data, isLoading, isError } = useLocation(
    spaceId,
    worldId,
    id as LocationId,
  );
  if (isLoading || isError || !data) return <>{fallback}</>;
  const detail: EntityDetail = { kind: "location", data };
  return <EntityDetailCard detail={detail} pendingDelete />;
}

function ItemFetcher({
  spaceId,
  worldId,
  id,
  fallback,
}: FetcherProps & { readonly id: string }) {
  const { data, isLoading, isError } = useItem(spaceId, worldId, id as ItemId);
  if (isLoading || isError || !data) return <>{fallback}</>;
  const detail: EntityDetail = { kind: "item", data };
  return <EntityDetailCard detail={detail} pendingDelete />;
}

function LoreFetcher({
  spaceId,
  worldId,
  id,
  fallback,
}: FetcherProps & { readonly id: string }) {
  const { data, isLoading, isError } = useLore(spaceId, worldId, id as LoreId);
  if (isLoading || isError || !data) return <>{fallback}</>;
  const detail: EntityDetail = { kind: "lore", data };
  return <EntityDetailCard detail={detail} pendingDelete />;
}

function EventFetcher({
  spaceId,
  worldId,
  id,
  fallback,
}: FetcherProps & { readonly id: string }) {
  const { data, isLoading, isError } = useEvent(spaceId, worldId, id as EventId);
  if (isLoading || isError || !data) return <>{fallback}</>;
  const detail: EntityDetail = { kind: "event", data };
  return <EntityDetailCard detail={detail} pendingDelete />;
}

function PhaseFetcher({
  spaceId,
  worldId,
  phaseId,
  fallback,
}: FetcherProps & { readonly phaseId: string }) {
  const { data: characters, isLoading, isError } = useCharacters(
    spaceId,
    worldId,
  );
  if (isLoading || isError || !characters) return <>{fallback}</>;
  // No single-phase fetch exists — phases live embedded in Character.phases.
  // Same lookup the delete_phase tool itself performs for its snapshot.
  const phase = characters
    .flatMap((c) => c.phases)
    .find((p) => p.id === phaseId);
  if (!phase) return <>{fallback}</>;
  const detail: EntityDetail = { kind: "phase", data: phase };
  return <EntityDetailCard detail={detail} pendingDelete />;
}
