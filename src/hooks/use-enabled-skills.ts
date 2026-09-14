import { useQuery } from "@tanstack/react-query";

import { LOOP_ROLE_NAMES } from "@/lib/ai-roles";
import { listEnabledSkills } from "@/api/skill";
import type { EnabledSkill, SpaceId } from "@/types";

/**
 * Enablement read for one agent role (ADR-0043 §2).
 *
 * `list_enabled_skills` returns the catalog entries built from the agent's
 * INSTALLED (on-disk) skill copies — the runtime truth — which is exactly
 * the state a per-skill Switch should reflect.
 *
 * The query key is nested UNDER the storage-center's `["skills", spaceId]`
 * namespace (see `skillsKeys.list` in `./use-skills`) on purpose: the
 * upload / delete / toggle mutations invalidate that prefix, and TanStack
 * Query's prefix matching then refreshes every role's enablement view —
 * no extra invalidation wiring needed at call sites.
 */
export const enabledSkillsKey = (
  spaceId: SpaceId,
  agentConfigName: string,
) => ["skills", spaceId, "enabled", agentConfigName] as const;

export const useEnabledSkills = (
  spaceId: SpaceId,
  agentConfigName: string,
  enabled = true,
) =>
  useQuery({
    queryKey: enabledSkillsKey(spaceId, agentConfigName),
    queryFn: () => listEnabledSkills(spaceId, agentConfigName),
    enabled: enabled && !!spaceId,
  });

/**
 * Enablement read for EVERY loop role (orchestrator + the 8 subagents,
 * ADR-0050) in ONE query — the registry-driven Provider resolves any role
 * by name from this map, so it must not fan out one hook per role.
 *
 * The key stays nested under the same `["skills", spaceId]` namespace, so
 * the storage-center's toggle mutations invalidate it by prefix exactly
 * like the per-role queries. The one-shot roles (namer/vision) never
 * carry skills and are excluded.
 */
export const allRolesEnabledSkillsKey = (spaceId: SpaceId) =>
  ["skills", spaceId, "enabled", "all-roles"] as const;

export function useAllRolesEnabledSkills(spaceId: SpaceId) {
  return useQuery({
    queryKey: allRolesEnabledSkillsKey(spaceId),
    queryFn: async () => {
      const entries = await Promise.all(
        LOOP_ROLE_NAMES.map(
          async (name) =>
            [name, await listEnabledSkills(spaceId, name)] as const,
        ),
      );
      return Object.fromEntries(entries) as Record<string, EnabledSkill[]>;
    },
    enabled: !!spaceId,
  });
}
