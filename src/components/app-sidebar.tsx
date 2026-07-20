import { useState } from "react";
import {
  Link,
  useRouterState,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  BookOpen02Icon,
  Delete02Icon,
  Globe02Icon,
  LockKeyIcon,
  MoreHorizontalIcon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";

import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import appIcon from "@/assets/app-icon.png";
import { cn } from "@/lib/utils";
import { SpacePicker } from "@/components/space-picker";
import {
  DeleteSpaceDialog,
  SpacePasswordDialog,
} from "@/components/space-management";
import { CreateWorldDialog } from "@/components/world-hub/create-world-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useCreateWorld,
  useSpaces,
  useWorlds,
} from "@/hooks";
import type { CreateWorldInput } from "@/api";
import type { SpaceSummary } from "@/types";

/**
 * Context-sensitive application sidebar (ADR-0009 middle tier).
 *
 * Mode is derived from the current route + session, since this component is
 * mounted in two places:
 *   - `_app.tsx` (landing / library / settings) → **landing mode**: brand +
 *     Library nav; footer hosts the Space picker + Settings.
 *   - space-home `index.tsx` (at `/space/$spaceId`, not inside a world) →
 *     **space-home mode**: brand + the active Space's Worlds list + Create
 *     World + Manage Space; same footer.
 *
 * World routes never mount this component (`_world.tsx` renders `WorldSidebar`
 * instead), so a Space id in the URL here always means space-home.
 */
function AppSidebar() {
  const { t } = useTranslation(["common", "space", "world"]);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Space-home: pathname is `/space/{id}` (optionally with a trailing slash).
  const spaceHomeMatch = pathname.match(/^\/space\/([^/]+)\/?$/);
  const spaceId = spaceHomeMatch?.[1] ?? null;

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <img src={appIcon} alt="sluver" className="size-6 rounded-sm" />
        <Link
          to="/"
          className="font-heading text-[15px] font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          sluver
        </Link>
      </div>

      {spaceId ? (
        <SpaceHomeContent spaceId={spaceId} />
      ) : (
        <LandingContent pathname={pathname} t={t} />
      )}

      <SidebarFooter />
    </aside>
  );
}

export { AppSidebar };

// ─────────────────────────────────────────────────────────────────────────────
// Landing mode
// ─────────────────────────────────────────────────────────────────────────────

function LandingContent({
  pathname,
  t,
}: {
  pathname: string;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const items = [
    {
      label: t("common:nav.library"),
      to: "/library" as const,
      icon: BookOpen02Icon,
      isActive: (p: string) => p === "/library",
    },
  ];

  return (
    <nav
      className="flex flex-col gap-1 px-3 py-2"
      aria-label={t("common:nav.primaryNav")}
    >
      {items.map((item) => {
        const active = item.isActive(pathname);
        return (
          <Link
            key={item.to}
            to={item.to}
            aria-current={active ? "page" : undefined}
            className={cn(
              "group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              active
                ? "bg-sidebar-accent font-medium text-sidebar-foreground"
                : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
            )}
          >
            {active && (
              <span
                aria-hidden
                className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-sidebar-primary"
              />
            )}
            <HugeiconsIcon
              icon={item.icon}
              strokeWidth={2}
              className={cn("size-[18px]", active && "text-sidebar-primary")}
            />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Space-home mode
// ─────────────────────────────────────────────────────────────────────────────

function SpaceHomeContent({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation(["common", "space", "world"]);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const worldsQ = useWorlds(spaceId);
  const createWorld = useCreateWorld(spaceId);
  const [createOpen, setCreateOpen] = useState(false);

  const worlds = worldsQ.data ?? [];

  async function handleCreate(input: CreateWorldInput) {
    try {
      await createWorld.mutateAsync(input);
      toast.success(i18n.t("world:toast.createSuccess"));
    } catch (err) {
      toast.error(i18n.t("world:toast.createFailed"), {
        description: translateError(toErrorPayload(err)),
      });
      throw err;
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1 px-3 py-2" aria-label={t("common:nav.worlds")}>
        <div className="flex items-center justify-between px-2 pb-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
            {t("common:nav.worlds")}
          </p>
          <button
            type="button"
            aria-label={t("space:home.createWorld")}
            onClick={() => setCreateOpen(true)}
            className={cn(
              "flex size-5 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors",
              "hover:bg-sidebar-accent hover:text-sidebar-foreground",
              "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            )}
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-3.5" />
          </button>
        </div>

        {worldsQ.isLoading ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {t("common:loading")}
          </p>
        ) : worlds.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground/70">
            {t("space:home.emptyWorlds.title")}
          </p>
        ) : (
          <nav className="flex flex-col gap-0.5" aria-label={t("common:nav.worlds")}>
            {worlds.map((world) => {
              const segment = `/space/${spaceId}/world/${world.id}`;
              const active =
                pathname === segment || pathname.startsWith(segment + "/");
              return (
                <Link
                  key={world.id}
                  to="/space/$spaceId/world/$worldId"
                  params={{ spaceId, worldId: world.id }}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm outline-none transition-colors",
                    "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                    active
                      ? "bg-sidebar-accent font-medium text-sidebar-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                  )}
                >
                  {active && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-sidebar-primary"
                    />
                  )}
                  <HugeiconsIcon
                    icon={Globe02Icon}
                    strokeWidth={2}
                    className={cn(
                      "size-4 shrink-0",
                      active ? "text-sidebar-primary" : "text-muted-foreground",
                    )}
                  />
                  <span className="truncate">{world.name}</span>
                </Link>
              );
            })}
          </nav>
        )}
      </div>

      <ManageSpaceEntry spaceId={spaceId} />

      <CreateWorldDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={handleCreate}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Manage Space entry (password / delete)
// ─────────────────────────────────────────────────────────────────────────────

function ManageSpaceEntry({ spaceId }: { spaceId: string }) {
  const { t } = useTranslation(["common", "space"]);
  const spacesQ = useSpaces();
  const space: SpaceSummary | undefined = spacesQ.data?.find(
    (s) => s.id === spaceId,
  );

  const [pwOpen, setPwOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // The Space summary may briefly be unavailable while the spaces list loads.
  // Render a disabled affordance rather than nothing, so the entry is stable.
  const ready = space !== undefined;

  return (
    <div className="mt-1 px-3 pb-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              disabled={!ready}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm outline-none transition-colors",
                "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                !ready && "opacity-50",
              )}
            />
          }
        >
          <HugeiconsIcon
            icon={LockKeyIcon}
            strokeWidth={2}
            className="size-[18px]"
          />
          <span className="flex-1 text-left">
            {t("space:home.manageSpace")}
          </span>
          <HugeiconsIcon
            icon={MoreHorizontalIcon}
            strokeWidth={2}
            className="size-4 text-muted-foreground/70"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4}>
          <DropdownMenuItem onClick={() => setPwOpen(true)}>
            <HugeiconsIcon icon={LockKeyIcon} strokeWidth={2} />
            {t("space:home.managePassword")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            {t("space:home.deleteSpace")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {ready && (
        <>
          <SpacePasswordDialog
            open={pwOpen}
            onOpenChange={setPwOpen}
            space={space}
          />
          <DeleteSpaceDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            space={space}
          />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared footer: Space picker + Settings + version
// ─────────────────────────────────────────────────────────────────────────────

function SidebarFooter() {
  const { t } = useTranslation("common");
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const settingsActive = pathname === "/settings";

  return (
    <div className="mt-auto">
      <div className="px-3 pb-1.5">
        <SpacePicker />
      </div>
      <div className="px-3 pb-2">
        <Link
          to="/settings"
          aria-current={settingsActive ? "page" : undefined}
          className={cn(
            "group relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm outline-none transition-colors",
            "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
            settingsActive
              ? "bg-sidebar-accent font-medium text-sidebar-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
          )}
        >
          {settingsActive && (
            <span
              aria-hidden
              className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r-full bg-sidebar-primary"
            />
          )}
          <HugeiconsIcon
            icon={Settings02Icon}
            strokeWidth={2}
            className={cn(
              "size-[18px]",
              settingsActive && "text-sidebar-primary",
            )}
          />
          <span>{t("nav.settings")}</span>
        </Link>
      </div>
      <div className="px-5 py-3">
        <p className="text-[11px] tracking-wide text-muted-foreground/70">
          {t("nav.version", { version: "0.1.0" })}
        </p>
      </div>
    </div>
  );
}
