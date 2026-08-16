import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { Scene, SceneId } from "@/types";

interface SceneOutlineSidebarProps {
  scenes: Scene[];
  activeSceneId: SceneId | null;
  onSelect: (sceneId: SceneId) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/**
 * Read-mode scene outline for the chapter workspace. Purely presentational:
 * renders the scene titles of the current chapter and reports clicks upward.
 * The route owns scrolling, anchor ids, and active-scene tracking.
 */
function SceneOutlineSidebar({
  scenes,
  activeSceneId,
  onSelect,
  collapsed,
  onToggleCollapsed,
}: SceneOutlineSidebarProps) {
  const { t } = useTranslation(["novel", "common"]);

  if (collapsed) {
    return (
      <div className="flex w-10 shrink-0 flex-col items-center border-r bg-background py-3">
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="text-xs text-muted-foreground [writing-mode:vertical-lr] hover:text-foreground"
        >
          {t("novel:scene.outline.title")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex w-56 shrink-0 flex-col border-r bg-background">
      {/* Collapse button */}
      <div className="flex justify-end border-b px-3 py-1.5">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-label={t("novel:scene.outline.title")}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          «
        </button>
      </div>

      {/* Header label */}
      <div className="border-b px-3 py-2">
        <p className="text-xs font-medium text-muted-foreground">
          {t("novel:scene.outline.title")}
        </p>
      </div>

      {/* Scene titles in reading order */}
      <nav
        className="flex-1 overflow-y-auto p-2"
        aria-label={t("novel:scene.outline.title")}
      >
        {scenes.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">
            {t("novel:scene.outline.empty")}
          </p>
        ) : (
          <ol className="flex flex-col gap-1">
            {scenes.map((scene, i) => {
              const label =
                scene.title.trim() ||
                t("novel:scene.defaultTitle", { n: i + 1 });
              const isActive = scene.id === activeSceneId;
              return (
                <li key={scene.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(scene.id)}
                    aria-current={isActive ? "true" : undefined}
                    title={label}
                    className={cn(
                      "w-full truncate rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors",
                      isActive
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/50",
                    )}
                  >
                    {label}
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </nav>
    </div>
  );
}

export { SceneOutlineSidebar };
export type { SceneOutlineSidebarProps };
