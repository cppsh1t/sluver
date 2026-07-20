import {
  Link,
  useRouterState,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BookOpen02Icon,
  Globe02Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";

import appIcon from "@/assets/app-icon.png";
import { cn } from "@/lib/utils";
import { SpacePicker } from "@/components/space-picker";

/**
 * Context-sensitive application sidebar (ADR-0009, amended).
 *
 * Mounted in two places:
 *   - `_app.tsx` (landing / global settings) → **landing mode**: brand only
 *     (no primary nav); footer hosts the Space picker + global Settings.
 *   - space-tier pages (`index.tsx` = 世界, `config.tsx` = 配置,
 *     `library.tsx` = 资料库) → **space mode**: brand + a three-item Space
 *     nav; same footer.
 *
 * World routes never mount this component — `_world.tsx` renders
 * `WorldSidebar` instead — so the spaceId regex only needs to match the
 * three non-world Space destinations (`/space/{id}` + `/config` + `/library`).
 *
 * The Space management affordances (rename / password / delete) previously
 * lived here as a "Manage Space" dropdown; they have moved into the 配置
 * page's content area, leaving the sidebar as pure navigation.
 */
function AppSidebar() {
  const { t } = useTranslation(["common", "space", "world"]);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Match `/space/{id}`, `/space/{id}/config`, `/space/{id}/library` — but
  // NOT `/space/{id}/world/...` (those render WorldSidebar, not this).
  const spaceMatch = pathname.match(
    /^\/space\/([^/]+)(?:\/(config|library))?\/?$/,
  );
  const spaceId = spaceMatch?.[1] ?? null;

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
        <SpaceNavContent spaceId={spaceId} pathname={pathname} t={t} />
      ) : null}

      <SidebarFooter />
    </aside>
  );
}

export { AppSidebar };

// ─────────────────────────────────────────────────────────────────────────────
// Space mode — three-item primary nav (世界 / 配置 / 资料库)
// ─────────────────────────────────────────────────────────────────────────────

function SpaceNavContent({
  spaceId,
  pathname,
  t,
}: {
  spaceId: string;
  pathname: string;
  t: ReturnType<typeof useTranslation>["t"];
}) {
  const root = `/space/${spaceId}`;
  const items = [
    {
      label: t("common:nav.worlds"),
      to: "/space/$spaceId" as const,
      icon: Globe02Icon,
      active: pathname === root || pathname === `${root}/`,
    },
    {
      label: t("common:nav.config"),
      to: "/space/$spaceId/config" as const,
      icon: Settings02Icon,
      active: pathname === `${root}/config`,
    },
    {
      label: t("common:nav.library"),
      to: "/space/$spaceId/library" as const,
      icon: BookOpen02Icon,
      active: pathname === `${root}/library`,
    },
  ];

  return (
    <nav
      className="flex flex-col gap-1 px-3 py-2"
      aria-label={t("common:nav.primaryNav")}
    >
      {items.map((item) => {
        const active = item.active;
        return (
          <Link
            key={item.to}
            to={item.to}
            params={{ spaceId }}
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
// Shared footer: Space picker + global Settings + version
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
