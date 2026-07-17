import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createSpace,
  deleteSpace,
  getSpace,
  listSpaces,
  setSpacePassword,
  updateSpace,
} from "@/api";
import type {
  CreateSpaceInput,
  SetSpacePasswordInput,
  SpaceId,
  UpdateSpaceInput,
} from "@/types";

// Hooks are toast-free on purpose: components own success/error UX so the
// same hook is reusable across pages that surface errors differently. The
// api client already normalizes rejections to `ErrorPayload`; call sites
// should pipe `.catch`/`onError` through `translateError(toErrorPayload(e))`
// (see AGENTS.md §Error translation pipeline).

export const useSpaces = () =>
  useQuery({ queryKey: ["spaces"], queryFn: listSpaces });

export const useSpace = (id: SpaceId) =>
  useQuery({
    queryKey: ["spaces", id],
    queryFn: () => getSpace(id),
    enabled: !!id,
  });

export const useCreateSpace = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSpaceInput) => createSpace(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["spaces"] }),
  });
};

export const useUpdateSpace = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: SpaceId; input: UpdateSpaceInput }) =>
      updateSpace(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["spaces"] }),
  });
};

export const useDeleteSpace = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, password }: { id: SpaceId; password?: string }) =>
      deleteSpace(id, password),
    onSuccess: () => {
      // `deleteSpace` cascades server-side and auto-closes the Space's tab
      // (if open), so the session cache (open/active/locked tab list) must
      // be refreshed alongside the spaces list.
      qc.invalidateQueries({ queryKey: ["spaces"] });
      qc.invalidateQueries({ queryKey: ["session"] });
    },
  });
};

export const useSetSpacePassword = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: SpaceId;
      input: SetSpacePasswordInput;
    }) => setSpacePassword(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["spaces"] }),
  });
};
