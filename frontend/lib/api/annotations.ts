import type { Annotation, CreateAnnotationRequest, UpdateAnnotationRequest } from "@/types/api";
import { apiClient } from "./client";

export const annotationApi = {
  create: (nodeId: string, body: CreateAnnotationRequest) =>
    apiClient.post<Annotation>(`/nodes/${nodeId}/annotations`, body),
  update: (id: string, body: UpdateAnnotationRequest) => apiClient.patch<Annotation>(`/annotations/${id}`, body),
  remove: (id: string) => apiClient.delete(`/annotations/${id}`),
};
