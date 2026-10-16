import { API_BASE_URL, API_MODE } from "./config";
import { ApiError, parseApiError } from "./errors";
import { getSessionToken } from "./session";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type Query = Record<string, string | number | boolean | null | undefined>;

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
}

export interface Transport {
  request<T>(method: HttpMethod, path: string, opts?: RequestOptions): Promise<T>;
}

function buildQuery(query?: Query): string {
  if (!query) return "";
  const p = new URLSearchParams();
  Object.entries(query).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  });
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Real transport — talks to the Go backend through Next.js rewrites (same-origin httpOnly cookie). */
const httpTransport: Transport = {
  async request<T>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<T> {
    let res: Response;
    // Same address: the httpOnly cookie signs the request in. Another address (Firebase Hosting + API host): the Bearer token does.
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const token = getSessionToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      res = await fetch(`${API_BASE_URL}${path}${buildQuery(opts.query)}`, {
        method,
        credentials: "include",
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
      });
    } catch {
      throw new ApiError(0, "network_error", "Network request failed");
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (!res.ok) throw parseApiError(res.status, data);
    return data as T;
  },
};

/** Mock transport — routes the same method + path to the in-browser mock server (frontend/mock). */
const mockTransport: Transport = {
  async request<T>(method: HttpMethod, path: string, opts: RequestOptions = {}): Promise<T> {
    const { mockServer } = await import("@/mock/server");
    return mockServer.handle<T>(method, path, opts.query ?? {}, opts.body);
  },
};

const transport: Transport = API_MODE === "http" ? httpTransport : mockTransport;

export const apiClient = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => transport.request<T>("GET", path, { query, signal }),
  post: <T>(path: string, body?: unknown, query?: Query) => transport.request<T>("POST", path, { body, query }),
  put: <T>(path: string, body?: unknown) => transport.request<T>("PUT", path, { body }),
  patch: <T>(path: string, body?: unknown) => transport.request<T>("PATCH", path, { body }),
  delete: <T = void>(path: string) => transport.request<T>("DELETE", path),
};
