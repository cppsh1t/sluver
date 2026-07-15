import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { Event, EventId } from "@/types";

/**
 * Single-step popover picker for an Event reference (`triggerEventId`).
 *
 * Shows the full list of world events plus a "no trigger event" option that
 * selects `null`. Used by {@link PhaseCard} to set the event that triggered a
 * character's transition into a phase (see CONTEXT.md → CharacterPhase).
 */
interface EventRefPickerProps {
  events: Event[];
  selectedEventId: EventId | null;
  onSelect: (eventId: EventId | null) => void;
}

function EventRefPicker({
  events,
  selectedEventId,
  onSelect,
}: EventRefPickerProps) {
  const { t } = useTranslation(["event", "common"]);
  const [open, setOpen] = useState(false);

  const selected = events.find((e) => e.id === selectedEventId);

  function handleSelect(id: EventId | null) {
    onSelect(id);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            className="w-full justify-start font-normal"
          />
        }
      >
        {selected ? (
          selected.name
        ) : (
          <span className="text-muted-foreground">
            {t("event:picker.event.none")}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent className="max-h-72 overflow-y-auto p-1">
        <div role="listbox" className="flex flex-col">
          <button
            type="button"
            role="option"
            aria-selected={selectedEventId === null}
            onClick={() => handleSelect(null)}
            className={cn(
              "flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
              selectedEventId === null && "bg-accent",
            )}
          >
            <span className="flex-1 text-muted-foreground">
              {t("event:picker.event.none")}
            </span>
            {selectedEventId === null && (
              <HugeiconsIcon
                icon={Tick02Icon}
                strokeWidth={2}
                className="text-primary"
              />
            )}
          </button>
          {events.map((event) => {
            const active = event.id === selectedEventId;
            return (
              <button
                key={event.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => handleSelect(event.id)}
                className={cn(
                  "flex flex-col gap-0.5 rounded-sm px-2 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
                  active && "bg-accent",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{event.name}</span>
                  {active && (
                    <HugeiconsIcon
                      icon={Tick02Icon}
                      strokeWidth={2}
                      className="shrink-0 text-primary"
                    />
                  )}
                </span>
                {event.description && (
                  <span className="line-clamp-1 text-xs text-muted-foreground">
                    {event.description}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export { EventRefPicker };
