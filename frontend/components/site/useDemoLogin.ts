"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "@/stores/auth";
import { toast } from "@/lib/toast";

/** Logs in with the demo account and opens the workspaces. Falls back to the login page if that fails. */
export function useDemoLogin() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      const ok = await login({ email: "demo@researchmap.app", password: "demo1234" });
      if (ok) {
        toast.success("Welcome", { description: "Opening your workspaces." });
        router.push("/workspaces");
      } else {
        router.push("/login");
      }
    } catch {
      router.push("/login");
    } finally {
      setBusy(false);
    }
  };

  return { start, busy };
}
