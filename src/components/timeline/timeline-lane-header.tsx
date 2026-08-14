import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { EntityAvatar } from "@/components/ui/entity-avatar";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowRight01Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
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
 * When the Character record exists, the compact layout is wrapped in a
 * Popover whose content shows richer detail (aliases, description,
 * participation, and a "View character" link). When the character was
 * deleted (`character === undefined`), the old static layout is rendered
 * with NO popover — there is nothing to show.
 *
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
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const descriptor =
    character && character.aliases.length > 0
      ? character.aliases.join(", ")
      : (character?.description.trim() ?? "");

  const compactInner = (
    <CompactLaneHeaderLayout
      lane={lane}
      character={character}
      spaceId={spaceId}
      worldId={worldId}
      descriptor={descriptor}
      participationLabel={t("lane.participationCount", {
        count: lane.participationCount,
      })}
    />
  );

  // Deleted character — nothing to show in a popover; render the static layout.
  if (!character) {
    return <div className="flex h-full items-center">{compactInner}</div>;
  }

  function handleViewCharacter() {
    setOpen(false);
    navigate({
      to: "/space/$spaceId/world/$worldId/characters/$characterId",
      params: {
        spaceId,
        worldId,
        characterId: lane.characterId,
      },
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex h-full w-full items-center rounded-sm text-left outline-none transition-colors",
              "hover:bg-accent/40",
              "focus-visible:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/30",
            )}
          />
        }
      >
        {compactInner}
      </PopoverTrigger>

      <PopoverContent align="start" side="right" sideOffset={8} className="w-72 p-0">
        <div className="flex flex-col gap-2 p-3">
          {/* Header row: larger avatar + name + chevron hint */}
          <div className="flex items-center gap-2">
            <EntityAvatar
              kind="character"
              spaceId={spaceId as SpaceId}
              worldId={worldId}
              id={character.id}
              alt={lane.name}
              aspect={1}
              fallbackIcon={
                <HugeiconsIcon
                  icon={UserMultiple02Icon}
                  strokeWidth={2}
                  className="size-6 text-muted-foreground"
                />
              }
              className="size-12 shrink-0 rounded-md"
            />
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="min-w-0 truncate text-sm font-semibold">
                {lane.name}
              </span>
              <span className="flex items-center gap-0.5 text-[0.6875rem] text-muted-foreground/70">
                {t("lane.viewCharacter")}
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  strokeWidth={2}
                  className="size-3"
                />
              </span>
            </div>
          </div>

          {/* Aliases */}
          {character.aliases.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[0.6875rem] font-medium text-muted-foreground">
                {t("lane.aliasLabel")}
              </span>
              <div className="flex flex-wrap gap-1">
                {character.aliases.map((alias) => (
                  <span
                    key={alias}
                    className="rounded bg-muted px-1.5 py-0.5 text-[0.6875rem]"
                  >
                    {alias}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Description */}
          {character.description.trim() && (
            <p className="line-clamp-4 text-xs text-muted-foreground">
              {character.description.trim()}
            </p>
          )}

          {/* Participation line */}
          <p className="text-[0.6875rem] text-muted-foreground">
            {t("lane.appearsIn", { count: lane.participationCount })}
          </p>

          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleViewCharacter}
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              data-icon="inline-end"
            />
            {t("lane.viewCharacter")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The shared compact inner layout — avatar + name + descriptor + count badge.
 * Used both by the static (deleted-character) branch and the Popover trigger.
 */
function CompactLaneHeaderLayout({
  lane,
  character,
  spaceId,
  worldId,
  descriptor,
  participationLabel,
}: {
  lane: TimelineLane;
  character: Character | undefined;
  spaceId: string;
  worldId: WorldId;
  descriptor: string;
  participationLabel: string;
}) {
  return (
    <div className="flex h-full w-full items-center gap-2 px-2 py-1.5">
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
        title={participationLabel}
      >
        {lane.participationCount}
      </span>
    </div>
  );
}

export { TimelineLaneHeader };
export type { TimelineLaneHeaderProps };
