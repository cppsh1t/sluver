import { createRouter } from "@tanstack/react-router";

import { rootRoute } from "./routes/__root";
import { appLayoutRoute } from "./routes/_app";
import { indexRoute } from "./routes/index";
import { settingsRoute } from "./routes/settings";
import { libraryRoute } from "./routes/library";
import { worldLayoutRoute } from "./routes/world.$worldId/_world";
import { worldIndexRoute } from "./routes/world.$worldId/index";
import { charactersRoute } from "./routes/world.$worldId/characters";
import { characterDetailRoute } from "./routes/world.$worldId/characters.$characterId";
import { eventsRoute } from "./routes/world.$worldId/events";
import { eventDetailRoute } from "./routes/world.$worldId/events.$eventId";
import { locationsRoute } from "./routes/world.$worldId/locations";
import { itemsRoute } from "./routes/world.$worldId/items";
import { loreRoute } from "./routes/world.$worldId/lore";
import { novelsRoute } from "./routes/world.$worldId/novels";
import { novelWorkspaceRoute } from "./routes/world.$worldId/novels.$novelId";
import { novelIndexRoute } from "./routes/world.$worldId/novels.$novelId/index";
import { chapterWorkspaceRoute } from "./routes/world.$worldId/novels.$novelId/chapters.$chapterId";

const routeTree = rootRoute.addChildren([
  appLayoutRoute.addChildren([indexRoute, settingsRoute, libraryRoute]),
  worldLayoutRoute.addChildren([
    worldIndexRoute,
    charactersRoute,
    characterDetailRoute,
    eventsRoute,
    eventDetailRoute,
    locationsRoute,
    itemsRoute,
    loreRoute,
    novelsRoute,
    novelWorkspaceRoute.addChildren([novelIndexRoute, chapterWorkspaceRoute]),
  ]),
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
