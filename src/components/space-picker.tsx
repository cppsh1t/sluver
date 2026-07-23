import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  ChevronDownIcon,
  LockIcon,
} from "@hugeicons/core-free-icons";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { CreateSpaceDialog } from "@/components/space-management";
import { cn } from "@/lib/utils";
import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import { useOpenSpaceInWindow, useSpaces } from "@/hooks";
import type { SpaceSummary } from "@/types";

/**
 * Space picker — sidebar footer switcher (ADR-0011 multi-window).
 *
 * Lives at the bottom of `AppSidebar`. Clicking a Space opens it in a NEW
 * OS window (or focuses an existing one) via `useOpenSpaceInWindow`, which
 * composes the session/DB unlock and the native-window creation. This
 * replaces the old tab-switching behavior (ADR-0009, superseded).
 *
 * For protected Spaces without a password, the Space opens in a locked
 * state — the new window will show the `SpacePasswordGate` overlay.
 *
 * The picker does NOT handle password entry — that's the gate's job.
 */
interface SpacePickerProps {
  /** Fired when the user picks "Create new Space". Parent owns the dialog. */
  onCreateNew?: () => void;
}

function SpacePicker({ onCreateNew }: SpacePickerProps) {
  const { t } = useTranslation(["space", "common"]);
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const spacesQ = useSpaces();
  const openInWindow = useOpenSpaceInWindow();

  const spaces = spacesQ.data ?? [];

  async function handleSelect(space: SpaceSummary) {
    try {
      await openInWindow.mutateAsync({ id: space.id });
    } catch (e) {
      toast.error(i18n.t("space:toast.openFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
    setOpen(false);
  }

  function handleCreateNew() {
    setOpen(false);
    if (onCreateNew) {
      onCreateNew();
    } else {
      setCreateOpen(true);
    }
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              data-testid="sidebar-space-picker"
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm outline-none transition-colors",
                "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                "text-sidebar-foreground hover:bg-sidebar-accent/60",
              )}
            />
          }
        >
          <span
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-sidebar-accent text-[10px] font-semibold uppercase text-sidebar-foreground/80"
          >
            S
          </span>
          <span className="min-w-0 flex-1 truncate text-left font-medium text-muted-foreground">
            {t("space:picker.label")}
          </span>
          <HugeiconsIcon
            icon={ChevronDownIcon}
            strokeWidth={2}
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        </PopoverTrigger>

        <PopoverContent
          side="top"
          align="start"
          sideOffset={6}
          className="w-60 p-1.5"
          data-testid="space-picker-menu"
        >
          {spaces.length === 0 ? (
            <div className="flex flex-col gap-2 px-2 py-3">
              <p className="text-xs font-medium text-foreground">
                {t("space:picker.empty")}
              </p>
              <p className="text-xs/relaxed text-muted-foreground">
                {t("space:picker.emptyHint")}
              </p>
              <button
                type="button"
                onClick={handleCreateNew}
                className={cn(
                  "mt-1 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs/relaxed outline-none transition-colors",
                  "text-primary hover:bg-primary/10",
                  "focus-visible:ring-2 focus-visible:ring-ring/30",
                )}
              >
                <HugeiconsIcon
                  icon={Add01Icon}
                  strokeWidth={2}
                  className="size-3.5 shrink-0"
                />
                {t("space:picker.createNew")}
              </button>
            </div>
          ) : (
            <>
              <ul
                role="listbox"
                aria-label={t("space:picker.label")}
                className="flex flex-col gap-0.5"
              >
                {spaces.map((space) => (
                  <li key={space.id} role="option">
                    <button
                      type="button"
                      data-testid={`space-picker-option-${space.name}`}
                      onClick={() => handleSelect(space)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs/relaxed outline-none transition-colors",
                        "focus-visible:ring-2 focus-visible:ring-ring/30",
                        "text-foreground hover:bg-muted",
                      )}
                    >
                      <span
                        aria-hidden
                        className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-muted text-[10px] font-semibold uppercase text-muted-foreground"
                      >
                        {space.name.slice(0, 1)}
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {space.name}
                      </span>
                      {space.hasPassword && (
                        <HugeiconsIcon
                          icon={LockIcon}
                          strokeWidth={2}
                          className="size-3.5 shrink-0 text-muted-foreground"
                        />
                      )}
                    </button>
                  </li>
                ))}
              </ul>
              <Separator className="my-1.5" />
              <button
                type="button"
                onClick={handleCreateNew}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs/relaxed outline-none transition-colors",
                  "text-muted-foreground hover:bg-muted hover:text-foreground",
                  "focus-visible:ring-2 focus-visible:ring-ring/30",
                )}
              >
                <HugeiconsIcon
                  icon={Add01Icon}
                  strokeWidth={2}
                  className="size-3.5 shrink-0"
                />
                {t("space:picker.createNew")}
              </button>
            </>
          )}
        </PopoverContent>
      </Popover>

      <CreateSpaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

export { SpacePicker };
