import { createRoute } from "@tanstack/react-router";
import { worldLayoutRoute } from "./_world";

function EventsPage() {
  return (
    <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
      Events — coming soon
    </div>
  );
}

export const eventsRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "events",
  component: EventsPage,
});
