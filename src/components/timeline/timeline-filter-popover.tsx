import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { EntityAvatar, type EntityImageId } from "@/components/ui/entity-avatar";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  Book02Icon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { SpaceId, WorldId } from "@/types";
/** Option shape for the filter popover — richer than a bare {id,label}. */
export interface TimelineFilterOption {
  id: string;
  label: string;
  description?: string;
  /** EntityAvatar kind; novels omit → Book02Icon fallback. */
  avatarKind?: "location" | "item";
}

interface TimelineFilterPopoverProps {
  /** Trigger placeholder, e.g. t("filter.location"). */
  label: string;
  /** The "All / clear" option text, e.g. t("filter.locationAll"). */
  allLabel: string;
  value: string | null;
  options: TimelineFilterOption[];
  onChange: (id: string | null) => void;
  searchPlaceholder: string;
  /** Needed to render EntityAvatar thumbnails. */
  spaceId: string;
  worldId: WorldId;
}

/**
 * Single-select Popover whose option rows are rich compact cards (thumbnail +
 * name + description excerpt) — a denser alternative to a plain `Select`.
 * Mirrors the EntityCard aesthetic without the heavy banner.
 *
 * Non-modal: picking an option commits immediately and closes the popover.
 */
function TimelineFilterPopover({
  label,
  allLabel,
  value,
  options,
  onChange,
  searchPlaceholder,
  spaceId,
  worldId,
}: TimelineFilterPopoverProps) {
  const { t } = useTranslation("timeline");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, search]);

  const selectedLabel = options.find((o) => o.id === value)?.label;

  function handleSelect(id: string | null) {
    onChange(id);
    setOpen(false);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) setSearch("");
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" type="button" className="gap-1" />
        }
      >
        <span className={cn("truncate", !selectedLabel && "text-muted-foreground")}>
          {selectedLabel ?? label}
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      </PopoverTrigger>

      <PopoverContent align="start" className="w-72 p-0">
        {/* Search */}
        <div className="border-b p-2">
          <div className="relative">
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={2}
              className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 pl-8 text-xs"
            />
          </div>
        </div>

        <div className="max-h-72 overflow-y-auto p-1">
          {/* Dashed "All" clear button */}
          <button
            type="button"
            onClick={() => handleSelect(null)}
            className={cn(
              "mb-1 flex w-full items-center justify-center rounded-md border-2 border-dashed px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted",
              value === null && "border-primary text-primary",
            )}
          >
            {allLabel}
          </button>

          {filtered.length === 0 ? (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t("filter.noResults")}
            </p>
          ) : (
            filtered.map((option) => {
              const selected = value === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => handleSelect(option.id)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <FilterOptionThumbnail
                    option={option}
                    spaceId={spaceId}
                    worldId={worldId}
                  />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="min-w-0 truncate text-sm font-medium">
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    )}
                  </span>
                  {selected && (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      strokeWidth={2}
                      className="size-4 shrink-0 text-primary"
                    />
                  )}
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** Left thumbnail: EntityAvatar for location/item, Book02Icon square for novels. */
function FilterOptionThumbnail({
  option,
  spaceId,
  worldId,
}: {
  option: TimelineFilterOption;
  spaceId: string;
  worldId: WorldId;
}) {
  if (option.avatarKind) {
    return (
      <EntityAvatar
        kind={option.avatarKind}
        spaceId={spaceId as SpaceId}
        worldId={worldId}
        id={option.id as EntityImageId}
        aspect={1}
        alt={option.label}
        className="size-9 shrink-0 rounded-md"
      />
    );
  }
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
      <HugeiconsIcon
        icon={Book02Icon}
        strokeWidth={2}
        className="size-4 text-muted-foreground"
      />
    </span>
  );
}

export { TimelineFilterPopover };
export type { TimelineFilterPopoverProps };
