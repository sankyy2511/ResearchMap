import type {
  Annotation,
  CaptureHighlightRequest,
  CapturePageRequest,
  CapturePageResponse,
  CaptureSearchRequest,
  CaptureSearchResponse,
  CaptureVisitsRequest,
  PagePreview,
} from "@/types/api";
import { apiClient } from "./client";

/** Endpoints normally called by the Chrome extension (§12). The web app uses them for manual "Add page". */
export const captureApi = {
  page: (body: CapturePageRequest) => apiClient.post<CapturePageResponse>("/capture/page", body),
  search: (body: CaptureSearchRequest) => apiClient.post<CaptureSearchResponse>("/capture/search", body),
  visits: (body: CaptureVisitsRequest) => apiClient.post<{ accepted: number }>("/capture/visits", body),
  highlight: (body: CaptureHighlightRequest) => apiClient.post<Annotation>("/capture/highlight", body),
};

export const pageApi = {
  getPreview: (pageId: string) => apiClient.get<PagePreview>(`/pages/${pageId}/preview`),
  putPreview: (pageId: string, image: string) => apiClient.put<PagePreview>(`/pages/${pageId}/preview`, { image }),
};
