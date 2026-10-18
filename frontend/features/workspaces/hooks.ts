"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateWorkspaceRequest, ImportRequest, UpdateWorkspaceRequest, Workspace } from "@/types/api";
import { exportApi, workspaceApi } from "@/lib/api";
import { toast } from "@/lib/toast";

export const qk = {
  workspaces: ["workspaces"] as const,
  sessions: (ws: string) => ["sessions", ws] as const,
  radar: (ws: string) => ["radar", ws] as const,
  conflicts: (ws: string) => ["conflicts", ws] as const,
  journey: (ws: string, s?: string) => ["journey", ws, s ?? "all"] as const,
  stats: (s: string) => ["stats", s] as const,
  refs: (s: string) => ["refs", s] as const,
  report: (s: string) => ["report", s] as const,
  members: (ws: string) => ["members", ws] as const,
  links: (ws: string) => ["links", ws] as const,
};

export function useWorkspaces() {
  return useQuery({ queryKey: qk.workspaces, queryFn: workspaceApi.list });
}

export function useCreateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: CreateWorkspaceRequest) => workspaceApi.create(b),
    onSuccess: (w) => {
      qc.setQueryData<Workspace[]>(qk.workspaces, (old) => [w, ...(old ?? [])]);
      toast.success("Workspace created", { description: w.title });
    },
    onError: (e) => toast.apiError(e),
  });
}

export function useUpdateWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateWorkspaceRequest }) => workspaceApi.update(id, body),
    onSuccess: (w) => {
      qc.setQueryData<Workspace[]>(qk.workspaces, (old) => old?.map((x) => (x.id === w.id ? w : x)));
      toast.success("Changes saved");
    },
    onError: (e) => toast.apiError(e),
  });
}

export function useDeleteWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => workspaceApi.remove(id),
    onMutate: async (id) => {
      const prev = qc.getQueryData<Workspace[]>(qk.workspaces);
      qc.setQueryData<Workspace[]>(qk.workspaces, (old) => old?.filter((w) => w.id !== id));
      return { prev };
    },
    onSuccess: () => toast.success("Workspace deleted"),
    onError: (e, _id, ctx) => {
      qc.setQueryData(qk.workspaces, ctx?.prev);
      toast.apiError(e);
    },
  });
}

export function useImportWorkspace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: ImportRequest) => exportApi.import(b),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.workspaces });
      toast.success("Import complete", { description: `${r.nodes_imported} links imported` });
    },
    onError: (e) => toast.apiError(e),
  });
}
