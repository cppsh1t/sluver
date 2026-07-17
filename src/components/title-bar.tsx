import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Cancel01Icon,
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
import {
  useCloseSpace,
  useOpenSpace,
  useSetActiveSpace,
  useSession,
  useSpaces,
} from "@/hooks";
import type { SpaceId, SpaceSummary } from "@/types";

/**
 * Custom frameless titlebar — browser-style Space tabs (ADR-0009).
 *
 * The bar is a Tauri drag region (`data-tauri-drag-region="deep"`, Tauri 2.11):
 * `deep` propagates window-dragging to the bar's non-interactive area (the
 * gaps between tabs), while the tabs / close buttons / `[+]` are real
 * `<button>` elements that opt out of dragging by being interactive. Window
 * controls are NOT rendered here — `tauri-plugin-decorum` injects them
 * (Windows caption buttons top-right; macOS traffic lights top-left).
 *
 * Tabs mirror the session's `openSpaceIds`; the active tab mirrors
 * `activeSpaceId`. Clicking a tab activates it server-side and navigates to
 * `/space/$spaceId`; closing the active tab navigates to the next remaining
 * open Space or back to the landing. The `[+]` opens a small launcher popover
 * (switch to an existing Space / open a closed one / create a new one).
 */
export function TitleBar() {
  const { t } = useTranslation(["space", "common"]);
  const navigate = useNavigate();

  const sessionQ = useSession();
  const spacesQ = useSpaces();
  const setActive = useSetActiveSpace();
  const closeSpace = useCloseSpace();
  const openSpace = useOpenSpace();

  const [createOpen, setCreateOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const openIds = sessionQ.data?.openSpaceIds ?? [];
  const activeId = sessionQ.data?.activeSpaceId ?? null;
  const spaces = spacesQ.data ?? [];
  const openIdsSet = new Set(openIds);

  const byId = (id: SpaceId): SpaceSummary | undefined =>
    spaces.find((s) => s.id === id);

  function handleActivate(id: SpaceId) {
    setActive.mutate(id);
    navigate({ to: "/space/$spaceId", params: { spaceId: id } });
  }

  async function handleClose(id: SpaceId) {
    const wasActive = id === activeId;
    // Compute the fallback tab synchronously from current state — the
    // mutation updates the session cache asynchronously, but we want the
    // navigation to feel instant.
    const remaining = openIds.filter((x) => x !== id);
    await closeSpace.mutateAsync(id);
    if (!wasActive) return;
    if (remaining.length > 0) {
      const idx = openIds.indexOf(id);
      const nextIdx = Math.min(idx, remaining.length - 1);
      const nextId = remaining[nextIdx];
      await setActive.mutateAsync(nextId);
      navigate({ to: "/space/$spaceId", params: { spaceId: nextId } });
    } else {
      navigate({ to: "/" });
    }
  }

  async function handleOpen(space: SpaceSummary) {
    // Mirrors SpacePicker semantics: already-open → switch; closed → open.
    // A protected Space is opened in its locked state by the backend and the
    // in-page `SpacePasswordGate` overlay takes over once the tab renders.
    if (openIdsSet.has(space.id)) {
      setActive.mutate(space.id);
      navigate({ to: "/space/$spaceId", params: { spaceId: space.id } });
    } else {
      try {
        await openSpace.mutateAsync({ id: space.id });
        navigate({ to: "/space/$spaceId", params: { spaceId: space.id } });
      } catch {
        // Open rejected (e.g. protected). Stay put — do not navigate to a
        // Space whose tab never materialized. No toast: matches picker.
      }
    }
    setMenuOpen(false);
  }

  function handleCreateNew() {
    setMenuOpen(false);
    setCreateOpen(true);
  }

  return (
    <div
      data-tauri-drag-region="deep"
      className={cn(
        "flex h-9 shrink-0 items-center gap-1 border-b border-sidebar-border bg-sidebar px-2",
        // Leave room for decorum's native caption buttons (Win/Linux, top-right)
        // and the macOS traffic lights (top-left).
        "pl-[80px] pr-[140px]",
      )}
    >
      <div
        role="tablist"
        aria-label={t("space:tabs.aria")}
        className="flex min-w-0 items-center gap-0.5"
      >
        {openIds.map((id) => {
          const space = byId(id);
          const active = id === activeId;
          const name = space?.name ?? t("space:tabs.loading");
          const protectedSpace = space?.hasPassword ?? false;
          return (
            <div
              key={id}
              role="tab"
              aria-selected={active ? true : undefined}
              className={cn(
                "group/tab flex h-7 max-w-[200px] cursor-default items-center gap-1.5 rounded-md px-2.5 text-xs outline-none transition-colors",
                "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                active
                  ? "bg-sidebar-accent text-sidebar-foreground"
                  : "text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
              )}
            >
              <button
                type="button"
                onClick={() => handleActivate(id)}
                className="flex min-w-0 items-center gap-1.5 outline-none"
              >
                {protectedSpace && (
                  <HugeiconsIcon
                    icon={LockIcon}
                    strokeWidth={2}
                    className="size-3 shrink-0 text-muted-foreground"
                  />
                )}
                <span className="truncate">{name}</span>
              </button>
              <button
                type="button"
                aria-label={t("space:tabs.close", { name })}
                onClick={() => handleClose(id)}
                className={cn(
                  "flex size-4 shrink-0 items-center justify-center rounded-sm outline-none transition-colors",
                  "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                  active
                    ? "text-muted-foreground"
                    : "text-transparent group-hover/tab:text-muted-foreground",
                )}
              >
                <HugeiconsIcon
                  icon={Cancel01Icon}
                  strokeWidth={2}
                  className="size-3"
                />
              </button>
            </div>
          );
        })}
      </div>

      {/* [+] launcher: switch / open / create a Space. */}
      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={t("space:tabs.newSpace")}
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors",
                "hover:bg-sidebar-accent hover:text-sidebar-foreground",
                "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              )}
            />
          }
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-4" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="w-60 p-1.5"
          data-testid="titlebar-space-menu"
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
                className="flex max-h-72 flex-col gap-0.5 overflow-y-auto"
              >
                {spaces.map((space) => {
                  const isOpen = openIdsSet.has(space.id);
                  const isActive = space.id === activeId;
                  return (
                    <li key={space.id} role="option" aria-selected={isActive}>
                      <button
                        type="button"
                        onClick={() => handleOpen(space)}
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
    </div>
  );
}
