import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { SearchablePickerDialog } from "@/components/worldbook/searchable-picker-dialog";
import { CharacterCard } from "@/components/worldbook/character-card";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import type { CharacterRef, Character, WorldId } from "@/types";

interface CharacterRefPickerProps {
  spaceId: string;
  worldId: WorldId;
  selectedRefs: CharacterRef[];
  characters: Character[];
  /** Fires on commit with the FULL updated participant list (not a delta). */
  onCommit: (refs: CharacterRef[]) => void;
}

/**
 * `{characterId}:${phaseId}` — both IDs are UUID v7 (hex + hyphens only), so
 * `:` is a safe delimiter that can never collide with the ID contents.
 */
function pairKey(characterId: string, phaseId: string): string {
  return `${characterId}:${phaseId}`;
}

/**
 * Two-panel dialog for composing the participant list of an event.
 *
 * Left panel — searchable grid of eligible characters (those with ≥1 phase).
 *   Clicking a card *focuses* it (ring); the selection unit is the
 *   { character, phase } pair, not the character alone, so a click never
 *   toggles selection by itself.
 * Right panel — phases of the focused character. Clicking a phase toggles
 *   the pair in the local selection set. Selections persist across character
 *   switches (only the right-panel view changes).
 * Footer — Cancel (discard local edits) / Commit (send the full list via
 *   `onCommit`). The dialog is a sibling of the trigger button, not a child.
 *
 * See ADR-0007 for the two-panel picker layout rationale.
 */
function CharacterRefPicker({
  spaceId,
  worldId,
  selectedRefs,
  characters,
  onCommit,
}: CharacterRefPickerProps) {
  const { t } = useTranslation(["event", "common"]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [focusedCharacterId, setFocusedCharacterId] = useState<string | null>(
    null,
  );
  const [selectedPairs, setSelectedPairs] = useState<Set<string>>(new Set());

  // Only characters with at least one phase can participate.
  const eligible = useMemo(
    () => characters.filter((c) => c.phases.length > 0),
    [characters],
  );

  // Search matches name OR any alias (case-insensitive).
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.aliases.some((a) => a.toLowerCase().includes(q)),
    );
  }, [eligible, query]);

  const focusedCharacter = useMemo(
    () => characters.find((c) => c.id === focusedCharacterId) ?? null,
    [characters, focusedCharacterId],
  );

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      // Re-seed local state from the committed refs on every open.
      setSelectedPairs(
        new Set(selectedRefs.map((r) => pairKey(r.characterId, r.phaseId))),
      );
      setQuery("");
      setFocusedCharacterId(null);
    }
  }

  function togglePair(characterId: string, phaseId: string) {
    setSelectedPairs((prev) => {
      const key = pairKey(characterId, phaseId);
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function handleCommit() {
    const refs: CharacterRef[] = Array.from(selectedPairs).map((key) => {
      const [charId, phaseId] = key.split(":");
      return {
        characterId: charId as CharacterRef["characterId"],
        phaseId: phaseId as CharacterRef["phaseId"],
      };
    });
    onCommit(refs);
    setOpen(false);
  }

  const commitLabel = t("event:picker.participants.commit");

  return (
    <>
      <Button size="sm" onClick={() => handleOpenChange(true)}>
        <HugeiconsIcon
          icon={Add01Icon}
          strokeWidth={2}
          data-icon="inline-start"
        />
        {t("event:detail.participants.add")}
      </Button>

      <SearchablePickerDialog
        open={open}
        onOpenChange={handleOpenChange}
        title={t("event:picker.character.title")}
        searchPlaceholder={t("event:picker.character.searchPlaceholder")}
        searchValue={query}
        onSearchChange={setQuery}
        mode="two-panel"
        dialogClassName="sm:max-w-4xl"
        sidePanel={
          focusedCharacter ? (
            <div className="flex flex-col gap-2 py-1">
              <p className="px-1 text-xs font-medium text-muted-foreground">
                {focusedCharacter.name}
              </p>
              {focusedCharacter.phases.map((p) => {
                const selected = selectedPairs.has(
                  pairKey(focusedCharacter.id, p.id),
                );
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => togglePair(focusedCharacter.id, p.id)}
                    className={cn(
                      "flex flex-col items-start gap-1 rounded-md border p-2 text-left transition-colors hover:bg-muted",
                      selected && "border-transparent bg-accent",
                    )}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="text-sm font-semibold">{p.name}</span>
                      {selected && (
                        <HugeiconsIcon
                          icon={Tick02Icon}
                          strokeWidth={2}
                          className="size-4 text-primary"
                        />
                      )}
                    </div>
                    {p.appearance && (
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {p.appearance}
                      </p>
                    )}
                    {p.changes && (
                      <p className="line-clamp-2 text-xs text-muted-foreground/80">
                        {p.changes}
                      </p>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="px-1 py-2 text-sm text-muted-foreground">
              {t("event:picker.phase.selectCharacter")}
            </p>
          )
        }
        footer={
          <div className="flex items-center gap-2">
            <span className="flex-1 text-sm text-muted-foreground">
              {t("event:card.participantsCount", {
                count: selectedPairs.size,
              })}
            </span>
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              {t("common:actions.cancel")}
            </Button>
            <Button onClick={handleCommit}>{commitLabel}</Button>
          </div>
        }
      >
        {filtered.length === 0 ? (
          <p className="px-1 py-2 text-sm text-muted-foreground">
            {t("event:list.noResults")}
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {filtered.map((c) => (
              <CharacterCard
                key={c.id}
                spaceId={spaceId}
                worldId={worldId}
                characterId={c.id}
                name={c.name}
                aliases={c.aliases}
                description={c.description}
                tags={c.tags}
                phases={c.phases}
                updatedAt={c.updatedAt}
                selectable
                focused={c.id === focusedCharacterId}
                onSelect={() => setFocusedCharacterId(c.id)}
                onFocus={() => setFocusedCharacterId(c.id)}
              />
            ))}
          </div>
        )}
      </SearchablePickerDialog>
    </>
  );
}

export { CharacterRefPicker };
