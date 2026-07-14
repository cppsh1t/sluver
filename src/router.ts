import { createRouter } from "@tanstack/react-router";

import { rootRoute } from "./routes/__root";
import { appLayoutRoute } from "./routes/_app";
import { indexRoute } from "./routes/index";
import { settingsRoute } from "./routes/settings";
import { libraryRoute } from "./routes/library";
import { worldLayoutRoute } from "./routes/world.$worldId/_world";
import { worldIndexRoute } from "./routes/world.$worldId/index";
import { charactersRoute } from "./routes/world.$worldId/characters";
import { eventsRoute } from "./routes/world.$worldId/events";
import { locationsRoute } from "./routes/world.$worldId/locations";
import { itemsRoute } from "./routes/world.$worldId/items";
import { loreRoute } from "./routes/world.$worldId/lore";
import { novelsRoute } from "./routes/world.$worldId/novels";

const routeTree = rootRoute.addChildren([
  appLayoutRoute.addChildren([indexRoute, settingsRoute, libraryRoute]),
  worldLayoutRoute.addChildren([
    worldIndexRoute,
    charactersRoute,
    eventsRoute,
    locationsRoute,
    itemsRoute,
    loreRoute,
    novelsRoute,
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
