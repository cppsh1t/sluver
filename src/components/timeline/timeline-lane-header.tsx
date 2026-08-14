import { useTranslation } from "react-i18next";

import { EntityAvatar } from "@/components/ui/entity-avatar";
import { HugeiconsIcon } from "@hugeicons/react";
import { UserMultiple02Icon } from "@hugeicons/core-free-icons";
import type { Character, SpaceId, TimelineLane, WorldId } from "@/types";

interface TimelineLaneHeaderProps {
  lane: TimelineLane;
  /** Full Character record for the avatar + descriptor. May be undefined if
   *  the character was deleted after the lane list was cached. */
  character: Character | undefined;
  spaceId: string;
  worldId: WorldId;
}

/**
 * Compact character card that lives in the swimlane grid's sticky-left label
 * column — avatar + name + a one-line descriptor + participation count.
 *
 * Deliberately NOT the full `CharacterCard` (which carries a delete menu, a
 * phase stepper, and a w-36 portrait — far too heavy for a sticky gutter).
 * Designed to stay opaque (`bg-background`) so scrolling entry cards pass
 * underneath cleanly.
 */
function TimelineLaneHeader({
  lane,
  character,
  spaceId,
  worldId,
}: TimelineLaneHeaderProps) {
  const { t } = useTranslation("timeline");

  // Aliases read as identity nicknames (concise); fall back to a one-line
  // description snippet when there are none.
  const descriptor =
    character && character.aliases.length > 0
      ? character.aliases.join(", ")
      : (character?.description.trim() ?? "");

  return (
    <div className="flex h-full items-center gap-2 px-2 py-1.5">
      <EntityAvatar
        kind="character"
        spaceId={spaceId as SpaceId}
        worldId={worldId}
        id={character?.id}
        alt={lane.name}
        aspect={1}
        fallbackIcon={
          <HugeiconsIcon
            icon={UserMultiple02Icon}
            strokeWidth={2}
            className="size-5 text-muted-foreground"
          />
        }
        className="size-10 shrink-0 rounded-md"
      />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="min-w-0 truncate text-xs font-medium" title={lane.name}>
          {lane.name}
        </span>
        {descriptor && (
          <span className="min-w-0 truncate text-[0.6875rem] text-muted-foreground">
            {descriptor}
          </span>
        )}
      </div>
      <span
        className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[0.625rem] font-medium text-muted-foreground"
        title={t("lane.participationCount", { count: lane.participationCount })}
      >
        {lane.participationCount}
      </span>
    </div>
  );
}

export { TimelineLaneHeader };
export type { TimelineLaneHeaderProps };
