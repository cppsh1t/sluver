import { useEffect, useRef, useState } from "react";
import { createRoute, useParams } from "@tanstack/react-router";
import { toast } from "sonner";

import { worldLayoutRoute } from "./_world";
import { CodeEditor } from "@/components/timemapper/code-editor";
import { PreviewPanel } from "@/components/timemapper/preview-panel";
import { Button } from "@/components/ui/button";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import { DEFAULT_TEMPLATE } from "@/lib/timemapper-template";
import { useTimeMapper, useSetTimeMapper } from "@/hooks";
import type { SpaceId, WorldId } from "@/types";

/**
 * TimeMapper editor page (ADR-0026).
 *
 * Layout mirrors `space.$spaceId/config.tsx` (centered narrow column, header +
 * bordered sections) but widens to `max-w-3xl` so the code editor and preview
 * table have room to breathe. Strings are hardcoded for now (no `timemapper`
 * i18n namespace yet) — see AGENTS.md §Adding a new user-facing string.
 */
function WorldConfigPage() {
  const { spaceId, worldId } = useParams({
    from: "/space/$spaceId/world/$worldId",
  });
  const sid = spaceId as SpaceId;
  const wid = worldId as WorldId;

  const mapperQ = useTimeMapper(sid, wid);
  const saveMut = useSetTimeMapper(sid, wid);

  // Local editor state. Seeded from persisted code (or DEFAULT_TEMPLATE when
  // nothing is configured). Re-seeding is guarded by `seededRef` so a refetch
  // (e.g. window refocus) never clobbers in-progress edits — we only re-seed
  // when the persisted value genuinely changed (initial load / save success).
  const [code, setCode] = useState(DEFAULT_TEMPLATE);
  const seededRef = useRef<string | null>(null);

  const persistedCode = mapperQ.data?.code ?? null;
  const baseline = persistedCode ?? DEFAULT_TEMPLATE;

  useEffect(() => {
    // `mapperQ.data === undefined` while loading; only seed once resolved.
    if (mapperQ.data === undefined) return;
    if (seededRef.current !== baseline) {
      seededRef.current = baseline;
      setCode(baseline);
    }
  }, [mapperQ.data, baseline]);

  const dirty = code !== baseline;

  async function handleSave() {
    if (!dirty || saveMut.isPending) return;
    try {
      await saveMut.mutateAsync(code);
      toast.success("时间映射器已保存");
    } catch (e) {
      toast.error("保存失败", {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  function handleReset() {
    setCode(DEFAULT_TEMPLATE);
  }

  const loading = mapperQ.isLoading;

  return (
    <main className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <header className="mb-8">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            时间映射器
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            用 JavaScript 将 ISO 时间戳转换为当前世界的历法。改动在保存后对所有时间显示生效。
          </p>
        </header>

        {/* ─── Editor ─────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3 border-y border-border py-5">
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <h2 className="font-heading text-sm font-medium tracking-tight">
                源代码
              </h2>
              <p className="text-xs text-muted-foreground">
                导出一个默认函数 <code className="font-mono">format(iso)</code>，返回显示字符串。
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              disabled={loading}
            >
              重置为模板
            </Button>
          </div>
          {loading ? (
            <div className="h-[400px] animate-pulse rounded-md bg-muted" />
          ) : (
            <CodeEditor value={code} onChange={setCode} />
          )}
        </section>

        {/* ─── Preview ────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3 border-b border-border py-5">
          <PreviewPanel code={code} />
        </section>

        {/* ─── Footer actions ─────────────────────────────────────── */}
        <div className="mt-6 flex items-center justify-end gap-2">
          <Button
            onClick={handleSave}
            disabled={!dirty || saveMut.isPending || loading}
          >
            {saveMut.isPending ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>
    </main>
  );
}

export const worldConfigRoute = createRoute({
  getParentRoute: () => worldLayoutRoute,
  path: "config",
  component: WorldConfigPage,
});
