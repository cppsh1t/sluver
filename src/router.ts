import { createRouter } from "@tanstack/react-router";

import { rootRoute } from "./routes/__root";
import { indexRoute } from "./routes/index";
import { worldRoute } from "./routes/world.$worldId";

const routeTree = rootRoute.addChildren([indexRoute, worldRoute]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
