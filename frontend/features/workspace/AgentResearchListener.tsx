"use client";
/**
 * User-level WebSocket (no workspace_id): when an AI assistant calls the MCP `start_research` tool, the backend
 * announces the workspace here and we open it, so the assistant's nodes appear live while it researches.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import type { Workspace } from "@/types/api";
import { API_MODE } from "@/lib/api/config";
import { connectWorkspaceSocket } from "@/lib/ws/socket";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/stores/auth";
import { qk } from "@/features/workspaces/hooks";

export function AgentResearchListener() {
  const userId = useAuthStore((s) => s.user?.id);
  const router = useRouter();
  const qc = useQueryClient();

  useEffect(() => {
    if (!userId || API_MODE !== "http") return;
    const socket = connectWorkspaceSocket("", {
      onStatus: () => undefined,
      onMessage: (msg) => {
        if (msg.type !== "mcp.research_started") return;
        const { workspace, created, topic, client } = msg.data;
        qc.setQueryData<Workspace[]>(qk.workspaces, (old) => (old ? [workspace, ...old.filter((w) => w.id !== workspace.id)] : old));
        void qc.invalidateQueries({ queryKey: qk.workspaces });
        toast.info(`${client} ${created ? "started researching" : "is researching"}`, { description: topic });
        if (window.location.pathname !== `/w/${workspace.id}`) router.push(`/w/${workspace.id}`);
      },
    });
    return () => socket.close();
  }, [userId, router, qc]);

  return null;
}
