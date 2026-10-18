import type { ApiToken, AuthResponse, CreatedToken, LoginRequest, PendingSignup, RegisterRequest, TokenKind, User } from "@/types/api";
import { apiClient } from "./client";
import { setSessionToken } from "./session";

/** Keeps the session token from a sign-in answer (needed when the web app and the API are on different addresses). */
function keep<T extends object>(res: T): T {
  if ("token" in res) setSessionToken((res as { token?: string }).token);
  return res;
}

export const authApi = {
  options: () => apiClient.get<{ google: boolean; email_codes?: boolean }>("/auth/options"),
  // The server emails a code first; the mock backend signs in straight away.
  register: (body: RegisterRequest) => apiClient.post<AuthResponse | PendingSignup>("/auth/register", body).then(keep),
  verify: (email: string, code: string) => apiClient.post<AuthResponse>("/auth/verify", { email, code }).then(keep),
  resend: (email: string) => apiClient.post<{ sent: boolean }>("/auth/resend", { email }),
  forgot: (email: string) => apiClient.post<{ sent: boolean }>("/auth/forgot", { email }),
  reset: (email: string, code: string, password: string) => apiClient.post<AuthResponse>("/auth/reset", { email, code, password }).then(keep),
  login: (body: LoginRequest) => apiClient.post<AuthResponse>("/auth/login", body).then(keep),
  logout: () => apiClient.post<void>("/auth/logout").finally(() => setSessionToken(null)),
  me: () => apiClient.get<User>("/me"),
};

export const tokensApi = {
  list: () => apiClient.get<ApiToken[]>("/tokens"),
  create: (kind: TokenKind, name: string) => apiClient.post<CreatedToken>("/tokens", { kind, name }),
  revoke: (id: string) => apiClient.delete(`/tokens/${id}`),
};
