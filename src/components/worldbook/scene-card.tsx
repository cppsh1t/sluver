import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EntityCard } from "@/components/worldbook/entity-card";
import { ParticipantCard } from "@/components/worldbook/participant-card";
import { CharacterRefPicker } from "@/components/worldbook/character-ref-picker";
import { LocationRefPicker } from "@/components/worldbook/location-ref-picker";
import { ItemMultiPicker } from "@/components/worldbook/item-multi-picker";
import { EventMultiPicker } from "@/components/worldbook/event-multi-picker";
import { SceneImageGallery } from "@/components/worldbook/scene-image-gallery";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Calendar03Icon,
  Delete02Icon,
  GripVerticalIcon,
  Link02Icon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type {
  Character,
  Event as EventType,
  EventId,
  Item,
  ItemId,
  Location,
  LocationId,
  Scene,
  WorldId,
} from "@/types";

type SaveStatus = "idle" | "saving" | "saved" | "error";

type ScenePatch = Partial<
  Pick<
    Scene,
    | "title"
    | "summary"
    | "content"
    | "startAt"
    | "endAt"
    | "characterRefs"
    | "locationId"
    | "itemIds"
    | "eventIds"
  >
>;

interface SceneCardProps {
  scene: Scene;
  isActive: boolean;
  saveStatus: SaveStatus;
  isDragging?: boolean;
  dragHandleProps?: Record<string, unknown>;
  spaceId: string;
  worldId: WorldId;
  characters: Character[];
  locations: Location[];
  items: Item[];
  events: EventType[];
  onFieldChange: (patch: ScenePatch) => void;
  onActiveFocus: () => void;
  onDelete: () => void;
}

/** Convert ISO 8601 → datetime-local input value. */
function toDatetimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Convert datetime-local input value → ISO 8601 (null when empty). */
function fromDatetimeLocal(local: string): string | null {
  return local ? new Date(local).toISOString() : null;
}

const TIME_FMT = "YYYY-MM-DD HH:mm";

function SceneCard({
  scene,
  isActive,
  saveStatus,
  isDragging,
  dragHandleProps,
  spaceId,
  worldId,
  characters,
  locations,
  items,
  events,
  onFieldChange,
  onActiveFocus,
  onDelete,
}: SceneCardProps) {
  const { t, i18n } = useTranslation(["novel", "common"]);
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(scene.title);
  const [summaryOpen, setSummaryOpen] = useState(true);
  const [refsOpen, setRefsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [itemPickerOpen, setItemPickerOpen] = useState(false);
  const [eventPickerOpen, setEventPickerOpen] = useState(false);

  const charMap = useMemo(() => {
    const m = new Map<string, Character>();
    for (const c of characters) m.set(c.id, c);
    return m;
  }, [characters]);

  const locMap = useMemo(() => {
    const m = new Map<string, Location>();
    for (const l of locations) m.set(l.id, l);
    return m;
  }, [locations]);

  const itemMap = useMemo(() => {
    const m = new Map<string, Item>();
    for (const i of items) m.set(i.id, i);
    return m;
  }, [items]);

  const eventMap = useMemo(() => {
    const m = new Map<string, EventType>();
    for (const e of events) m.set(e.id, e);
    return m;
  }, [events]);

  const contentRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize the content textarea to fit its content.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [scene.content]);

  function commitTitle() {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== scene.title) {
      onFieldChange({ title: trimmed });
    } else {
      setTitleDraft(scene.title);
    }
    setTitleEditing(false);
  }

  const isCJK = ["zh", "ja", "ko"].some((l) => i18n.language.startsWith(l));
  const wordCount = isCJK
    ? scene.content.replace(/\s/g, "").length
    : scene.content.trim() ? scene.content.trim().split(/\s+/).length : 0;
  const hasTime = scene.startAt || scene.endAt;

  const timeLabel = (() => {
    if (!hasTime) return t("novel:scene.timeUnspecified");
    const s = scene.startAt ? dayjs(scene.startAt).format(TIME_FMT) : "—";
    const e = scene.endAt ? dayjs(scene.endAt).format(TIME_FMT) : "—";
    return `${s} ~ ${e}`;
  })();

  const saveLabel = (() => {
    switch (saveStatus) {
      case "saving":
        return t("novel:scene.saveStatus.saving");
      case "saved":
        return t("novel:scene.saveStatus.saved");
      case "error":
        return t("novel:scene.saveStatus.error");
      default:
        return null;
    }
  })();

  return (
    <div
      className={cn(
        "rounded-lg border bg-card",
        isActive && "ring-2 ring-primary/40",
        isDragging && "opacity-50",
      )}
    >
      {/* Header: drag handle + title + menu */}
      <div className="flex items-start gap-2 px-4 pt-3">
        {dragHandleProps && (
          <button
            type="button"
            className="mt-1 flex cursor-grab items-center text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing"
            {...dragHandleProps}
          >
            <HugeiconsIcon icon={GripVerticalIcon} strokeWidth={2} className="size-4" />
          </button>
        )}

        <div className="min-w-0 flex-1">
          {titleEditing ? (
            <Input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.currentTarget.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTitle();
                }
                if (e.key === "Escape") {
                  setTitleDraft(scene.title);
                  setTitleEditing(false);
                }
              }}
              className="h-7 px-1 text-base font-medium"
              autoFocus
            />
          ) : (
            <h3
              className="cursor-text text-base font-medium"
              onClick={() => {
                setTitleDraft(scene.title);
                setTitleEditing(true);
              }}
            >
              {scene.title}
            </h3>
          )}

          {/* Time range */}
          <div className="mt-0.5 flex items-center gap-1.5">
            <Popover>
              <PopoverTrigger
                render={
                  <button
                    type="button"
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  />
                }
              >
                <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} className="size-3.5" />
                {timeLabel}
              </PopoverTrigger>
              <PopoverContent align="start" className="w-72">
                <div className="flex flex-col gap-2">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t("novel:scene.timeSet")}
                  </label>
                  <Input
                    type="datetime-local"
                    value={toDatetimeLocal(scene.startAt)}
                    onChange={(e) =>
                      onFieldChange({
                        startAt: fromDatetimeLocal(e.currentTarget.value),
                      })
                    }
                  />
                  <Input
                    type="datetime-local"
                    value={toDatetimeLocal(scene.endAt)}
                    onChange={(e) =>
                      onFieldChange({
                        endAt: fromDatetimeLocal(e.currentTarget.value),
                      })
                    }
                  />
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {/* Save status */}
        {saveLabel && (
          <span
            className={cn(
              "mt-1 shrink-0 text-xs",
              saveStatus === "error"
                ? "text-destructive"
                : "text-muted-foreground/60",
            )}
          >
            {saveLabel}
          </span>
        )}

        {/* ⋯ menu */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-sm" />}
          >
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              {t("novel:scene.deleteAction")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Collapsible summary */}
      <div className="px-4">
        <button
          type="button"
          onClick={() => setSummaryOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-muted-foreground"
        >
          <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} className="size-3.5" />
          {summaryOpen
            ? t("novel:scene.summaryHide")
            : t("novel:scene.summaryShow")}
        </button>
        {summaryOpen && (
          <Textarea
            value={scene.summary}
            onChange={(e) => onFieldChange({ summary: e.currentTarget.value })}
            placeholder={t("novel:scene.summaryPlaceholder")}
            className="mt-1 min-h-[60px] text-sm"
            rows={2}
          />
        )}
      </div>

      {/* Content textarea — the writing surface */}
      <div className="px-4 pb-3 pt-2">
        <Textarea
          ref={contentRef}
          value={scene.content}
          onChange={(e) => onFieldChange({ content: e.currentTarget.value })}
          onFocus={onActiveFocus}
          placeholder=""
          className="min-h-[120px] resize-none border-0 bg-transparent p-0 font-article text-base leading-relaxed shadow-none focus-visible:ring-0"
          style={{
            fontSize: "18px",
            lineHeight: "1.8",
          }}
        />
      </div>

      {/* Collapsible references (关联) section */}
      <div className="border-t px-4 py-3">
        <button
          type="button"
          onClick={() => setRefsOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-muted-foreground"
        >
          <HugeiconsIcon icon={Link02Icon} strokeWidth={2} className="size-3.5" />
          {refsOpen ? t("novel:scene.refsHide") : t("novel:scene.refsShow")}
        </button>
        {refsOpen && (
          <div className="mt-3 flex flex-col gap-4">
            {/* Characters */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">
                  {t("novel:refs.characters.title")}
                </h4>
                <CharacterRefPicker
                  spaceId={spaceId}
                  worldId={worldId}
                  selectedRefs={scene.characterRefs}
                  characters={characters}
                  onCommit={(refs) => onFieldChange({ characterRefs: refs })}
                />
              </div>
              {scene.characterRefs.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("novel:refs.characters.empty")}
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {scene.characterRefs.map((ref) => {
                    const c = charMap.get(ref.characterId);
                    const p = c?.phases.find((ph) => ph.id === ref.phaseId);
                    if (!c || !p) return null;
                    return (
                      <ParticipantCard
                        key={`${ref.characterId}-${ref.phaseId}`}
                        characterName={c.name}
                        characterAliases={c.aliases}
                        phaseName={p.name}
                        phaseAppearance={p.appearance}
                        phaseDescription={p.description}
                        onRemove={() =>
                          onFieldChange({
                            characterRefs: scene.characterRefs.filter(
                              (r) =>
                                !(
                                  r.characterId === ref.characterId &&
                                  r.phaseId === ref.phaseId
                                ),
                            ),
                          })
                        }
                      />
                    );
                  })}
                </div>
              )}
            </div>

            {/* Location */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">
                  {t("novel:refs.location.title")}
                </h4>
                <LocationRefPicker
                  spaceId={spaceId}
                  worldId={worldId}
                  locations={locations}
                  selectedLocationId={scene.locationId}
                  onSelect={(id) =>
                    onFieldChange({ locationId: id as LocationId | null })
                  }
                />
              </div>
              {scene.locationId ? (
                (() => {
                  const loc = locMap.get(scene.locationId);
                  if (!loc) {
                    return (
                      <p className="text-xs text-muted-foreground">
                        {t("novel:refs.location.none")}
                      </p>
                    );
                  }
                  return (
                    <EntityCard
                      spaceId={spaceId}
                      worldId={worldId}
                      id={loc.id}
                      name={loc.name}
                      description={loc.description}
                      tags={loc.tags}
                      updatedAt={loc.updatedAt}
                      entityType="location"
                      selectable
                      selected
                      onRemove={() => onFieldChange({ locationId: null })}
                    />
                  );
                })()
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("novel:refs.location.none")}
                </p>
              )}
            </div>

            {/* Items */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">
                  {t("novel:refs.items.title")}
                </h4>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setItemPickerOpen(true)}
                >
                  <HugeiconsIcon
                    icon={Add01Icon}
                    strokeWidth={2}
                    className="size-3.5"
                  />
                  {t("novel:refs.items.add")}
                </Button>
              </div>
              {scene.itemIds.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("novel:refs.items.empty")}
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {scene.itemIds.map((id) => {
                    const item = itemMap.get(id);
                    if (!item) return null;
                    return (
                      <EntityCard
                        key={id}
                        spaceId={spaceId}
                        worldId={worldId}
                        id={item.id}
                        name={item.name}
                        description={item.description}
                        tags={item.tags}
                        updatedAt={item.updatedAt}
                        entityType="item"
                        selectable
                        selected
                        onRemove={() =>
                          onFieldChange({
                            itemIds: scene.itemIds.filter((i) => i !== id),
                          })
                        }
                      />
                    );
                  })}
                </div>
              )}
            </div>

            {/* Events */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">
                  {t("novel:refs.events.title")}
                </h4>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEventPickerOpen(true)}
                >
                  <HugeiconsIcon
                    icon={Add01Icon}
                    strokeWidth={2}
                    className="size-3.5"
                  />
                  {t("novel:refs.events.add")}
                </Button>
              </div>
              {scene.eventIds.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t("novel:refs.events.empty")}
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {scene.eventIds.map((id) => {
                    const evt = eventMap.get(id);
                    if (!evt) return null;
                    return (
                      <div
                        key={id}
                        className="flex items-center gap-2 rounded-md border px-3 py-2"
                      >
                        <HugeiconsIcon
                          icon={Calendar03Icon}
                          strokeWidth={2}
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {evt.name}
                          </p>
                          {evt.description && (
                            <p className="truncate text-xs text-muted-foreground">
                              {evt.description}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Picker dialogs */}
      <ItemMultiPicker
        spaceId={spaceId}
        worldId={worldId}
        open={itemPickerOpen}
        onOpenChange={setItemPickerOpen}
        items={items}
        selectedIds={scene.itemIds}
        onCommit={(ids) => onFieldChange({ itemIds: ids as ItemId[] })}
      />
      <EventMultiPicker
        spaceId={spaceId}
        open={eventPickerOpen}
        onOpenChange={setEventPickerOpen}
        events={events}
        selectedIds={scene.eventIds}
        onCommit={(ids) => onFieldChange({ eventIds: ids as EventId[] })}
      />

      {/* Scene image gallery (edit mode — add / reorder / delete) */}
      <SceneImageGallery
        spaceId={spaceId}
        worldId={worldId}
        sceneId={scene.id}
        mode="edit"
      />

      {/* Footer: word count */}
      {wordCount > 0 && (
        <div className="border-t px-4 py-1.5">
          <span className="text-xs text-muted-foreground/50">
            {t("novel:chapter.wordCount", { count: wordCount })}
          </span>
        </div>
      )}

      {/* Delete confirmation */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("novel:scene.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {wordCount > 0
                ? t("novel:scene.deleteDescription", {
                    name: scene.title,
                    count: wordCount,
                  })
                : t("novel:scene.deleteDescriptionEmpty", {
                    name: scene.title,
                  })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmDelete(false);
                onDelete();
              }}
            >
              {t("common:actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export { SceneCard };
export type { SceneCardProps, ScenePatch, SaveStatus };
