import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
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
import { useOpenSpace, useSession, useSetActiveSpace, useSpaces } from "@/hooks";
import type { SpaceSummary } from "@/types";

/**
 * Space picker — sidebar footer switcher.
 *
 * Lives at the bottom of `AppSidebar` (and possibly on the landing page),
 * so the popover opens UPWARD (`side="top"`) to avoid clipping against the
 * window bottom edge.
 *
 * Selection semantics (per ADR-0009):
 * - Already-open Space → `useSetActiveSpace` (just switches tabs).
 * - Not-yet-open Space → `useOpenSpace`. If protected & locked, the backend
 *   rejects with `INVALID_PASSWORD` and the parent's `PasswordGate` overlay
 *   (T20) takes over. The picker intentionally does NOT handle password
 *   entry — that is the designed flow.
 *
 * The "create new Space" affordance is decoupled: it fires `onCreateNew`,
 * which the parent wires to its own create dialog (T24).
 */
interface SpacePickerProps {
  /** Fired when the user picks "Create new Space". Parent owns the dialog. */
  onCreateNew?: () => void;
}

function SpacePicker({ onCreateNew }: SpacePickerProps) {
  const { t } = useTranslation(["space", "common"]);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // The picker owns its own create dialog by default so the "Create new
  // Space" affordance is functional wherever `<SpacePicker />` is mounted
  // (sidebar footer) without each parent having to wire a dialog up.
  // `onCreateNew` is still fired for any caller that wants to override.
  const [createOpen, setCreateOpen] = useState(false);

  const spacesQ = useSpaces();
  const sessionQ = useSession();
  const openSpace = useOpenSpace();
  const setActive = useSetActiveSpace();

  const spaces = spacesQ.data ?? [];
  const openIds = new Set(sessionQ.data?.openSpaceIds ?? []);
  const activeId = sessionQ.data?.activeSpaceId ?? null;
  const activeSpace: SpaceSummary | undefined =
    activeId != null ? spaces.find((s) => s.id === activeId) : undefined;

  // Navigation MUST follow the session mutation — otherwise the tab opens /
  // activates in the TitleBar but the content area stays put (bug). Same
  // pattern as `TitleBar.handleOpen` / `handleActivate`. For a protected
  // Space, `openSpace` succeeds in a locked state and the in-page password
  // gate overlay takes over once the route renders.
  async function handleSelect(space: SpaceSummary) {
    try {
      if (openIds.has(space.id)) {
        await setActive.mutateAsync(space.id);
      } else {
        await openSpace.mutateAsync({ id: space.id });
      }
      navigate({ to: "/space/$spaceId", params: { spaceId: space.id } });
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

  const triggerLabel = activeSpace ? activeSpace.name : t("space:picker.label");

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
          {activeSpace ? activeSpace.name.slice(0, 1) : "·"}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-left",
            activeSpace ? "font-medium" : "text-muted-foreground",
          )}
        >
          {triggerLabel}
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
              {spaces.map((space) => {
                const isOpen = openIds.has(space.id);
                const isActive = space.id === activeId;
                return (
                  <li key={space.id} role="option" aria-selected={isActive}>
                    <button
                      type="button"
                      data-testid={`space-picker-option-${space.name}`}
                      onClick={() => handleSelect(space)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs/relaxed outline-none transition-colors",
                        "focus-visible:ring-2 focus-visible:ring-ring/30",
                        isActive
                          ? "bg-sidebar-accent font-medium text-sidebar-foreground"
                          : "text-foreground hover:bg-muted",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          isActive
                            ? "bg-sidebar-primary"
                            : isOpen
                              ? "bg-muted-foreground/60"
                              : "bg-transparent",
                        )}
                      />
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
                );
              })}
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
