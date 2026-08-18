import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteSkill,
  listSkills,
  setSkillEnabled,
  uploadSkill,
} from "@/api/skill";
import type { SkillId, SpaceId } from "@/types";

// Hooks are toast-free on purpose: components own success/error UX so the
// same hook is reusable across pages that surface errors differently. The
// api client already normalizes rejections to `ErrorPayload`; call sites
// should pipe `.catch`/`onError` through `translateError(toErrorPayload(e))`
// (see AGENTS.md §Error translation pipeline).

// ─── Query key factory ──────────────────────────────────────────────────────

/**
 * Query keys for the skill storage-center surface. Each Space gets its own
 * key namespace so cache invalidation can be scoped precisely.
 *
 * NOTE: the per-role enabled-skills read lives in `./use-enabled-skills`
 * (keyed UNDER this `["skills", spaceId]` prefix so the mutations below
 * refresh it via prefix matching) — keep that nesting intact.
 */
export const skillsKeys = {
  list: (spaceId: SpaceId) => ["skills", spaceId] as const,
};

// ─── Skills (storage center) ────────────────────────────────────────────────

export const useSkills = (spaceId: SpaceId) =>
  useQuery({
    queryKey: skillsKeys.list(spaceId),
    queryFn: () => listSkills(spaceId),
    enabled: !!spaceId,
  });

export const useUploadSkill = (spaceId: SpaceId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (packageBase64: string) => uploadSkill(spaceId, packageBase64),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillsKeys.list(spaceId) }),
  });
};

export const useDeleteSkill = (spaceId: SpaceId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (skillId: SkillId) => deleteSkill(spaceId, skillId),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillsKeys.list(spaceId) }),
  });
};

export const useSetSkillEnabled = (spaceId: SpaceId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      agentConfigId,
      skillId,
      enabled,
    }: {
      agentConfigId: string;
      skillId: SkillId;
      enabled: boolean;
    }) => setSkillEnabled(spaceId, agentConfigId, skillId, enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: skillsKeys.list(spaceId) }),
  });
};
