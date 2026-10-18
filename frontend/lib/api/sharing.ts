import type {
  Branch,
  BranchCompare,
  CreateShareLinkRequest,
  JoinResponse,
  MergeResponse,
  Role,
  ShareLink,
  WorkspaceMember,
} from "@/types/api";
import { apiClient } from "./client";

export const sharingApi = {
  members: (workspaceId: string) => apiClient.get<WorkspaceMember[]>(`/workspaces/${workspaceId}/members`),
  /** (frontend addition) list existing links so the owner can disable them */
  shareLinks: (workspaceId: string) => apiClient.get<ShareLink[]>(`/workspaces/${workspaceId}/share-links`),
  createShareLink: (workspaceId: string, body: CreateShareLinkRequest) =>
    apiClient.post<ShareLink>(`/workspaces/${workspaceId}/share-links`, body),
  disableShareLink: (workspaceId: string, linkId: string) =>
    apiClient.delete(`/workspaces/${workspaceId}/share-links/${linkId}`),
  join: (token: string) => apiClient.post<JoinResponse>(`/join/${token}`),
  updateMember: (workspaceId: string, userId: string, role: Role) =>
    apiClient.patch<WorkspaceMember>(`/workspaces/${workspaceId}/members/${userId}`, { role }),
  removeMember: (workspaceId: string, userId: string) =>
    apiClient.delete(`/workspaces/${workspaceId}/members/${userId}`),
};

export const branchApi = {
  list: (workspaceId: string) => apiClient.get<Branch[]>(`/workspaces/${workspaceId}/branches`),
  create: (workspaceId: string, name: string) => apiClient.post<Branch>(`/workspaces/${workspaceId}/branches`, { name }),
  compare: (workspaceId: string, a: string, b: string) =>
    apiClient.get<BranchCompare>(`/workspaces/${workspaceId}/branches/compare`, { a, b }),
  merge: (branchId: string, nodeIds: string[]) =>
    apiClient.post<MergeResponse>(`/branches/${branchId}/merge`, { node_ids: nodeIds }),
};
