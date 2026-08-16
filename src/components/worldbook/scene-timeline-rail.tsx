import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { Scene, SceneId } from "@/types";

interface SceneTimelineRailProps {
  scenes: Scene[];
  activeSceneId: SceneId | null;
  onSelect: (sceneId: SceneId) => void;
}

/**
 * Pick the row gap so long chapters never overflow the viewport:
 * comfortable spacing normally, compressed only past 24 scenes.
 */
function gapFor(count: number): number {
  return count <= 24 ? 12 : 6;
}

/**
 * Floating vertical timeline rail for read-mode scene navigation — one
 * row per scene in reading order, dot + always-visible title. Purely
 * presentational: clicks report upward. Takes no layout space; assumes
 * the route's center column provides the positioning context
 * (position: relative).
 */
function SceneTimelineRail({
  scenes,
  activeSceneId,
  onSelect,
}: SceneTimelineRailProps) {
  const { t } = useTranslation(["novel", "common"]);

  return (
    <div
      role="navigation"
      aria-label={t("novel:scene.outline.title")}
      className="absolute left-3 top-1/2 z-10 w-44 -translate-y-1/2"
    >
      <div
        className="relative flex flex-col"
        style={{ gap: gapFor(scenes.length) }}
      >
        {/* Connector line behind the dots (px-1 + size-2.5 → dot center at 9px) */}
        <div
          aria-hidden
          className="absolute inset-y-1 left-[9px] w-px -translate-x-1/2 bg-border"
        />

        {scenes.map((scene, i) => {
          const label =
            scene.title.trim() || t("novel:scene.defaultTitle", { n: i + 1 });
          const isActive = scene.id === activeSceneId;
          return (
            <button
              key={scene.id}
              type="button"
              onClick={() => onSelect(scene.id)}
              aria-current={isActive ? "true" : undefined}
              title={label}
              className={cn(
                "relative flex items-center gap-2.5 rounded-md px-1 py-0.5 text-left outline-none transition-colors hover:bg-accent/50",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-2.5 shrink-0 rounded-full border transition-colors",
                  isActive
                    ? "border-primary bg-primary"
                    : "border-border bg-background",
                )}
              />
              <span
                className={cn("truncate text-xs", isActive && "font-medium")}
              >
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { SceneTimelineRail };
export type { SceneTimelineRailProps };
