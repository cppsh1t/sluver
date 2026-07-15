import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import type { CharacterRef, Character, WorldId } from "@/types";

interface CharacterRefPickerProps {
  worldId: WorldId;
  selectedRefs: CharacterRef[];
  characters: Character[];
  onAdd: (ref: CharacterRef) => void;
}

/**
 * Two-step popover for adding a `{ characterId, phaseId }` participant ref.
 *
 * Step 1 — pick a Character (only those with ≥1 phase are eligible; a muted
 * hint reports how many characters have zero phases and are excluded).
 * Step 2 — pick a Phase belonging to that character; already-selected pairs
 * are greyed out with an "已添加" label.
 */
function CharacterRefPicker({
  selectedRefs,
  characters,
  onAdd,
}: CharacterRefPickerProps) {
  const { t } = useTranslation(["event", "common"]);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"character" | "phase">("character");
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(
    null,
  );
  const [query, setQuery] = useState("");

  // Only characters with at least one phase can participate.
  const eligible = useMemo(
    () => characters.filter((c) => c.phases.length > 0),
    [characters],
  );
  const zeroPhaseCount = characters.length - eligible.length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter((c) => c.name.toLowerCase().includes(q));
  }, [eligible, query]);

  const selectedCharacter = useMemo(
    () => eligible.find((c) => c.id === selectedCharacterId) ?? null,
    [eligible, selectedCharacterId],
  );

  function isRefSelected(characterId: string, phaseId: string): boolean {
    return selectedRefs.some(
      (r) => r.characterId === characterId && r.phaseId === phaseId,
    );
  }

  // Reset internal navigation state when the popover closes so the next open
  // always starts on the character step.
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setStep("character");
      setSelectedCharacterId(null);
      setQuery("");
    }
  }

  function handlePickCharacter(id: string) {
    setSelectedCharacterId(id);
    setStep("phase");
  }

  function handlePickPhase(characterId: string, phaseId: string) {
    onAdd({
      characterId: characterId as CharacterRef["characterId"],
      phaseId: phaseId as CharacterRef["phaseId"],
    });
    handleOpenChange(false);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger render={<Button size="sm" />}>
        <HugeiconsIcon
          icon={Add01Icon}
          strokeWidth={2}
          data-icon="inline-start"
        />
        {t("event:detail.participants.add")}
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        {step === "character" ? (
          <div className="flex flex-col gap-2 p-2">
            <p className="px-1 text-xs font-medium text-muted-foreground">
              {t("event:picker.character.title")}
            </p>
            <Input
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder={t("event:picker.character.searchPlaceholder")}
              className="h-7"
            />
            <div className="flex max-h-64 flex-col overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="px-1 py-2 text-xs text-muted-foreground">
                  {t("event:list.noResults")}
                </p>
              ) : (
                filtered.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                    onClick={() => handlePickCharacter(c.id)}
                  >
                    <span className="truncate">{c.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {t("event:picker.character.phaseCount", {
                        count: c.phases.length,
                      })}
                    </span>
                  </button>
                ))
              )}
            </div>
            {zeroPhaseCount > 0 && (
              <p className="px-1 text-[0.625rem] text-muted-foreground/70">
                {t("event:picker.character.zeroPhasesHint", {
                  count: zeroPhaseCount,
                })}
              </p>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-1 p-2">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setStep("character")}
              >
                <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} />
                <span className="sr-only">
                  {t("event:picker.phase.back")}
                </span>
              </Button>
              <p className="text-xs font-medium">
                {selectedCharacter?.name}
              </p>
            </div>
            <div className="flex max-h-64 flex-col overflow-y-auto">
              {selectedCharacter?.phases.map((p) => {
                const taken = isRefSelected(selectedCharacter.id, p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={taken}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                    onClick={() =>
                      !taken &&
                      handlePickPhase(selectedCharacter.id, p.id)
                    }
                  >
                    <span className="truncate">{p.name}</span>
                    {taken && (
                      <span className="shrink-0 text-muted-foreground">
                        {t("event:picker.phase.alreadySelected")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export { CharacterRefPicker };
