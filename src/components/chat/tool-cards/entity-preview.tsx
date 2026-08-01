/**
 * Compact, read-only entity preview — mirrors the visual vocabulary of the
 * canonical CRUD cards in `src/components/worldbook/entity-card.tsx`.
 *
 * Intentionally NOT wrapped in a full `<Card>`: this lives INSIDE a tool-card
 * body, so a second bordered container would double up the chrome. Uses the
 * same icon + headline + description + tag-chip patterns as the CRUD cards so
 * the AI tool surface reads as part of the same design system.
 */

import { HugeiconsIcon } from "@hugeicons/react";

import { cn } from "@/lib/utils";
import type { EntityType } from "../tool-summary";
import { ENTITY_ICONS } from "./entity-icons";

interface EntityPreviewProps {
  readonly entityType: EntityType;
  readonly headline?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  /** Optional className for layout overrides by the parent. */
  readonly className?: string;
}

export function EntityPreview({
  entityType,
  headline,
  description,
  tags,
  className,
}: EntityPreviewProps) {
  const Icon = ENTITY_ICONS[entityType];
  const visibleTags = tags?.slice(0, 3) ?? [];
  const extraCount = Math.max(0, (tags?.length ?? 0) - visibleTags.length);

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <div className="flex items-center gap-1.5">
        <HugeiconsIcon
          icon={Icon}
          strokeWidth={2}
          className="size-4 shrink-0 text-muted-foreground"
        />
        {headline ? (
          <span className="truncate text-sm font-medium">{headline}</span>
        ) : (
          <span className="truncate text-sm font-medium text-muted-foreground/60">—</span>
        )}
      </div>
      {description && (
        <p className="line-clamp-2 text-xs text-muted-foreground">{description}</p>
      )}
      {visibleTags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {visibleTags.map((tag) => (
            <span
              key={tag}
              className="rounded bg-muted px-1.5 py-0.5 text-[0.625rem] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
          {extraCount > 0 && (
            <span className="px-1.5 py-0.5 text-[0.625rem] text-muted-foreground/70">
              +{extraCount}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
