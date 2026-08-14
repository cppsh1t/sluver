import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { EntityCard } from "@/components/worldbook/entity-card";
import {
  NovelFilterCard,
  TimelineFilterPicker,
} from "./timeline-filter-picker";
import type { Item, Location, Novel, WorldId } from "@/types";

/** Patch applied to the Timeline filter state (server-side query params). */
export interface TimelineFilterPatch {
  locationId?: string | null;
  novelId?: string | null;
  itemId?: string | null;
  from?: string | undefined;
  to?: string | undefined;
  includeScenes?: boolean;
}

interface TimelineToolbarProps {
  locationId: string | null;
  novelId: string | null;
  itemId: string | null;
  from: string | undefined;
  to: string | undefined;
  includeScenes: boolean;
  locations: Location[];
  novels: Novel[];
  items: Item[];
  hasActiveFilters: boolean;
  onChange: (patch: TimelineFilterPatch) => void;
  onClear: () => void;
  laneSelector: ReactNode;
  spaceId: string;
  worldId: WorldId;
}

/**
 * Filter bar for the Timeline. Every control maps to a `TimelineQuery` field
 * (location/novel/item/from/to/includeScenes) EXCEPT `characterId`, which is
 * deliberately not wired — character lanes are a client-side display layer
 * (ADR-0034). The lane multi-select is injected via `laneSelector`.
 *
 * The three entity filters (location/novel/item) open a
 * `SearchablePickerDialog` (the same pattern as the chapter/scene editor's
 * LocationRefPicker) showing a searchable grid of EntityCards / NovelFilterCards
 * with a dashed "All" clear option.
 */
function TimelineToolbar({
  locationId,
  novelId,
  itemId,
  from,
  to,
  includeScenes,
  locations,
  novels,
  items,
  hasActiveFilters,
  onChange,
  onClear,
  laneSelector,
  spaceId,
  worldId,
}: TimelineToolbarProps) {
  const { t } = useTranslation("timeline");

  const selectedLocation = locations.find((l) => l.id === locationId);
  const selectedNovel = novels.find((n) => n.id === novelId);
  const selectedItem = items.find((i) => i.id === itemId);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <TimelineFilterPicker<Location>
        triggerLabel={t("filter.location")}
        selectedLabel={selectedLocation?.name}
        dialogTitle={t("filter.locationTitle")}
        searchPlaceholder={t("filter.searchPlaceholder")}
        allLabel={t("filter.locationAll")}
        value={locationId}
        onChange={(id) => onChange({ locationId: id })}
        options={locations}
        getId={(l) => l.id}
        getSearchText={(l) => l.name}
        spaceId={spaceId}
        worldId={worldId}
        renderCard={(l, selected, onSelect) => (
          <EntityCard
            spaceId={spaceId}
            worldId={worldId}
            id={l.id}
            name={l.name}
            description={l.description}
            tags={l.tags}
            updatedAt={l.updatedAt}
            entityType="location"
            selectable
            selected={selected}
            onSelect={onSelect}
          />
        )}
      />

      <TimelineFilterPicker<Novel>
        triggerLabel={t("filter.novel")}
        selectedLabel={selectedNovel?.title}
        dialogTitle={t("filter.novelTitle")}
        searchPlaceholder={t("filter.searchPlaceholder")}
        allLabel={t("filter.novelAll")}
        value={novelId}
        onChange={(id) => onChange({ novelId: id })}
        options={novels}
        getId={(n) => n.id}
        getSearchText={(n) => n.title}
        spaceId={spaceId}
        worldId={worldId}
        renderCard={(n, selected, onSelect) => (
          <NovelFilterCard
            novel={n}
            selected={selected}
            onSelect={onSelect}
          />
        )}
      />

      <TimelineFilterPicker<Item>
        triggerLabel={t("filter.item")}
        selectedLabel={selectedItem?.name}
        dialogTitle={t("filter.itemTitle")}
        searchPlaceholder={t("filter.searchPlaceholder")}
        allLabel={t("filter.itemAll")}
        value={itemId}
        onChange={(id) => onChange({ itemId: id })}
        options={items}
        getId={(i) => i.id}
        getSearchText={(i) => `${i.name} ${i.tags.join(" ")}`}
        spaceId={spaceId}
        worldId={worldId}
        renderCard={(i, selected, onSelect) => (
          <EntityCard
            spaceId={spaceId}
            worldId={worldId}
            id={i.id}
            name={i.name}
            description={i.description}
            tags={i.tags}
            updatedAt={i.updatedAt}
            entityType="item"
            selectable
            selected={selected}
            onSelect={onSelect}
          />
        )}
      />

      <div className="flex items-center gap-1.5">
        <Input
          type="datetime-local"
          aria-label={t("filter.from")}
          value={from ?? ""}
          onChange={(e) => onChange({ from: e.target.value || undefined })}
          className="h-7 w-44 text-xs"
        />
        <span className="text-xs text-muted-foreground">–</span>
        <Input
          type="datetime-local"
          aria-label={t("filter.to")}
          value={to ?? ""}
          onChange={(e) => onChange({ to: e.target.value || undefined })}
          className="h-7 w-44 text-xs"
        />
      </div>

      <label className="flex items-center gap-1.5 rounded-md border border-transparent px-1.5 py-1 text-xs text-muted-foreground">
        <Switch
          checked={includeScenes}
          onCheckedChange={(v) => onChange({ includeScenes: v })}
          size="sm"
        />
        {t("filter.includeScenes")}
      </label>

      {laneSelector}

      {hasActiveFilters && (
        <Button variant="ghost" size="sm" onClick={onClear} type="button">
          <HugeiconsIcon
            icon={Cancel01Icon}
            strokeWidth={2}
            data-icon="inline-start"
          />
          {t("filter.clear")}
        </Button>
      )}
    </div>
  );
}

export { TimelineToolbar };
