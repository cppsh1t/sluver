import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { SearchablePickerDialog } from "@/components/worldbook/searchable-picker-dialog";
import { EventCard } from "@/components/worldbook/event-card";
import { cn } from "@/lib/utils";
import type { Event, EventId, Location, WorldId } from "@/types";

interface EventRefPickerProps {
  worldId: WorldId;
  events: Event[];
  locations: Location[];
  selectedEventId: EventId | null;
  onSelect: (eventId: EventId | null) => void;
}

/**
 * Single-panel searchable dialog picker for an Event reference
 * (`triggerEventId`).
 *
 * Shows the full list of world events plus a "no trigger event" option that
 * selects `null`. Selecting a card commits immediately and closes the dialog.
 * Used by {@link PhaseCard} to set the event that triggered a character's
 * transition into a phase (see CONTEXT.md → CharacterPhase).
 */
function EventRefPicker({
  worldId,
  events,
  locations,
  selectedEventId,
  onSelect,
}: EventRefPickerProps) {
  const { t } = useTranslation(["event", "common"]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selected = events.find((e) => e.id === selectedEventId);

  const locationNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const loc of locations) {
      map.set(loc.id, loc.name);
    }
    return map;
  }, [locations]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return events;
    return events.filter((event) =>
      event.name.toLowerCase().includes(q),
    );
  }, [events, search]);

  function handleSelect(id: EventId | null) {
    onSelect(id);
    setOpen(false);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) setSearch("");
  }

  return (
    <>
      <Button
        variant="outline"
        className="w-full justify-start font-normal"
        onClick={() => setOpen(true)}
      >
        {selected ? (
          selected.name
        ) : (
          <span className="text-muted-foreground">
            {t("event:picker.event.none")}
          </span>
        )}
      </Button>
      <SearchablePickerDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={t("event:picker.event.title")}
        searchPlaceholder={t("event:picker.event.searchPlaceholder")}
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
              selectedEventId === null && "border-primary text-primary",
            )}
          >
            {t("event:picker.event.none")}
          </button>
          {filtered.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              worldId={worldId}
              locationName={
                event.locationId
                  ? (locationNameById.get(event.locationId) ?? null)
                  : null
              }
              selectable
              selected={event.id === selectedEventId}
              onSelect={() => handleSelect(event.id)}
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

export { EventRefPicker };
