import { useTranslation } from "react-i18next"
import { HugeiconsIcon } from "@hugeicons/react"
import { Cancel01Icon, UserMultiple02Icon } from "@hugeicons/core-free-icons"

import { Card, CardContent } from "@/components/ui/card"

interface ParticipantCardProps {
  characterName: string
  characterAliases: string[]
  phaseName: string
  phaseAppearance: string
  phaseChanges: string
  onRemove?: () => void
}

function ParticipantCard({
  characterName,
  characterAliases,
  phaseName,
  phaseAppearance,
  phaseChanges,
  onRemove,
}: ParticipantCardProps) {
  const { t } = useTranslation(["event", "common"])
  return (
    <Card className="relative">
      <CardContent className="flex flex-col gap-1 pt-4">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <HugeiconsIcon icon={UserMultiple02Icon} strokeWidth={2} />
          <span className="truncate">{characterName}</span>
          {characterAliases.length > 0 ? (
            <span className="text-muted-foreground/60">
              · {characterAliases.join(", ")}
            </span>
          ) : null}
        </div>

        <p className="font-medium text-sm">{phaseName}</p>
        <p className="line-clamp-2 text-sm text-muted-foreground">
          {phaseAppearance}
        </p>
        {phaseChanges ? (
          <p className="line-clamp-2 text-xs text-muted-foreground/70">
            {phaseChanges}
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
