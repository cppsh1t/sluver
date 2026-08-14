import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";

/** A flat {id,label} option for the filter dropdowns. */
export interface TimelineFilterOption {
  id: string;
  label: string;
}

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
}

/**
 * Filter bar for the Timeline. Every control maps to a `TimelineQuery` field
 * (location/novel/item/from/to/includeScenes) EXCEPT `characterId`, which is
 * deliberately not wired — character lanes are a client-side display layer
 * (ADR-0034). The lane multi-select is injected via `laneSelector`.
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
}: TimelineToolbarProps) {
  const { t } = useTranslation("timeline");

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <FilterSelect
        label={t("filter.location")}
        allLabel={t("filter.locationAll")}
        value={locationId}
        options={locations}
        onChange={(id) => onChange({ locationId: id })}
      />
      <FilterSelect
        label={t("filter.novel")}
        allLabel={t("filter.novelAll")}
        value={novelId}
        options={novels}
        onChange={(id) => onChange({ novelId: id })}
      />
      <FilterSelect
        label={t("filter.item")}
        allLabel={t("filter.itemAll")}
        value={itemId}
        options={items}
        onChange={(id) => onChange({ itemId: id })}
      />

      <div className="flex items-center gap-1.5">
        <Input
          type="datetime-local"
          aria-label={t("filter.from")}
          value={from ?? ""}
          onChange={(e) =>
            onChange({ from: e.target.value || undefined })
          }
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
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} data-icon="inline-start" />
          {t("filter.clear")}
        </Button>
      )}
    </div>
  );
}

/** A single-select dropdown mapping to one `TimelineQuery` field. */
function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: string | null;
  options: TimelineFilterOption[];
  onChange: (id: string | null) => void;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v)}>
      <SelectTrigger variant="outline" size="sm" className="w-36">
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        <SelectList>
          <SelectItem value={null}>
            <SelectItemText>{allLabel}</SelectItemText>
            <SelectItemIndicator />
          </SelectItem>
          {options.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              <SelectItemText>{o.label}</SelectItemText>
              <SelectItemIndicator />
            </SelectItem>
          ))}
        </SelectList>
      </SelectContent>
    </Select>
  );
}

export { TimelineToolbar };
