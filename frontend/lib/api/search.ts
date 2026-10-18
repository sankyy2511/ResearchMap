import type { SearchFilters, SearchResponse } from "@/types/api";
import { apiClient } from "./client";

export const searchApi = {
  search: (workspaceId: string, q: string, filters: SearchFilters = {}, signal?: AbortSignal) =>
    apiClient.get<SearchResponse>(
      `/workspaces/${workspaceId}/search`,
      { q, filters: Object.keys(filters).length ? JSON.stringify(filters) : undefined },
      signal,
    ),
};
