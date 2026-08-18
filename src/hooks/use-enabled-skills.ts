import { useQuery } from "@tanstack/react-query";

import { listEnabledSkills } from "@/api/skill";
import type { SpaceId } from "@/types";

/**
 * Enablement read for one agent role (ADR-0043 §2).
 *
 * `list_enabled_skills` returns the catalog entries built from the agent's
 * INSTALLED (on-disk) skill copies — the runtime truth — which is exactly the
 * state a per-skill Switch should reflect.
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
