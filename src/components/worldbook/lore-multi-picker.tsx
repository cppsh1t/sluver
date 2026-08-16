import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { SearchablePickerDialog } from "@/components/worldbook/searchable-picker-dialog";
import { EntityCard } from "@/components/worldbook/entity-card";
import type { Lore, LoreId, WorldId } from "@/types";

interface LoreMultiPickerProps {
  spaceId: string;
  worldId: WorldId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lores: Lore[];
  selectedIds: LoreId[];
  onCommit: (ids: string[]) => void;
}

/**
 * Multi-select dialog for associating Lore entries with a Scene.
 *
 * The dialog's `open` state is controlled externally (the trigger lives in
 * the scene editor sidebar). On each open transition (false → true) the local
 * selection is re-seeded from `selectedIds`; edits are kept in a local Set
 * until the user clicks "Done", which commits the full id list via `onCommit`
 * and closes. Clicking a card toggles its membership in the local selection.
 */
function LoreMultiPicker({
  spaceId,
  worldId,
  open,
  onOpenChange,
  lores,
  selectedIds,
  onCommit,
}: LoreMultiPickerProps) {
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
    if (!q) return lores;
    return lores.filter(
      (it) =>
        it.name.toLowerCase().includes(q) ||
        it.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [lores, search]);

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
      title={t("novel:refs.lorePicker.title")}
      searchPlaceholder={t("novel:refs.lorePicker.searchPlaceholder")}
      searchValue={search}
      onSearchChange={setSearch}
      mode="single"
      footer={
        <div className="flex items-center gap-2">
          <span className="flex-1 text-sm text-muted-foreground">
            {t("novel:refs.lores.title")} ({selected.size})
          </span>
          <Button onClick={handleDone}>
            {t("novel:refs.lorePicker.done")}
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {filtered.map((it) => (
          <EntityCard
            key={it.id}
            spaceId={spaceId}
            worldId={worldId}
            id={it.id}
            name={it.name}
            description={it.description}
            tags={it.tags}
            updatedAt={it.updatedAt}
            entityType="lore"
            selectable
            selected={selected.has(it.id)}
            onSelect={() => toggle(it.id)}
          />
        ))}
      </div>
    </SearchablePickerDialog>
  );
}

export { LoreMultiPicker };
export type { LoreMultiPickerProps };
