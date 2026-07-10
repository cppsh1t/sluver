import { useEffect, useState } from "react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import { rootRoute } from "./__root";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon, Globe02Icon } from "@hugeicons/core-free-icons";
import { CreateWorldDialog } from "@/components/world-hub/create-world-dialog";
import { WorldCard } from "@/components/world-hub/world-card";
import { createWorld, deleteWorld, listWorlds } from "@/api";
import type { CreateWorldInput } from "@/api";
import type { World } from "@/types";

function WorldHubPage() {
  const navigate = useNavigate();
  const [worlds, setWorlds] = useState<World[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    listWorlds()
      .then(setWorlds)
      .catch((e) => {
        toast.error("加载世界列表失败", { description: e as string });
      })
      .finally(() => setLoading(false));
  }, []);

  function handleOpen(world: World) {
    navigate({ to: "/world/$worldId", params: { worldId: world.id } });
  }

  async function handleCreate(input: CreateWorldInput) {
    try {
      const world = await createWorld(input);
      setWorlds((prev) => [world, ...prev]);
      toast.success("世界创建成功");
    } catch (e) {
      toast.error("创建失败", { description: e as string });
      throw e;
    }
  }

  async function handleDelete(world: World) {
    try {
      await deleteWorld(world.id);
      setWorlds((prev) => prev.filter((w) => w.id !== world.id));
      toast.success("世界已删除");
    } catch (e) {
      toast.error("删除失败", { description: e as string });
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="font-heading text-lg font-medium tracking-tight">
            我的世界
          </h1>
          <Button onClick={() => setCreateOpen(true)}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            新建世界
          </Button>
        </div>

        {loading ? (
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
        ) : worlds.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={Globe02Icon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>还没有创建世界</EmptyTitle>
              <EmptyDescription>
                创建你的第一个世界观宇宙，开始角色设定、事件编织和小说创作。
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setCreateOpen(true)}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                创建第一个世界
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {worlds.map((world) => (
              <WorldCard
                key={world.id}
                world={world}
                onOpen={handleOpen}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>

      <CreateWorldDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreate={handleCreate}
      />
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: WorldHubPage,
});
