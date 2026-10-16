/**
 * Mock WebSocket hub: an in-memory "room" per workspace, like the Go hub (§9.3).
 * The mock socket (lib/ws) subscribes here; mock handlers publish after every write.
 */
import type { WsClientMessage, WsServerMessage } from "@/types/api";

type Listener = (msg: WsServerMessage) => void;
type ClientListener = (workspaceId: string, msg: WsClientMessage) => void;

const rooms = new Map<string, Set<Listener>>();
const clientListeners = new Set<ClientListener>();

export const mockBus = {
  subscribe(workspaceId: string, fn: Listener): () => void {
    if (!rooms.has(workspaceId)) rooms.set(workspaceId, new Set());
    rooms.get(workspaceId)!.add(fn);
    return () => rooms.get(workspaceId)?.delete(fn);
  },
  publish(msg: WsServerMessage) {
    const listeners = rooms.get(msg.workspace_id);
    if (!listeners) return;
    // Deliver asynchronously and cloned, like a real network message.
    const payload = JSON.stringify(msg);
    setTimeout(() => listeners.forEach((l) => l(JSON.parse(payload) as WsServerMessage)), 0);
  },
  /** client → server messages (presence.update, node.moving) */
  sendFromClient(workspaceId: string, msg: WsClientMessage) {
    clientListeners.forEach((l) => l(workspaceId, msg));
  },
  onClientMessage(fn: ClientListener): () => void {
    clientListeners.add(fn);
    return () => clientListeners.delete(fn);
  },
  hasListeners(workspaceId: string) {
    return (rooms.get(workspaceId)?.size ?? 0) > 0;
  },
};
