import type { ExportFormat, ExportResponse, ImportRequest, ImportResponse } from "@/types/api";
import { apiClient } from "./client";

export const exportApi = {
  export: (workspaceId: string, format: ExportFormat) =>
    apiClient.get<ExportResponse>(`/workspaces/${workspaceId}/export`, { format }),
  import: (body: ImportRequest) => apiClient.post<ImportResponse>("/workspaces/import", body),
};
