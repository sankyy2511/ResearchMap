import type { GoalCheck, JourneyResponse, ReferenceFormat, ReferencesResponse, Session, SessionStats } from "@/types/api";
import { apiClient } from "./client";

export const sessionApi = {
  /** goal: what the user wants to finish in this session ("" = no goal). */
  start: (workspaceId: string, goal?: string) => apiClient.post<Session>(`/workspaces/${workspaceId}/sessions/start`, goal === undefined ? undefined : { goal }),
  setGoal: (sessionId: string, goal: string) => apiClient.put<Session>(`/sessions/${sessionId}/goal`, { goal }),
  goalChecks: (sessionId: string) => apiClient.get<GoalCheck[]>(`/sessions/${sessionId}/goal-checks`),
  stop: (sessionId: string, openTabs: string[] = []) =>
    apiClient.post<Session>(`/sessions/${sessionId}/stop`, { open_tabs: openTabs }),
  /** (frontend addition) pause / resume, matches extension shortcut Alt+Shift+P */
  pause: (sessionId: string) => apiClient.post<Session>(`/sessions/${sessionId}/pause`),
  resume: (sessionId: string) => apiClient.post<Session>(`/sessions/${sessionId}/resume`),
  list: (workspaceId: string) => apiClient.get<Session[]>(`/workspaces/${workspaceId}/sessions`),
  stats: (sessionId: string) => apiClient.get<SessionStats>(`/sessions/${sessionId}/stats`),
  references: (sessionId: string, format: ReferenceFormat = "json") =>
    apiClient.get<ReferencesResponse>(`/sessions/${sessionId}/references`, { format }),
  journey: (workspaceId: string, sessionId?: string) =>
    apiClient.get<JourneyResponse>(`/workspaces/${workspaceId}/journey`, { session: sessionId }),
};
