import type { SessionReport } from "@/types/api";
import { apiClient } from "./client";

export const reportApi = {
  generate: (sessionId: string) => apiClient.post<SessionReport>(`/sessions/${sessionId}/report`),
  get: (sessionId: string) => apiClient.get<SessionReport>(`/sessions/${sessionId}/report`),
};
