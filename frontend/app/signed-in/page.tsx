"use client";
/** Google sign-in returns here with the session token in the URL fragment (never sent to any server). */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { setSessionToken } from "@/lib/api/session";
import { safeNext } from "@/lib/utils/url";
import { useAuthStore } from "@/stores/auth";
import { LoadingBlock } from "@/components/ui/states";

export default function SignedInPage() {
  const router = useRouter();
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const token = params.get("token");
    const next = safeNext(params.get("next"));
    window.history.replaceState(null, "", window.location.pathname); // remove the token from the address bar at once
    if (!token) return router.replace("/login?error=google_failed");
    setSessionToken(token);
    useAuthStore.setState({ status: "idle", user: null });
    void useAuthStore.getState().bootstrap().then(() => router.replace(next));
  }, [router]);
  return <LoadingBlock label="Signing you in…" className="h-dvh" />;
}
