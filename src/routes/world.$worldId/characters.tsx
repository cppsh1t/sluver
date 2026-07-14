import { createRoute } from "@tanstack/react-router";
import { worldLayoutRoute } from "./_world";

function CharactersPage() {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
      Characters — coming soon
    </div>
  );
}

export const charactersRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "characters",
  component: CharactersPage,
});
