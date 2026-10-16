import type { ApiErrorBody, ApiErrorCode } from "@/types/api";

/** Error thrown by every API call. Parsed from `{"error":{"code","message"}}` (§17.1). */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, code: ApiErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiErrorBody(v: unknown): v is ApiErrorBody {
  return (
    typeof v === "object" &&
    v !== null &&
    "error" in v &&
    typeof (v as ApiErrorBody).error?.code === "string"
  );
}

const STATUS_TO_CODE: Record<number, ApiErrorCode> = {
  400: "bad_request",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  422: "validation_failed",
  429: "rate_limited",
  503: "ai_unavailable",
};

export function parseApiError(status: number, body: unknown): ApiError {
  if (isApiErrorBody(body)) {
    return new ApiError(status, body.error.code, body.error.message, body.error.details);
  }
  return new ApiError(status, STATUS_TO_CODE[status] ?? "internal", "Something went wrong. Please try again.");
}

/** User-facing copy. Never exposes stack traces or raw server errors. */
export function friendlyError(err: unknown): { title: string; message: string } {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "network_error":
        return { title: "Connection lost", message: "We could not reach the server. Check your connection and retry." };
      case "unauthorized":
        return { title: "Session expired", message: "Please sign in again to continue." };
      case "forbidden":
        return { title: "No permission", message: err.message || "You do not have access to do this." };
      case "not_found":
        return { title: "Not found", message: err.message };
      case "conflict":
        return { title: "Updated by someone else", message: err.message };
      case "rate_limited":
        return { title: "Slow down a little", message: "Too many requests. Trying again shortly." };
      case "ai_unavailable":
        return { title: "AI unavailable", message: "The AI service is busy. Your data is safe; results will arrive later." };
      default:
        return { title: "Something went wrong", message: err.message || "Please try again." };
    }
  }
  return { title: "Something went wrong", message: "Please try again." };
}
