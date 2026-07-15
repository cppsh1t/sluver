import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { Location } from "@/types";

interface LocationRefPickerProps {
  locations: Location[];
  selectedLocationId: string | null;
  onSelect: (locationId: string | null) => void;
}

/**
 * Single-step popover for picking a Location (or clearing it via "无地点").
 * Each location shows its name and a 1–2 line description preview.
 */
function LocationRefPicker({
  locations,
  selectedLocationId,
  onSelect,
}: LocationRefPickerProps) {
  const { t } = useTranslation(["event", "common"]);
  const [open, setOpen] = useState(false);

  function handleSelect(id: string | null) {
    onSelect(id);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        {t("event:detail.location.change")}
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <p className="px-2 pt-2 text-xs font-medium text-muted-foreground">
          {t("event:picker.location.title")}
        </p>
        <div className="flex max-h-72 flex-col overflow-y-auto p-1">
          <button
            type="button"
            className="rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
            onClick={() => handleSelect(null)}
          >
            {t("event:picker.location.none")}
          </button>
          {locations.map((loc) => {
            const active = loc.id === selectedLocationId;
            return (
              <button
                key={loc.id}
                type="button"
                aria-current={active ? true : undefined}
                className="flex flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted aria-current:bg-muted"
                onClick={() => handleSelect(loc.id)}
              >
                <span className="truncate font-medium">{loc.name}</span>
                {loc.description && (
                  <span className="line-clamp-2 text-muted-foreground">
                    {loc.description}
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

export { LocationRefPicker };
