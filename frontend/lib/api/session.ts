/**
 * The session token from sign-in. The web app may be hosted on another address than the API (Firebase Hosting and
 * a separate API host), where browsers block the API's cookie, so the token is kept here and sent as "Authorization: Bearer".
 */
const KEY = "rm_session";

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setSessionToken(token: string | null | undefined) {
  try {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the cookie still works when the API is on the same address */
  }
}
