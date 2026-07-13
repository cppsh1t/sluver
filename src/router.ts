import { createRouter } from "@tanstack/react-router";

import { rootRoute } from "./routes/__root";
import { indexRoute } from "./routes/index";
import { worldRoute } from "./routes/world.$worldId";
import { settingsRoute } from "./routes/settings";
import { libraryRoute } from "./routes/library";

const routeTree = rootRoute.addChildren([
  indexRoute,
  worldRoute,
  settingsRoute,
  libraryRoute,
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
