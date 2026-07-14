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
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
  UserMultiple02Icon,
} from "@hugeicons/core-free-icons";
import { formatRelativeTime } from "@/lib/format";

// ─── Phase stepper ───────────────────────────────────────────────────────────

interface PhaseStepperProps {
  phaseNames: string[];
}

function PhaseStepper({ phaseNames }: PhaseStepperProps) {
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
  }, [phaseNames]);

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
      {phaseNames.map((name, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="shrink-0 text-xs text-muted-foreground/40">→</span>}
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <span className="size-1.5 shrink-0 rounded-full bg-primary/40" />
            <span className="whitespace-nowrap">{name}</span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}

// ─── Character card ──────────────────────────────────────────────────────────

interface CharacterCardProps {
  name: string;
  aliases: string[];
  description: string;
  tags: string[];
  phaseNames: string[];
  updatedAt: string;
  onClick: () => void;
  onDelete: () => void;
}

function CharacterCard({
  name,
  aliases,
  description,
  tags,
  phaseNames,
  updatedAt,
  onClick,
  onDelete,
}: CharacterCardProps) {
  const { t } = useTranslation(["character", "common"]);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const visibleTags = tags.slice(0, 3);
  const extraCount = tags.length - 3;

  return (
    <>
      <Card
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
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
                    onClick();
                  }}
                >
                  <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                  {t("character:card.editAction")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmOpen(true);
                  }}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  {t("character:card.deleteAction")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </CardAction>
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
          {phaseNames.length > 0 ? (
            <PhaseStepper phaseNames={phaseNames} />
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
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("character:card.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("character:card.deleteDescription", { name })}
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

export { CharacterCard };
