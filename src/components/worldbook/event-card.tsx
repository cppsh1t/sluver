import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Calendar03Icon,
  Delete02Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { formatRelativeTime } from "@/lib/format";
import type { Event, WorldId } from "@/types";

/** Compact, locale-neutral datetime for card metadata rows. */
function formatDateTime(iso: string): string {
  return dayjs(iso).format("YYYY-MM-DD HH:mm");
}

interface EventCardProps {
  event: Event;
  worldId: WorldId;
  locationName: string | null;
  onDelete: () => void;
}

function EventCard({ event, worldId, locationName, onDelete }: EventCardProps) {
  const { t } = useTranslation(["event", "common"]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const entityName = t("event:entityName.singular");

  const visibleTags = event.tags.slice(0, 3);
  const extraCount = event.tags.length - 3;
  const participantCount = event.characterRefs.length;

  const participantsText =
    participantCount > 0
      ? t("event:card.participantsCount", { count: participantCount })
      : t("event:card.noParticipants");

  const locationText = locationName ?? t("event:card.noLocation");

  let timeText: string;
  if (event.startAt && event.endAt) {
    timeText = t("event:card.timeRange", {
      start: formatDateTime(event.startAt),
      end: formatDateTime(event.endAt),
    });
  } else if (event.startAt) {
    timeText = formatDateTime(event.startAt);
  } else if (event.endAt) {
    timeText = formatDateTime(event.endAt);
  } else {
    timeText = t("event:card.noTime");
  }

  return (
    <>
      <Link
        to={"/world/$worldId/events/$eventId" as const}
        params={{ worldId, eventId: event.id }}
        className="block h-full"
      >
        <Card className="h-full">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HugeiconsIcon
                icon={Calendar03Icon}
                strokeWidth={2}
                className="text-muted-foreground"
              />
              <span className="truncate">{event.name}</span>
            </CardTitle>
            <CardAction>
              <DropdownMenu>
                <DropdownMenuTrigger
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  render={<Button variant="ghost" size="icon-sm" />}
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                  <span className="sr-only">{t("common:actions.moreActions")}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setConfirmOpen(true);
                    }}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    {t("event:card.deleteAction")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              {participantsText} · {locationText} · {timeText}
            </p>
            <p className="line-clamp-2 min-h-8 flex-1 text-sm text-muted-foreground">
              {event.description}
            </p>
            {event.tags.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {visibleTags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
                {extraCount > 0 && (
                  <span className="px-1.5 py-0.5 text-xs text-muted-foreground/70">
                    +{extraCount}
                  </span>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground/70">
              {formatRelativeTime(event.updatedAt)}
            </p>
          </CardContent>
        </Card>
      </Link>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("event:card.deleteTitle", { entity: entityName })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("event:card.deleteDescription", { name: event.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onDelete();
              }}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export { EventCard };
