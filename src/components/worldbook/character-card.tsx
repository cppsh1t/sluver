import { Fragment, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Cancel01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
  Tick02Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { formatRelativeTime } from "@/lib/format";
import { countCharacterRefs, type RefCounts } from "@/api";
import { cn } from "@/lib/utils";
import type { CharacterId, WorldId } from "@/types";

// ─── Phase stepper ───────────────────────────────────────────────────────────

interface PhaseInfo {
  name: string;
  triggerEventName: string | null;
}

interface PhaseStepperProps {
  phases: PhaseInfo[];
}

function PhaseStepper({ phases }: PhaseStepperProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragState = useRef({ dragging: false, startX: 0, startScroll: 0, moved: false });
  const [overflow, setOverflow] = useState(false);

  // Track whether the content overflows (gates drag + cursor + wheel).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const check = () => setOverflow(el.scrollWidth > el.clientWidth);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phases]);

  // Mouse wheel → horizontal scroll (non-passive listener so we can preventDefault).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      const node = scrollRef.current;
      if (!node || !overflow || e.deltaY === 0) return;
      e.preventDefault();
      node.scrollLeft += e.deltaY;
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [overflow]);

  // Drag-to-scroll (document-level listeners for smooth tracking beyond the element bounds).
  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragState.current.dragging) return;
      e.preventDefault();
      const el = scrollRef.current;
      if (!el) return;
      el.scrollLeft = dragState.current.startScroll - (e.pageX - dragState.current.startX);
      dragState.current.moved = true;
    }
    function onMouseUp() {
      dragState.current.dragging = false;
    }
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    const el = scrollRef.current;
    if (!el || !overflow) return;
    dragState.current = { dragging: true, startX: e.pageX, startScroll: el.scrollLeft, moved: false };
  }

  // Suppress card click after a drag (moved !== click).
  function handleClick(e: React.MouseEvent) {
    if (dragState.current.moved) {
      dragState.current.moved = false;
      e.stopPropagation();
    }
  }

  return (
    <div
      ref={scrollRef}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      className={[
        "flex select-none items-center gap-1.5 overflow-x-auto",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        overflow ? "cursor-grab active:cursor-grabbing" : "",
      ].join(" ")}
    >
      {phases.map((phase, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="shrink-0 text-xs text-muted-foreground/40">→</span>}
          <span className="flex shrink-0 flex-col gap-0">
            <span className="whitespace-nowrap text-xs text-muted-foreground">{phase.name}</span>
            {phase.triggerEventName && (
              <span className="whitespace-nowrap text-[0.625rem] text-muted-foreground/60">
                ↓ {phase.triggerEventName}
              </span>
            )}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

// ─── Character card ──────────────────────────────────────────────────────────

interface CharacterCardProps {
  worldId: WorldId;
  characterId: CharacterId;
  name: string;
  aliases: string[];
  description: string;
  tags: string[];
  phases: PhaseInfo[];
  updatedAt: string;
  onClick?: () => void;
  onDelete?: () => void;
  selectable?: boolean;
  selected?: boolean;
  focused?: boolean;
  onSelect?: () => void;
  onFocus?: () => void;
  onRemove?: () => void;
}

function CharacterCard({
  worldId,
  characterId,
  name,
  aliases,
  description,
  tags,
  phases,
  updatedAt,
  onClick,
  onDelete,
  selectable,
  selected,
  focused,
  onSelect,
  onFocus,
  onRemove,
}: CharacterCardProps) {
  const { t } = useTranslation(["character", "common"]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disclosureCounts, setDisclosureCounts] = useState<RefCounts | null>(null);
  const [loadingCounts, setLoadingCounts] = useState(false);

  const visibleTags = tags.slice(0, 3);
  const extraCount = tags.length - 3;

  // ADR-0006: before deleting, count how many events/scenes reference this
  // character. If > 0, disclose the blast radius before the cascade.
  async function handleDeleteClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (loadingCounts) return;
    setLoadingCounts(true);
    try {
      const counts = await countCharacterRefs(worldId, characterId);
      setDisclosureCounts(counts);
    } catch {
      // Count failed — fall back to the simple (non-disclosure) confirm.
      setDisclosureCounts(null);
    } finally {
      setLoadingCounts(false);
      setConfirmOpen(true);
    }
  }

  const isDisclosable =
    disclosureCounts !== null &&
    (disclosureCounts.events > 0 || disclosureCounts.scenes > 0);

  function handleCardClick() {
    if (selectable) {
      if (focused) {
        onFocus?.();
      } else {
        onSelect?.();
      }
    } else {
      onClick?.();
    }
  }

  function handleCardKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleCardClick();
    }
  }

  return (
    <>
      <Card
        role="button"
        tabIndex={0}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
        className={cn(
          selectable && "relative cursor-pointer",
          selected && "ring-2 ring-primary",
          focused && "ring-2 ring-primary/50",
        )}
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={UserMultiple02Icon}
              strokeWidth={2}
              className="text-muted-foreground"
            />
            <span className="truncate">{name}</span>
          </CardTitle>
          {!selectable && (
            <CardAction>
              <DropdownMenu>
                <DropdownMenuTrigger
                  onClick={(e) => e.stopPropagation()}
                  render={
                    <Button variant="ghost" size="icon-sm" />
                  }
                >
                  <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
                  <span className="sr-only">{t("common:actions.moreActions")}</span>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onClick?.();
                    }}
                  >
                    <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                    {t("character:card.editAction")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={handleDeleteClick}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                    {t("character:card.deleteAction")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-2">
          {aliases.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("character:card.aliasesLabel")}: {aliases.join(", ")}
            </p>
          )}
          <p className="line-clamp-2 min-h-8 flex-1 text-sm text-muted-foreground">
            {description}
          </p>
          {phases.length > 0 ? (
            <PhaseStepper phases={phases} />
          ) : (
            <span className="text-xs text-muted-foreground/60">
              {t("character:card.noPhases")}
            </span>
          )}
          {tags.length > 0 && (
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
            {formatRelativeTime(updatedAt)}
          </p>
        </CardContent>

        {selectable && selected && !onRemove && (
          <HugeiconsIcon
            icon={Tick02Icon}
            strokeWidth={2}
            className="absolute top-2 right-2 size-4 text-primary"
          />
        )}
        {selectable && onRemove && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="absolute top-2 right-2 flex size-6 items-center justify-center rounded-full bg-background/80 text-muted-foreground hover:bg-background hover:text-foreground"
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-4" />
          </button>
        )}
      </Card>

      {!selectable && (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {isDisclosable
                  ? t("character:card.deleteDisclosableTitle", { name })
                  : t("character:card.deleteTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {isDisclosable
                  ? t("character:card.deleteDisclosableDescription", {
                      name,
                      events: disclosureCounts!.events,
                      scenes: disclosureCounts!.scenes,
                      phases: phases.length,
                    })
                  : t("character:card.deleteDescription", { name })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={() => {
                  setConfirmOpen(false);
                  onDelete?.();
                }}
              >
                {t("common:actions.delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}

export { CharacterCard };
