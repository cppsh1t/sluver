import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { SearchablePickerDialog } from "@/components/worldbook/searchable-picker-dialog";
import { EventCard } from "@/components/worldbook/event-card";
import type { Event as EventType } from "@/types";

interface EventMultiPickerProps {
  spaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  events: EventType[];
  selectedIds: string[];
  onCommit: (ids: string[]) => void;
}

/**
 * Multi-select dialog for associating Events with a Scene.
 *
 * The dialog's `open` state is controlled externally (the trigger lives in
 * the scene editor sidebar). On each open transition (false → true) the local
 * selection is re-seeded from `selectedIds`; edits are kept in a local Set
 * until the user clicks "Done", which commits the full id list via `onCommit`
 * and closes. Clicking a card toggles its membership in the local selection.
 *
 * `spaceId`/`worldId` are required by `EventCard`'s interface (used only for
 * navigation links in non-selectable mode, so they're inert here). `worldId`
 * is derived from each event's own `worldId` field; `locationName` is `null`
 * since this picker has no location lookup context; the card falls back to
 * its "no location" label.
 */
function EventMultiPicker({
  spaceId,
  open,
  onOpenChange,
  events,
  selectedIds,
  onCommit,
}: EventMultiPickerProps) {
  const { t } = useTranslation(["novel", "common"]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const prevOpen = useRef(open);

  // Seed local selection + reset search ONLY on the false → true transition.
  // Re-seeding on every `selectedIds` reference change while open would wipe
  // in-progress edits, hence the prevOpen guard.
  useEffect(() => {
    if (!prevOpen.current && open) {
      setSelected(new Set(selectedIds));
      setSearch("");
    }
    prevOpen.current = open;
  }, [open, selectedIds]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return events;
    return events.filter(
      (ev) =>
        ev.name.toLowerCase().includes(q) ||
        ev.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [events, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleDone() {
    onCommit(Array.from(selected));
    onOpenChange(false);
  }

  return (
    <SearchablePickerDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("novel:refs.eventPicker.title")}
      searchPlaceholder={t("novel:refs.eventPicker.searchPlaceholder")}
      searchValue={search}
      onSearchChange={setSearch}
      mode="single"
      footer={
        <div className="flex items-center gap-2">
          <span className="flex-1 text-sm text-muted-foreground">
            {t("novel:refs.events.title")} ({selected.size})
          </span>
          <Button onClick={handleDone}>
            {t("novel:refs.eventPicker.done")}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {filtered.map((ev) => (
          <EventCard
            key={ev.id}
            event={ev}
            spaceId={spaceId}
            worldId={ev.worldId}
            locationName={null}
            selectable
            selected={selected.has(ev.id)}
            onSelect={() => toggle(ev.id)}
          />
        ))}
      </div>
    </SearchablePickerDialog>
  );
}

export { EventMultiPicker };
export type { EventMultiPickerProps };
