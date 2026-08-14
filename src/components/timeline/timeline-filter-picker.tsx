import { useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { HugeiconsIcon } from "@hugeicons/react";
import { Book02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { SearchablePickerDialog } from "@/components/worldbook/searchable-picker-dialog";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Novel, WorldId } from "@/types";

interface TimelineFilterPickerProps<T> {
  /** Trigger placeholder when nothing is selected, e.g. t("filter.location"). */
  triggerLabel: string;
  /** Resolved name of the currently-selected entity (or undefined). */
  selectedLabel?: string;
  dialogTitle: string;
  searchPlaceholder: string;
  /** The dashed "all / clear" option text, e.g. t("filter.locationAll"). */
  allLabel: string;
  value: string | null;
  onChange: (id: string | null) => void;
  options: T[];
  getId: (t: T) => string;
  /** Searchable text, e.g. name/title (+ tags for items). */
  getSearchText: (t: T) => string;
  /** Render a single option as a card. */
  renderCard: (t: T, selected: boolean, onSelect: () => void) => ReactNode;
  spaceId: string;
  worldId: WorldId;
}

/**
 * Single-select Dialog picker for a Timeline filter — mirrors
 * `LocationRefPicker` exactly (SearchablePickerDialog + dashed "all" clear
 * button + 2-col card grid + no-results message). Selecting a card (or the
 * dashed "all") commits immediately and closes the dialog.
 *
 * Generic over the entity type T; the call site supplies `renderCard` so the
 * same shell can show `EntityCard`s (location/item) or `NovelFilterCard`s.
 */
function TimelineFilterPicker<T>({
  triggerLabel,
  selectedLabel,
  dialogTitle,
  searchPlaceholder,
  allLabel,
  value,
  onChange,
  options,
  getId,
  getSearchText,
  renderCard,
}: TimelineFilterPickerProps<T>) {
  const { t } = useTranslation("timeline");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => getSearchText(o).toLowerCase().includes(q));
  }, [options, search, getSearchText]);

  function handleSelect(id: string | null) {
    onChange(id);
    setOpen(false);
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) setSearch("");
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        type="button"
        onClick={() => setOpen(true)}
        className="max-w-48"
      >
        <span className={cn("truncate", !selectedLabel && "text-muted-foreground")}>
          {selectedLabel ?? triggerLabel}
        </span>
      </Button>
      <SearchablePickerDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={dialogTitle}
        searchPlaceholder={searchPlaceholder}
        searchValue={search}
        onSearchChange={setSearch}
        mode="single"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => handleSelect(null)}
            className={cn(
              "flex items-center justify-center rounded-lg border-2 border-dashed p-4 text-sm text-muted-foreground transition-colors hover:bg-muted",
              value === null && "border-primary text-primary",
            )}
          >
            {allLabel}
          </button>
          {filtered.map((o) => {
            const id = getId(o);
            return (
              <span key={id}>
                {renderCard(o, id === value, () => handleSelect(id))}
              </span>
            );
          })}
        </div>
        {filtered.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("filter.noResults")}
          </p>
        )}
      </SearchablePickerDialog>
    </>
  );
}

interface NovelFilterCardProps {
  novel: Novel;
  selected: boolean;
  onSelect: () => void;
}

/**
 * Novel option card for the Timeline filter dialog. `EntityCard` only supports
 * location/item/lore (no "novel" entityType, and Novel has title/description
 * rather than name/tags), so this local card mirrors EntityCard's selectable
 * styling — banner area, title, description, selection ring + tick — to feel
 * native alongside it.
 */
function NovelFilterCard({ novel, selected, onSelect }: NovelFilterCardProps) {
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect();
    }
  }

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      className={cn(
        "relative cursor-pointer pt-0",
        selected && "ring-2 ring-primary",
      )}
    >
      <div className="flex h-40 w-full items-center justify-center bg-muted">
        <HugeiconsIcon
          icon={Book02Icon}
          strokeWidth={2}
          className="size-12 text-muted-foreground"
        />
      </div>
      <CardHeader>
        <CardTitle className="truncate">{novel.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-2">
        <p className="line-clamp-2 min-h-8 flex-1 text-sm text-muted-foreground">
          {novel.description}
        </p>
        <p className="text-xs text-muted-foreground/70">
          {formatRelativeTime(novel.updatedAt)}
        </p>
      </CardContent>
      {selected && (
        <HugeiconsIcon
          icon={Tick02Icon}
          strokeWidth={2}
          className="absolute top-2 right-2 size-4 text-primary"
        />
      )}
    </Card>
  );
}

export { NovelFilterCard, TimelineFilterPicker };
