import type { Conflict, MethodologyResponse, UpdateConflictRequest } from "@/types/api";
import { apiClient } from "./client";

export const conflictApi = {
  list: (workspaceId: string) => apiClient.get<Conflict[]>(`/workspaces/${workspaceId}/conflicts`),
  update: (id: string, body: UpdateConflictRequest) => apiClient.patch<Conflict>(`/conflicts/${id}`, body),
  methodology: (id: string) => apiClient.post<MethodologyResponse>(`/conflicts/${id}/methodology`),
};
