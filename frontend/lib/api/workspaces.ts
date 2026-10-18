import type {
  BranchView,
  CreateWorkspaceRequest,
  GraphResponse,
  ReorganizeResponse,
  UpdateWorkspaceRequest,
  ViewState,
  Workspace,
} from "@/types/api";
import { apiClient } from "./client";

export const workspaceApi = {
  list: () => apiClient.get<Workspace[]>("/workspaces"),
  get: (id: string) => apiClient.get<Workspace>(`/workspaces/${id}`),
  create: (body: CreateWorkspaceRequest) => apiClient.post<Workspace>("/workspaces", body),
  update: (id: string, body: UpdateWorkspaceRequest) => apiClient.patch<Workspace>(`/workspaces/${id}`, body),
  remove: (id: string) => apiClient.delete(`/workspaces/${id}`),
  /** All nodes, edges, tags, categories for the chosen branch view. */
  getGraph: (id: string, branch: BranchView = "main,mine") =>
    apiClient.get<GraphResponse>(`/workspaces/${id}/graph`, { branch }),
  saveViewState: (id: string, state: ViewState) => apiClient.put<void>(`/workspaces/${id}/view-state`, state),
  reorganize: (id: string) => apiClient.post<ReorganizeResponse>(`/workspaces/${id}/reorganize`),
  /** (frontend addition) one-step undo of the last re-organize (§14.5). */
  undoReorganize: (id: string, undoToken: string) =>
    apiClient.post<void>(`/workspaces/${id}/reorganize/undo`, { undo_token: undoToken }),
};
