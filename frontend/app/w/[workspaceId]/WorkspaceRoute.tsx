"use client";
import { AuthGate } from "@/components/shell/AuthGate";
import { WorkspaceScreen } from "@/features/workspace/WorkspaceScreen";
import { usePathIds } from "@/lib/utils/pathIds";

export function WorkspaceRoute() {
  const workspaceId = usePathIds()?.[1];
  return <AuthGate>{workspaceId ? <WorkspaceScreen key={workspaceId} workspaceId={workspaceId} /> : null}</AuthGate>;
}
