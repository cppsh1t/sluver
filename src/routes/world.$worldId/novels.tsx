import { createRoute } from "@tanstack/react-router";
import { worldLayoutRoute } from "./_world";

function NovelsPage() {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
      Novels — coming soon
    </div>
  );
}

export const novelsRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "novels",
  component: NovelsPage,
});
