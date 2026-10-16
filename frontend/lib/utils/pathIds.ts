"use client";
import { useMemo, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

const subscribe = (onChange: () => void) => {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
};

/**
 * The IDs in the current address, for example /w/<workspaceId>/report/<sessionId>.
 * On static hosting (Firebase) one pre-built page serves every such address, so the route params Next.js
 * knows are placeholders; the real values are read from the address bar. Null while the page is pre-built.
 */
export function usePathIds(): string[] | null {
  usePathname(); // re-read after in-app navigation
  const path = useSyncExternalStore(subscribe, () => window.location.pathname, () => null);
  return useMemo(() => (path === null ? null : path.split("/").filter(Boolean).map((p) => decodeURIComponent(p))), [path]);
}
