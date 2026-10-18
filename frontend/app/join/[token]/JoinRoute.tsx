"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { UsersThree } from "@phosphor-icons/react";
import { sharingApi } from "@/lib/api";
import { AuthGate } from "@/components/shell/AuthGate";
import { ErrorState, LoadingBlock } from "@/components/ui/states";
import { toast } from "@/lib/toast";
import { usePathIds } from "@/lib/utils/pathIds";

function Join({ token }: { token: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    sharingApi
      .join(token)
      .then((r) => {
        // The role may have changed (viewer → editor): drop cached workspace data so my_role comes from the server.
        void qc.invalidateQueries({ queryKey: ["graph", r.workspace_id] });
        void qc.invalidateQueries({ queryKey: ["workspaces"] });
        toast.success("You joined the workspace", { description: r.role === "viewer" ? "You can look at everything but not change it." : "You can add and edit pages." });
        router.replace(`/w/${r.workspace_id}`);
      })
      .catch(setError);
  }, [token, router, qc]);
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <UsersThree size={48} weight="duotone" className="mx-auto text-purple" />
      {error ? <ErrorState className="mt-6" error={error} title="This invite link does not work" /> : <LoadingBlock label="Joining workspace…" />}
    </div>
  );
}

export function JoinRoute() {
  const token = usePathIds()?.[1];
  return <AuthGate>{token ? <Join token={token} /> : null}</AuthGate>;
}
