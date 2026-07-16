import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { EntityCard } from "@/components/worldbook/entity-card";
import { ParticipantCard } from "@/components/worldbook/participant-card";
import { CharacterRefPicker } from "@/components/worldbook/character-ref-picker";
import { LocationRefPicker } from "@/components/worldbook/location-ref-picker";
import { ItemMultiPicker } from "@/components/worldbook/item-multi-picker";
import { EventMultiPicker } from "@/components/worldbook/event-multi-picker";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Calendar03Icon } from "@hugeicons/core-free-icons";
import type {
  Character,
  CharacterRef,
  Event as EventType,
  Item,
  Location,
  Scene,
  WorldId,
} from "@/types";

export type WorkspaceMode = "edit" | "read";

interface SceneRefSidebarProps {
  mode: WorkspaceMode;
  worldId: WorldId;
  activeScene: Scene | null;
  allScenes: Scene[];
  characters: Character[];
  locations: Location[];
  items: Item[];
  events: EventType[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onCharacterRefsChange: (refs: CharacterRef[]) => void;
  onLocationIdChange: (locationId: string | null) => void;
  onItemIdsChange: (ids: string[]) => void;
  onEventIdsChange: (ids: string[]) => void;
}

function SceneRefSidebar({
  mode,
  worldId,
  activeScene,
  allScenes,
  characters,
  locations,
  items,
  events,
  collapsed,
  onToggleCollapsed,
  onCharacterRefsChange,
  onLocationIdChange,
  onItemIdsChange,
  onEventIdsChange,
}: SceneRefSidebarProps) {
  const { t } = useTranslation(["novel", "common", "event"]);
  const [itemPickerOpen, setItemPickerOpen] = useState(false);
  const [eventPickerOpen, setEventPickerOpen] = useState(false);

  const charMap = useMemo(() => {
    const m = new Map<string, Character>();
    for (const c of characters) m.set(c.id, c);
    return m;
  }, [characters]);

  const locMap = useMemo(() => {
    const m = new Map<string, Location>();
    for (const l of locations) m.set(l.id, l);
    return m;
  }, [locations]);

  const itemMap = useMemo(() => {
    const m = new Map<string, Item>();
    for (const i of items) m.set(i.id, i);
    return m;
  }, [items]);

  const eventMap = useMemo(() => {
    const m = new Map<string, EventType>();
    for (const e of events) m.set(e.id, e);
    return m;
  }, [events]);

  // ─── Reading mode: aggregate all scenes' refs (deduplicated) ───────────

  const aggregate = useMemo(() => {
    const charRefSet = new Set<string>();
    const charRefs: CharacterRef[] = [];
    const itemSet = new Set<string>();
    const itemIds: string[] = [];
    const eventSet = new Set<string>();
    const eventIds: string[] = [];
    const locSet = new Set<string>();
    const locIds: string[] = [];

    for (const sc of allScenes) {
      for (const r of sc.characterRefs) {
        const key = `${r.characterId}:${r.phaseId}`;
        if (!charRefSet.has(key)) {
          charRefSet.add(key);
          charRefs.push(r);
        }
      }
      for (const id of sc.itemIds) {
        if (!itemSet.has(id)) {
          itemSet.add(id);
          itemIds.push(id);
        }
      }
      for (const id of sc.eventIds) {
        if (!eventSet.has(id)) {
          eventSet.add(id);
          eventIds.push(id);
        }
      }
      if (sc.locationId && !locSet.has(sc.locationId)) {
        locSet.add(sc.locationId);
        locIds.push(sc.locationId);
      }
    }

    return { charRefs, itemIds, eventIds, locIds };
  }, [allScenes]);

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-l bg-background py-3">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="text-xs text-muted-foreground [writing-mode:vertical-lr] hover:text-foreground"
        >
          {t("novel:refs.chapterOverview")}
        </button>
      </div>
    );
  }

  // ─── Edit mode: active scene's refs ────────────────────────────────────

  const sceneRefs = mode === "edit" ? activeScene : null;
  const displayCharRefs = mode === "edit" ? (activeScene?.characterRefs ?? []) : aggregate.charRefs;
  const displayLocationId = mode === "edit" ? (activeScene?.locationId ?? null) : aggregate.locIds[0] ?? null;
  const displayAllLocationIds = mode === "read" ? aggregate.locIds : [];
  const displayItemIds = mode === "edit" ? (activeScene?.itemIds ?? []) : aggregate.itemIds;
  const displayEventIds = mode === "edit" ? (activeScene?.eventIds ?? []) : aggregate.eventIds;

  const isReadonly = mode === "read";

  return (
    <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-l bg-background">
      {/* Collapse button */}
      <div className="flex justify-end border-b px-3 py-1.5">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          »
        </button>
      </div>

      {mode === "read" && (
        <div className="border-b px-3 py-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t("novel:refs.chapterOverview")}
          </p>
        </div>
      )}

      {/* Characters */}
      <div className="flex flex-col gap-2 border-b px-3 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">
            {t("novel:refs.characters.title")}
          </h3>
          {!isReadonly && sceneRefs && (
            <CharacterRefPicker
              worldId={worldId}
              selectedRefs={sceneRefs.characterRefs}
              characters={characters}
              onCommit={onCharacterRefsChange}
            />
          )}
        </div>
        {displayCharRefs.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("novel:refs.characters.empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {displayCharRefs.map((ref) => {
              const c = charMap.get(ref.characterId);
              const p = c?.phases.find((ph) => ph.id === ref.phaseId);
              if (!c || !p) return null;
              return (
                <ParticipantCard
                  key={`${ref.characterId}-${ref.phaseId}`}
                  characterName={c.name}
                  characterAliases={c.aliases}
                  phaseName={p.name}
                  phaseAppearance={p.appearance}
                  phaseChanges={p.changes}
                  onRemove={
                    isReadonly
                      ? undefined
                      : () =>
                          onCharacterRefsChange(
                            displayCharRefs.filter(
                              (r) =>
                                !(
                                  r.characterId === ref.characterId &&
                                  r.phaseId === ref.phaseId
                                ),
                            ),
                          )
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Location */}
      <div className="flex flex-col gap-2 border-b px-3 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">
            {t("novel:refs.location.title")}
          </h3>
          {!isReadonly && sceneRefs && (
            <LocationRefPicker
              locations={locations}
              selectedLocationId={sceneRefs.locationId}
              onSelect={onLocationIdChange}
            />
          )}
        </div>
        {mode === "read" ? (
          displayAllLocationIds.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("novel:refs.location.none")}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {displayAllLocationIds.map((id) => {
                const loc = locMap.get(id);
                if (!loc) return null;
                return (
                  <EntityCard
                    key={id}
                    name={loc.name}
                    description={loc.description}
                    tags={loc.tags}
                    updatedAt={loc.updatedAt}
                    entityType="location"
                  />
                );
              })}
            </div>
          )
        ) : displayLocationId ? (
          (() => {
            const loc = locMap.get(displayLocationId);
            if (!loc) return <p className="text-xs text-muted-foreground">{t("novel:refs.location.none")}</p>;
            return (
              <EntityCard
                name={loc.name}
                description={loc.description}
                tags={loc.tags}
                updatedAt={loc.updatedAt}
                entityType="location"
                selectable
                selected
                onRemove={() => onLocationIdChange(null)}
              />
            );
          })()
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("novel:refs.location.none")}
          </p>
        )}
      </div>

      {/* Items */}
      <div className="flex flex-col gap-2 border-b px-3 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">
            {t("novel:refs.items.title")}
          </h3>
          {!isReadonly && sceneRefs && (
            <Button variant="outline" size="sm" onClick={() => setItemPickerOpen(true)}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-3.5" />
              {t("novel:refs.items.add")}
            </Button>
          )}
        </div>
        {displayItemIds.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("novel:refs.items.empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {displayItemIds.map((id) => {
              const item = itemMap.get(id);
              if (!item) return null;
              return (
                <EntityCard
                  key={id}
                  name={item.name}
                  description={item.description}
                  tags={item.tags}
                  updatedAt={item.updatedAt}
                  entityType="item"
                  selectable
                  selected
                  onRemove={
                    isReadonly
                      ? undefined
                      : () =>
                          onItemIdsChange(
                            displayItemIds.filter((i) => i !== id),
                          )
                  }
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Events */}
      <div className="flex flex-col gap-2 px-3 py-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">
            {t("novel:refs.events.title")}
          </h3>
          {!isReadonly && sceneRefs && (
            <Button variant="outline" size="sm" onClick={() => setEventPickerOpen(true)}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-3.5" />
              {t("novel:refs.events.add")}
            </Button>
          )}
        </div>
        {displayEventIds.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("novel:refs.events.empty")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {displayEventIds.map((id) => {
              const evt = eventMap.get(id);
              if (!evt) return null;
              return (
                <div key={id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                  <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{evt.name}</p>
                    {evt.description && (
                      <p className="truncate text-xs text-muted-foreground">{evt.description}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Picker dialogs */}
      {sceneRefs && (
        <>
          <ItemMultiPicker
            open={itemPickerOpen}
            onOpenChange={setItemPickerOpen}
            items={items}
            selectedIds={sceneRefs.itemIds}
            onCommit={onItemIdsChange}
          />
          <EventMultiPicker
            open={eventPickerOpen}
            onOpenChange={setEventPickerOpen}
            events={events}
            selectedIds={sceneRefs.eventIds}
            onCommit={onEventIdsChange}
          />
        </>
      )}
    </div>
  );
}

export { SceneRefSidebar };
export type { SceneRefSidebarProps };
