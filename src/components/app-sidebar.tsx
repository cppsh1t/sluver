import { Link, useRouterState } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BookOpen02Icon,
  Globe02Icon,
  Settings02Icon,
} from "@hugeicons/core-free-icons";

import appIcon from "@/assets/app-icon.png";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  to: string;
  icon: typeof Globe02Icon;
  isActive: (pathname: string) => boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    label: "世界",
    to: "/",
    icon: Globe02Icon,
    isActive: (p) => p === "/" || p.startsWith("/world"),
  },
  {
    label: "配置",
    to: "/settings",
    icon: Settings02Icon,
    isActive: (p) => p === "/settings",
  },
  {
    label: "资料库",
    to: "/library",
    icon: BookOpen02Icon,
    isActive: (p) => p === "/library",
  },
];

function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex h-14 items-center gap-2.5 px-5">
        <img src={appIcon} alt="sluver" className="size-6 rounded-sm" />
        <span className="font-heading text-[15px] font-semibold tracking-tight">
          sluver
        </span>
      </div>

      <nav className="flex flex-col gap-1 px-3 py-2" aria-label="主导航">
        {NAV_ITEMS.map((item) => {
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

      <div className="mt-auto px-5 py-4">
        <p className="text-[11px] tracking-wide text-muted-foreground/70">
          v0.1.0 · 预览版
        </p>
      </div>
    </aside>
  );
}

export { AppSidebar };
