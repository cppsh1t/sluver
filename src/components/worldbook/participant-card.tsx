import { useTranslation } from "react-i18next"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon, UserMultiple02Icon } from "@hugeicons/core-free-icons"

import { Card, CardContent } from "@/components/ui/card"
import { EntityAvatar } from "@/components/ui/entity-avatar"
import { cn } from "@/lib/utils"
import type { CharacterId, SpaceId, WorldId } from "@/types"

interface ParticipantCardProps {
  characterName: string
  characterAliases: string[]
  phaseName: string
  phaseAppearance: string
  phaseDescription: string
  /**
   * Optional avatar trio (compact variant only). When all three are
   * provided, the compact row renders the character's cover image; when any
   * is missing, it falls back to a muted icon placeholder. The full variant
   * ignores these and always renders the vertical layout.
   */
  spaceId?: string
  worldId?: WorldId
  characterId?: CharacterId
  onRemove?: () => void
  /**
   * Layout variant. `"full"` (default) = vertical Card with all phase
   * fields. `"compact"` = single-row card mirroring EntityCard's compact
   * row (avatar + name + phase only), for dense ref lists.
   */
  variant?: "full" | "compact"
}

function ParticipantCard({
  characterName,
  characterAliases,
  phaseName,
  phaseAppearance,
  phaseDescription,
  spaceId,
  worldId,
  characterId,
  onRemove,
  variant = "full",
}: ParticipantCardProps) {
  const { t } = useTranslation(["event", "common"])

  // Compact variant: single-row card (EntityCard compact-row pattern). Only
  // name + phaseName are shown; the avatar uses the character cover when the
  // id trio is available, otherwise a muted icon placeholder keeps rows
  // uniform. `pr-8` keeps text clear of the absolute remove button.
  if (variant === "compact") {
    return (
      <div
        className={cn(
          "relative flex items-center gap-2 rounded-md border px-3 py-2",
          onRemove && "pr-8",
        )}
      >
        {spaceId !== undefined && worldId !== undefined && characterId !== undefined ? (
          <EntityAvatar
            kind="character"
            spaceId={spaceId as SpaceId}
            worldId={worldId}
            id={characterId}
            aspect={1}
            alt={characterName}
            fallbackIcon={
              <HugeiconsIcon
                icon={UserMultiple02Icon}
                strokeWidth={2}
                className="size-4 text-muted-foreground"
              />
            }
            className="size-10 shrink-0 rounded-md"
          />
        ) : (
          <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted">
            <HugeiconsIcon
              icon={UserMultiple02Icon}
              strokeWidth={2}
              className="size-4 text-muted-foreground"
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{characterName}</p>
          <p className="truncate text-xs text-muted-foreground">{phaseName}</p>
        </div>

        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={t("event:detail.participants.removeAriaLabel")}
            className="text-muted-foreground/60 hover:text-foreground absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
          </button>
        )}
      </div>
    )
  }

  return (
    <Card className="relative">
      <CardContent className="flex flex-col gap-1 pt-4">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <HugeiconsIcon icon={UserMultiple02Icon} strokeWidth={2} className="shrink-0" />
          <span className="min-w-0 truncate">{characterName}</span>
          {characterAliases.length > 0 ? (
            <span className="min-w-0 flex-1 truncate text-muted-foreground/60">
              · {characterAliases.join(", ")}
            </span>
          ) : null}
        </div>

        <p className="font-medium text-sm">{phaseName}</p>
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {phaseAppearance}
        </p>
        {phaseDescription ? (
          <p className="line-clamp-2 text-xs text-muted-foreground/70">
            {phaseDescription}
          </p>
        ) : null}
      </CardContent>

      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("event:detail.participants.removeAriaLabel")}
          className="text-muted-foreground/60 hover:text-foreground absolute top-2 right-2 inline-flex size-5 items-center justify-center rounded-sm outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/30"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
        </button>
      )}
    </Card>
  )
}

export { ParticipantCard }
export type { ParticipantCardProps }
