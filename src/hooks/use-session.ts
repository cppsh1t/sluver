import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  closeSpace,
  getSession,
  lockAllProtectedSpaces,
  lockSpace,
  openSpace,
  setActiveSpace,
} from "@/api";
import type { SpaceId } from "@/types";

// Hooks are toast-free on purpose: components own success/error UX so the
// same hook is reusable across pages. The api client normalizes rejections
// to `ErrorPayload`; call sites should pipe `.catch`/`onError` through
// `translateError(toErrorPayload(e))` (see AGENTS.md §Error translation
// pipeline).
//
// Every session mutation returns the fresh `SessionState`, so on success we
// `setQueryData(['session'], next)` — a single-hop cache update with no
// refetch round-trip. This is the pattern the api layer was designed for.

const SESSION_KEY = ["session"] as const;

export const useSession = () =>
  useQuery({ queryKey: SESSION_KEY, queryFn: getSession });

export const useOpenSpace = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, password }: { id: SpaceId; password?: string }) =>
      openSpace(id, password),
    onSuccess: (next) => qc.setQueryData(SESSION_KEY, next),
  });
};

export const useCloseSpace = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: SpaceId) => closeSpace(id),
    onSuccess: (next) => qc.setQueryData(SESSION_KEY, next),
  });
};

export const useLockSpace = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: SpaceId) => lockSpace(id),
    onSuccess: (next) => qc.setQueryData(SESSION_KEY, next),
  });
};

export const useLockAllProtectedSpaces = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => lockAllProtectedSpaces(),
    onSuccess: (next) => qc.setQueryData(SESSION_KEY, next),
  });
};

export const useSetActiveSpace = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: SpaceId) => setActiveSpace(id),
    onSuccess: (next) => qc.setQueryData(SESSION_KEY, next),
  });
};
