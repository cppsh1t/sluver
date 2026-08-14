import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import {
  TimelineFilterPopover,
  type TimelineFilterOption,
} from "./timeline-filter-popover";
import type { WorldId } from "@/types";

// Re-export so existing imports from this module keep working.
export type { TimelineFilterOption };

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
  locations: TimelineFilterOption[];
  novels: TimelineFilterOption[];
  items: TimelineFilterOption[];
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
 * The three entity filters (location/novel/item) use rich card-select
 * popovers (`TimelineFilterPopover`) — thumbnail + name + description + search
 * — instead of bare text dropdowns.
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

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <TimelineFilterPopover
        label={t("filter.location")}
        allLabel={t("filter.locationAll")}
        value={locationId}
        options={locations}
        onChange={(id) => onChange({ locationId: id })}
        searchPlaceholder={t("filter.search")}
        spaceId={spaceId}
        worldId={worldId}
      />
      <TimelineFilterPopover
        label={t("filter.novel")}
        allLabel={t("filter.novelAll")}
        value={novelId}
        options={novels}
        onChange={(id) => onChange({ novelId: id })}
        searchPlaceholder={t("filter.search")}
        spaceId={spaceId}
        worldId={worldId}
      />
      <TimelineFilterPopover
        label={t("filter.item")}
        allLabel={t("filter.itemAll")}
        value={itemId}
        options={items}
        onChange={(id) => onChange({ itemId: id })}
        searchPlaceholder={t("filter.search")}
        spaceId={spaceId}
        worldId={worldId}
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
