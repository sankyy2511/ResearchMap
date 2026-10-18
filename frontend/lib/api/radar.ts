import type { RadarItem, RadarResponse, RadarSuggestionsResponse, UpdateRadarItemRequest } from "@/types/api";
import { apiClient } from "./client";

export const radarApi = {
  get: (workspaceId: string) => apiClient.get<RadarResponse>(`/workspaces/${workspaceId}/radar`),
  suggestions: (workspaceId: string, topicId: string) =>
    apiClient.post<RadarSuggestionsResponse>(`/workspaces/${workspaceId}/radar/${topicId}/suggestions`),
  /** (frontend addition) Review / Ignore a radar item */
  updateItem: (workspaceId: string, itemId: string, body: UpdateRadarItemRequest) =>
    apiClient.patch<RadarItem>(`/workspaces/${workspaceId}/radar/items/${itemId}`, body),
};
