import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { HugeiconsIcon } from "@hugeicons/react";
import { Tick02Icon, UserMultiple02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { TimelineLane } from "@/types";

interface TimelineLaneSelectorProps {
  lanes: TimelineLane[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
}

/**
 * Multi-select Popover for choosing which Character lanes are visible on the
 * swimlane grid. Client-side display layer — does NOT touch `TimelineQuery`
 * (per ADR-0034, lanes are a display concern, not a query restriction).
 *
 * Toggle is optimistic: the parent owns the `selectedIds` Set; this component
 * only reports intent via `onToggle`.
 */
function TimelineLaneSelector({
  lanes,
  selectedIds,
  onToggle,
}: TimelineLaneSelectorProps) {
  const { t } = useTranslation("timeline");
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button variant="outline" size="sm" type="button" />
        }
      >
        <HugeiconsIcon
          icon={UserMultiple02Icon}
          strokeWidth={2}
          data-icon="inline-start"
        />
        {t("lane.selector")}
        <span className="ml-0.5 rounded bg-muted px-1 py-px text-[0.625rem] text-muted-foreground">
          {t("lane.selected", { count: selectedIds.size })}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-1"
      >
        <p className="px-2 py-1.5 text-[0.6875rem] text-muted-foreground">
          {t("lane.selectorHint")}
        </p>
        <div className="max-h-72 overflow-y-auto">
          {lanes.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {t("lane.selectNone")}
            </p>
          ) : (
            lanes.map((lane) => {
              const checked = selectedIds.has(lane.characterId);
              return (
                <button
                  key={lane.characterId}
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  onClick={() => onToggle(lane.characterId)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors",
                    "hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-4 shrink-0 items-center justify-center rounded border",
                      checked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-input bg-background",
                    )}
                  >
                    {checked && (
                      <HugeiconsIcon
                        icon={Tick02Icon}
                        strokeWidth={2}
                        className="size-3"
                      />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{lane.name}</span>
                  <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                    {t("lane.participationCount", {
                      count: lane.participationCount,
                    })}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export { TimelineLaneSelector };
export type { TimelineLaneSelectorProps };
