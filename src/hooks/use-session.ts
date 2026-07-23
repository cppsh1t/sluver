import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getSession,
  lockAllProtectedSpaces,
  lockSpace,
  openSpace,
  openSpaceWindow,
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

/**
 * Open a Space in its own OS window (ADR-0011). This is the ONLY correct
 * way to present a Space to the user from the frontend. It composes two
 * IPC calls that must always travel together:
 *
 *   1. `openSpace(id, password)` — sets `lastOpenedSpaceId`, opens (and
 *      unlocks, verifying the password via argon2id per ADR-0008) the
 *      `space.db` connection. Returns the fresh `SessionState`.
 *   2. `openSpaceWindow(id)` — creates or focuses the native window whose
 *      label is `space-{id}`. The label is the single source of truth for
 *      window→Space ownership (used by the tray menu and the
 *      single-instance check in `ensure_space_window`).
 *
 * The `['session']` React Query cache is updated in a single hop on
 * success, mirroring `useOpenSpace`.
 *
 * DO NOT bypass this hook by calling `navigate({ to: '/space/$spaceId' })`
 * to switch an existing window's content. A Tauri window's label is fixed
 * at creation; changing the URL path without creating a new window orphans
 * the label from the tray and the single-instance check — `CreateSpaceDialog`
 * once had this bug (see ADR-0011 "Implementation notes" corollary).
 *
 * Use `useOpenSpace` (this hook without the window step) only when a
 * window for the Space already exists and you are just (re)unlocking its
 * session — e.g. the in-window password gate (`SpacePasswordGate`).
 */
export const useOpenSpaceInWindow = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      password,
    }: {
      id: SpaceId;
      password?: string;
    }) => {
      const next = await openSpace(id, password);
      await openSpaceWindow(id);
      return next;
    },
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
