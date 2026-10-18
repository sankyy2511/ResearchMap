import type {
  Category,
  CreateCategoryRequest,
  CreateTagRequest,
  ResearchNode,
  Tag,
  UpdateCategoryRequest,
} from "@/types/api";
import { apiClient } from "./client";

export const tagApi = {
  list: (workspaceId: string) => apiClient.get<Tag[]>(`/workspaces/${workspaceId}/tags`),
  create: (workspaceId: string, body: CreateTagRequest) => apiClient.post<Tag>(`/workspaces/${workspaceId}/tags`, body),
  setNodeTags: (nodeId: string, tagIds: string[]) =>
    apiClient.put<ResearchNode>(`/nodes/${nodeId}/tags`, { tag_ids: tagIds }),
};

export const categoryApi = {
  list: (workspaceId: string) => apiClient.get<Category[]>(`/workspaces/${workspaceId}/categories`),
  create: (workspaceId: string, body: CreateCategoryRequest) =>
    apiClient.post<Category>(`/workspaces/${workspaceId}/categories`, body),
  /** (frontend addition) rename / recolour */
  update: (id: string, body: UpdateCategoryRequest) => apiClient.patch<Category>(`/categories/${id}`, body),
};
