import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { SearchablePickerDialog } from "@/components/worldbook/searchable-picker-dialog";
import { EntityCard } from "@/components/worldbook/entity-card";
import { cn } from "@/lib/utils";
import type { Location } from "@/types";

interface LocationRefPickerProps {
  locations: Location[];
  selectedLocationId: string | null;
  onSelect: (locationId: string | null) => void;
}

/**
 * Single-panel searchable dialog for picking a Location (or clearing it via
 * "无地点"). Selecting a card commits immediately and closes the dialog.
 */
function LocationRefPicker({
  locations,
  selectedLocationId,
  onSelect,
}: LocationRefPickerProps) {
  const { t } = useTranslation(["event", "common"]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return locations;
    return locations.filter((loc) =>
      loc.name.toLowerCase().includes(q),
    );
  }, [locations, search]);

  function handleSelect(id: string | null) {
    onSelect(id);
    setOpen(false);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) setSearch("");
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        {t("event:detail.location.change")}
      </Button>
      <SearchablePickerDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={t("event:picker.location.title")}
        searchPlaceholder={t("event:picker.location.searchPlaceholder")}
        searchValue={search}
        onSearchChange={setSearch}
        mode="single"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => handleSelect(null)}
            className={cn(
              "flex items-center justify-center rounded-lg border-2 border-dashed p-4 text-sm text-muted-foreground transition-colors hover:bg-muted",
              selectedLocationId === null && "border-primary text-primary",
            )}
          >
            {t("event:picker.location.none")}
          </button>
          {filtered.map((loc) => (
            <EntityCard
              key={loc.id}
              name={loc.name}
              description={loc.description}
              tags={loc.tags}
              updatedAt={loc.updatedAt}
              entityType="location"
              selectable
              selected={loc.id === selectedLocationId}
              onSelect={() => handleSelect(loc.id)}
            />
          ))}
        </div>
        {filtered.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("event:list.noResults")}
          </p>
        )}
      </SearchablePickerDialog>
    </>
  );
}

export { LocationRefPicker };
