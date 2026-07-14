import { createRoute, redirect } from "@tanstack/react-router";
import { worldLayoutRoute } from "./_world";

export const worldIndexRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "/",
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/world/$worldId/locations", params });
  },
});
