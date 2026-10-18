import type { CreateNodeRequest, NodePositionsRequest, ResearchNode, UpdateNodeRequest } from "@/types/api";
import { apiClient } from "./client";

export const nodeApi = {
  create: (body: CreateNodeRequest) => apiClient.post<ResearchNode>("/nodes", body),
  /** Returns 409 + latest node when `version` is stale (§17.1). */
  update: (id: string, body: UpdateNodeRequest) => apiClient.patch<ResearchNode>(`/nodes/${id}`, body),
  remove: (id: string) => apiClient.delete(`/nodes/${id}`),
  /** (frontend addition) restore a soft-deleted node, powers Undo. */
  restore: (id: string) => apiClient.post<ResearchNode>(`/nodes/${id}/restore`),
  savePositions: (body: NodePositionsRequest) => apiClient.post<void>("/nodes/positions", body),
  /** (frontend addition) F26 one-click duplicate merge. */
  mergeDuplicate: (id: string, intoId: string) =>
    apiClient.post<ResearchNode>(`/nodes/${id}/merge`, { into_node_id: intoId }),
};
