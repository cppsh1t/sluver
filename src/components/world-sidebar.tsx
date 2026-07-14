import { Link, useNavigate, useRouterState, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft02Icon,
  Book02Icon,
  BookOpen02Icon,
  MapPinIcon,
  Package02Icon,
  Calendar03Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";

import { cn } from "@/lib/utils";
import { useWorld } from "@/hooks";
import type { WorldId } from "@/types";

function WorldSidebar() {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { worldId } = useParams({ from: "/world/$worldId" });
  const { data: world } = useWorld(worldId as WorldId);

  const sections = [
    {
      label: t("nav.worldbook"),
      items: [
        {
          label: t("nav.worldbook.characters"),
          to: "/world/$worldId/characters" as const,
          icon: UserMultiple02Icon,
          match: "/world/$worldId/characters",
        },
        {
          label: t("nav.worldbook.events"),
          to: "/world/$worldId/events" as const,
          icon: Calendar03Icon,
          match: "/world/$worldId/events",
        },
        {
          label: t("nav.worldbook.locations"),
          to: "/world/$worldId/locations" as const,
          icon: MapPinIcon,
          match: "/world/$worldId/locations",
        },
        {
          label: t("nav.worldbook.items"),
          to: "/world/$worldId/items" as const,
          icon: Package02Icon,
          match: "/world/$worldId/items",
        },
        {
          label: t("nav.worldbook.lore"),
          to: "/world/$worldId/lore" as const,
          icon: BookOpen02Icon,
          match: "/world/$worldId/lore",
        },
      ],
    },
    {
      label: t("nav.writing"),
      items: [
        {
          label: t("nav.writing.novels"),
          to: "/world/$worldId/novels" as const,
          icon: Book02Icon,
          match: "/world/$worldId/novels",
        },
      ],
    },
  ];

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-3 py-3">
        <button
          type="button"
          onClick={() => navigate({ to: "/" })}
          className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <HugeiconsIcon
            icon={ArrowLeft02Icon}
            strokeWidth={2}
            className="size-[18px] text-muted-foreground"
          />
          <span className="text-muted-foreground">{t("nav.backToWorlds")}</span>
        </button>
      </div>

      {world && (
        <div className="px-5 pb-3">
          <span className="truncate text-sm font-medium">{world.name}</span>
        </div>
      )}

      {sections.map((section) => (
        <div key={section.label} className="px-3 pb-2">
          <p className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
            {section.label}
          </p>
          <nav className="flex flex-col gap-1" aria-label={section.label}>
            {section.items.map((item) => {
              const active = pathname ===
                item.to.replace("$worldId", worldId);
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  params={{ worldId }}
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
                    className={cn(
                      "size-[18px]",
                      active && "text-sidebar-primary",
                    )}
                  />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      ))}
    </aside>
  );
}

export { WorldSidebar };
