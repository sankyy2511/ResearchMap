"use client";
/**
 * Loads a workspace (graph + signals + session), connects the WebSocket and wires every
 * server event into the stores. Also persists the view state for exact resume (§F3).
 */
import { useEffect, useRef } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { GraphResponse, Session, WsClientMessage, WsServerMessage } from "@/types/api";
import { conflictApi, workspaceApi } from "@/lib/api";
import { debounce } from "@/lib/utils/debounce";
import { connectWorkspaceSocket, type WorkspaceSocket } from "@/lib/ws/socket";
import { toast } from "@/lib/toast";
import { browsingSimulator } from "@/lib/extension/simulator";
import { API_MODE } from "@/lib/api/config";
import { connectExtension, extensionBridge } from "@/lib/extension/bridge";
import { useGraphStore } from "@/stores/graph";
import { useUiStore } from "@/stores/ui";
import { useSessionStore } from "@/stores/session";
import { useCollabStore, useSignalsStore } from "@/stores/collab";
import { useAuthStore } from "@/stores/auth";
import { qk } from "@/features/workspaces/hooks";

/**
 * Keeps the cached GET /graph (staleTime Infinity) and the workspace list in step with the tracking session.
 * Without this, a remount after Stop (e.g. Report → back) re-hydrated the stale `active_session` and
 * restarted tracking in the UI and the extension.
 */
export function syncCachedSession(qc: QueryClient, workspaceId: string, session: Session | null) {
  qc.setQueriesData<GraphResponse>({ queryKey: ["graph", workspaceId] }, (g) => (g ? { ...g, workspace: { ...g.workspace, active_session: session } } : g));
  void qc.invalidateQueries({ queryKey: qk.workspaces });
}

let socket: WorkspaceSocket | null = null;
export function sendSocket(msg: WsClientMessage) {
  socket?.send(msg);
}

export function useWorkspace(workspaceId: string) {
  const branch = useUiStore((s) => s.branch);
  const qc = useQueryClient();
  const restored = useRef<string | null>(null);
  const shownNodes = useRef<unknown>(null);

  // Live changes arrive over the WebSocket, so this copy gets old: load it fresh every time the workspace opens.
  const graph = useQuery({
    queryKey: ["graph", workspaceId, branch],
    queryFn: () => workspaceApi.getGraph(workspaceId, branch),
    staleTime: 0,
  });

  // Hydrate stores from GET /graph
  useEffect(() => {
    if (!graph.data) return;
    // Redraw only for newly loaded data. syncCachedSession changes just the session in this copy;
    // redrawing then would bring back an old map and drop everything added live.
    if (graph.data.nodes !== shownNodes.current) {
      shownNodes.current = graph.data.nodes;
      useGraphStore.getState().hydrate(graph.data);
    }
    if (restored.current !== workspaceId) {
      restored.current = workspaceId;
      const vs = graph.data.view_state;
      useUiStore.getState().restore(vs);
      if (vs && vs.branch !== branch) useUiStore.getState().setBranch(vs.branch);
      const active = graph.data.workspace.active_session;
      useSessionStore.getState().setSession(active);
      if (API_MODE === "mock" && active?.state === "active" && !browsingSimulator.isRunning(workspaceId)) browsingSimulator.start(workspaceId, active.id);
      if (API_MODE === "http") void connectExtension().then((ok) => ok && active && active.state !== "stopped" && extensionBridge.startTracking(workspaceId, active.id, false, active.goal));
      const params = new URLSearchParams(window.location.search);
      // A workspace that was just created (?start=1): ask about the goal right away.
      if (params.get("start") && !active && graph.data.workspace.my_role !== "viewer") {
        useUiStore.getState().setDialog("goal-ask");
        params.delete("start");
        window.history.replaceState(null, "", window.location.pathname + (params.size ? `?${params}` : ""));
      }
      const jumpTo = params.get("node");
      if (jumpTo) {
        useUiStore.getState().setViewMode("graph");
        useUiStore.getState().selectNode(jumpTo);
        setTimeout(() => useUiStore.getState().requestFocus(jumpTo), 400);
      }
    }
  }, [graph.data, workspaceId, branch]);

  // Signals
  const conflicts = useQuery({ queryKey: qk.conflicts(workspaceId), queryFn: () => conflictApi.list(workspaceId) });
  useEffect(() => void (conflicts.data && useSignalsStore.getState().setConflicts(conflicts.data)), [conflicts.data]);

  // WebSocket
  useEffect(() => {
    const myId = () => useAuthStore.getState().user?.id;
    const onMessage = (msg: WsServerMessage) => {
      useGraphStore.getState().applyMessage(msg);
      switch (msg.type) {
        case "job.status":
          useSessionStore.getState().pushJob(msg.data);
          if (msg.data.kind === "report") void qc.invalidateQueries({ queryKey: ["report"] });
          break;
        case "goal.checked":
          void qc.invalidateQueries({ queryKey: ["goal-checks", msg.data.session_id] });
          break;
        case "presence":
          useCollabStore.getState().setPresence(msg.data.users);
          break;
        case "session.updated":
          if (msg.data.user_id === myId()) {
            const s = msg.data.state === "stopped" ? null : msg.data;
            useSessionStore.getState().setSession(s);
            syncCachedSession(qc, workspaceId, s);
          }
          void qc.invalidateQueries({ queryKey: qk.sessions(workspaceId) });
          void qc.invalidateQueries({ queryKey: ["journey", workspaceId] }); // new visit times arrived
          break;
        case "conflict.detected":
          useSignalsStore.getState().upsertConflict(msg.data);
          toast.warning("Potential conflict detected", {
            description: msg.data.analysis.topic,
            action: { label: "Review", onClick: () => useUiStore.getState().openPanel("conflicts") },
          });
          void qc.invalidateQueries({ queryKey: qk.conflicts(workspaceId) });
          break;
        case "conflict.updated":
          useSignalsStore.getState().upsertConflict(msg.data);
          break;
        case "annotation.created":
          if (msg.by && msg.by !== myId() && msg.data.kind === "comment") {
            toast.info(`${msg.data.author_name} commented`, {
              description: msg.data.body,
              action: { label: "View", onClick: () => { useUiStore.getState().selectNode(msg.data.node_id); useUiStore.getState().requestFocus(msg.data.node_id); } },
            });
          }
          break;
        case "node.created":
          if (msg.data.type === "page" && msg.data.created_via !== "manual") void qc.invalidateQueries({ queryKey: ["journey", workspaceId] });
          break;
      }
    };
    socket = connectWorkspaceSocket(workspaceId, {
      onMessage,
      onStatus: (s) => {
        useCollabStore.getState().setSocketStatus(s);
        // Resync on every (re)connect: the hub drops frames for disconnected/slow clients and does not replay events
        // sent before this socket joined (e.g. an AI assistant adding sources right after the workspace opened).
        if (s === "open") void qc.invalidateQueries({ queryKey: ["graph", workspaceId] });
      },
    });
    return () => {
      socket?.close();
      socket = null;
    };
  }, [workspaceId, qc]);

  // Presence: broadcast my selection
  useEffect(
    () =>
      useUiStore.subscribe((s, prev) => {
        if (s.selectedNodeId !== prev.selectedNodeId) sendSocket({ type: "presence.update", data: { selected_node_id: s.selectedNodeId } });
      }),
    [],
  );

  // Persist view state (debounced)
  useEffect(() => {
    const save = debounce(() => {
      if (!useGraphStore.getState().loaded) return;
      void workspaceApi.saveViewState(workspaceId, useUiStore.getState().snapshot()).catch(() => undefined);
    }, 800);
    const unsub = useUiStore.subscribe((s, p) => {
      if (
        s.viewport !== p.viewport || s.viewMode !== p.viewMode || s.panel !== p.panel || s.selectedNodeId !== p.selectedNodeId ||
        s.branch !== p.branch || s.filters !== p.filters || s.colorBy !== p.colorBy || s.focusNodeId !== p.focusNodeId
      )
        save();
    });
    return () => {
      unsub();
      save.cancel();
    };
  }, [workspaceId]);

  // Cleanup on leave
  useEffect(
    () => () => {
      browsingSimulator.stop();
      useGraphStore.getState().reset();
      useSessionStore.getState().setSession(null);
      useSessionStore.getState().clearJobs();
      useCollabStore.getState().setPresence([]);
      useSignalsStore.setState({ conflicts: [], radar: null });
      useUiStore.getState().reset();
      restored.current = null;
      shownNodes.current = null; // the stores are empty again, so the cached graph must be drawn again
    },
    [workspaceId],
  );

  return graph;
}
