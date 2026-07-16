import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { SearchablePickerDialog } from "@/components/worldbook/searchable-picker-dialog";
import { EntityCard } from "@/components/worldbook/entity-card";
import type { Item } from "@/types";

interface ItemMultiPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: Item[];
  selectedIds: string[];
  onCommit: (ids: string[]) => void;
}

/**
 * Multi-select dialog for associating Items with a Scene.
 *
 * The dialog's `open` state is controlled externally (the trigger lives in
 * the scene editor sidebar). On each open transition (false → true) the local
 * selection is re-seeded from `selectedIds`; edits are kept in a local Set
 * until the user clicks "Done", which commits the full id list via `onCommit`
 * and closes. Clicking a card toggles its membership in the local selection.
 */
function ItemMultiPicker({
  open,
  onOpenChange,
  items,
  selectedIds,
  onCommit,
}: ItemMultiPickerProps) {
  const { t } = useTranslation(["novel", "common"]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const prevOpen = useRef(open);

  // Seed local selection + reset search ONLY on the false → true transition.
  // Re-seeding on every `selectedIds` reference change while open would wipe
  // in-progress edits, hence the prevOpen guard.
  useEffect(() => {
    if (!prevOpen.current && open) {
      setSelected(new Set(selectedIds));
      setSearch("");
    }
    prevOpen.current = open;
  }, [open, selectedIds]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        it.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [items, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleDone() {
    onCommit(Array.from(selected));
    onOpenChange(false);
  }

  return (
    <SearchablePickerDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("novel:refs.itemPicker.title")}
      searchPlaceholder={t("novel:refs.itemPicker.searchPlaceholder")}
      searchValue={search}
      onSearchChange={setSearch}
      mode="single"
      footer={
        <div className="flex items-center gap-2">
          <span className="flex-1 text-sm text-muted-foreground">
            {t("novel:refs.items.title")} ({selected.size})
          </span>
          <Button onClick={handleDone}>
            {t("novel:refs.itemPicker.done")}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {filtered.map((it) => (
          <EntityCard
            key={it.id}
            name={it.name}
            description={it.description}
            tags={it.tags}
            updatedAt={it.updatedAt}
            entityType="item"
            selectable
            selected={selected.has(it.id)}
            onSelect={() => toggle(it.id)}
          />
        ))}
      </div>
    </SearchablePickerDialog>
  );
}

export { ItemMultiPicker };
export type { ItemMultiPickerProps };
