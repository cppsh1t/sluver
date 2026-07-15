import { useMemo, useState } from "react";
import { createRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { worldLayoutRoute } from "./_world";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Search01Icon, UserMultiple02Icon } from "@hugeicons/core-free-icons";
import { CharacterFormDialog } from "@/components/worldbook/character-form-dialog";
import { CharacterCard } from "@/components/worldbook/character-card";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import {
  useCharacters,
  useCreateCharacter,
  useDeleteCharacter,
} from "@/hooks";
import type { CreateCharacterInput } from "@/api";
import type { CharacterId, WorldId } from "@/types";

function CharactersPage() {
  const { t } = useTranslation(["character", "common"]);
  const { worldId } = useParams({ from: "/world/$worldId" });
  const wid = worldId as WorldId;
  const navigate = useNavigate();

  const { data: characters = [], isLoading } = useCharacters(wid);
  const createMut = useCreateCharacter(wid);
  const deleteMut = useDeleteCharacter(wid);

  const [createOpen, setCreateOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    if (!search.trim()) return characters;
    const q = search.toLowerCase();
    return characters.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.aliases.some((a) => a.toLowerCase().includes(q)) ||
        c.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [characters, search]);

  async function handleCreate(input: CreateCharacterInput) {
    try {
      const newChar = await createMut.mutateAsync(input);
      toast.success(t("character:toast.createSuccess"));
      navigate({
        to: "/world/$worldId/characters/$characterId",
        params: { worldId, characterId: newChar.id },
      });
    } catch (e) {
      toast.error(t("character:toast.createFailed"), {
        description: translateError(toErrorPayload(e)),
      });
      throw e;
    }
  }

  async function handleDelete(id: CharacterId) {
    try {
      await deleteMut.mutateAsync(id);
      toast.success(t("character:toast.deleteSuccess"));
    } catch (e) {
      toast.error(t("character:toast.deleteFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-7xl px-4 py-10">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-heading text-xl font-semibold tracking-tight">
              {t("character:list.title")}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("character:list.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <HugeiconsIcon
                icon={Search01Icon}
                strokeWidth={2}
                className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("character:search.placeholder")}
                className="w-56 pl-8"
              />
            </div>
            <Button onClick={() => setCreateOpen(true)}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {t("character:list.createButton")}
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="animate-pulse opacity-50">
                <div className="flex flex-col gap-2 px-4 pt-4 pb-1">
                  <div className="h-4 w-24 rounded bg-muted" />
                </div>
                <div className="flex flex-col gap-2 px-4 pb-4">
                  <div className="h-3 w-full rounded bg-muted" />
                  <div className="h-3 w-2/3 rounded bg-muted" />
                  <div className="mt-2 h-3 w-16 rounded bg-muted/50" />
                </div>
              </Card>
            ))}
          </div>
        ) : characters.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={UserMultiple02Icon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>
                {t("character:empty.title")}
              </EmptyTitle>
              <EmptyDescription>
                {t("character:empty.description")}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setCreateOpen(true)}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {t("character:empty.cta")}
              </Button>
            </EmptyContent>
          </Empty>
        ) : filtered.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>
                {t("character:search.noResults", { query: search })}
              </EmptyTitle>
              <EmptyDescription>
                {t("character:search.noResultsDescription")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((entity) => (
              <CharacterCard
                key={entity.id}
                worldId={wid}
                characterId={entity.id}
                name={entity.name}
                aliases={entity.aliases}
                description={entity.description}
                tags={entity.tags}
                phaseNames={entity.phases.map((p) => p.name)}
                updatedAt={entity.updatedAt}
                onClick={() =>
                  navigate({
                    to: "/world/$worldId/characters/$characterId",
                    params: { worldId, characterId: entity.id },
                  })
                }
                onDelete={() => handleDelete(entity.id)}
              />
            ))}
          </div>
        )}
      </div>

      <CharacterFormDialog
        mode="create"
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={handleCreate}
      />
    </div>
  );
}

export const charactersRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "characters",
  component: CharactersPage,
});
