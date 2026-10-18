"use client";
/** Protected-route wrapper: bootstraps GET /me, redirects to /login when unauthenticated. */
import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import { ErrorState, LoadingBlock } from "@/components/ui/states";
import { Logo } from "./Logo";

export function AuthGate({ children }: { children: ReactNode }) {
  const { status, bootstrap, error } = useAuthStore();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (status === "unauthenticated") router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);

  if (status === "authenticated") return <>{children}</>;
  if (status === "error")
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        <ErrorState error={error} title="API unavailable" onRetry={() => { useAuthStore.setState({ status: "idle" }); void bootstrap(); }} />
      </div>
    );
  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="flex flex-col items-center gap-4">
        <Logo />
        <LoadingBlock label="Loading your workspace…" />
      </div>
    </div>
  );
}
