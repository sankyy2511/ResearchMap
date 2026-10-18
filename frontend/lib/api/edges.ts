import type { CreateEdgeRequest, ResearchEdge, UpdateEdgeRequest } from "@/types/api";
import { apiClient } from "./client";

export const edgeApi = {
  create: (body: CreateEdgeRequest) => apiClient.post<ResearchEdge>("/edges", body),
  /** Accept / reject / change relation / edit reason. Any user action locks the edge. */
  update: (id: string, body: UpdateEdgeRequest) => apiClient.patch<ResearchEdge>(`/edges/${id}`, body),
  remove: (id: string) => apiClient.delete(`/edges/${id}`),
};
