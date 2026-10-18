/**
 * WebSocket abstraction (§17.2). The UI only sees `WorkspaceSocket`; whether messages come
 * from the real Go hub or the in-browser mock hub is decided by NEXT_PUBLIC_API_MODE.
 */
import type { WsClientMessage, WsServerMessage } from "@/types/api";
import { API_BASE_URL, API_MODE, WS_URL } from "@/lib/api/config";
import { getSessionToken } from "@/lib/api/session";

export type SocketStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface WorkspaceSocket {
  send(msg: WsClientMessage): void;
  close(): void;
}

interface Handlers {
  onMessage: (msg: WsServerMessage) => void;
  onStatus: (status: SocketStatus) => void;
}

function realSocket(workspaceId: string, h: Handlers): WorkspaceSocket {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // NEXT_PUBLIC_WS_URL, else the API address (another host), else this page's host.
  const base =
    WS_URL ||
    (/^https?:\/\//.test(API_BASE_URL)
      ? `${API_BASE_URL.replace(/^http/, "ws")}/ws`
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_BASE_URL}/ws`);

  const connect = () => {
    h.onStatus(attempt === 0 ? "connecting" : "reconnecting");
    // Browsers cannot send headers on a WebSocket, so the session token (if any) goes in the address.
    const token = getSessionToken();
    ws = new WebSocket(`${base}?workspace_id=${encodeURIComponent(workspaceId)}${token ? `&token=${encodeURIComponent(token)}` : ""}`);
    ws.onopen = () => {
      attempt = 0;
      h.onStatus("open");
    };
    ws.onmessage = (ev) => {
      try {
        h.onMessage(JSON.parse(ev.data as string) as WsServerMessage);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (closed) return h.onStatus("closed");
      attempt++;
      h.onStatus("reconnecting");
      timer = setTimeout(connect, Math.min(15000, 500 * 2 ** attempt));
    };
  };
  connect();
  return {
    send: (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg)),
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    },
  };
}

function mockSocket(workspaceId: string, h: Handlers): WorkspaceSocket {
  let unsub: (() => void) | null = null;
  let closed = false;
  h.onStatus("connecting");
  void Promise.all([import("@/mock/bus"), import("@/mock/presence")]).then(([{ mockBus }, presence]) => {
    if (closed) return;
    unsub = mockBus.subscribe(workspaceId, h.onMessage);
    presence.startPresence(workspaceId);
    setTimeout(() => !closed && h.onStatus("open"), 250);
  });
  return {
    send: (msg) => void import("@/mock/bus").then(({ mockBus }) => mockBus.sendFromClient(workspaceId, msg)),
    close: () => {
      closed = true;
      unsub?.();
      void import("@/mock/presence").then((p) => p.stopPresence(workspaceId));
      h.onStatus("closed");
    },
  };
}

export function connectWorkspaceSocket(workspaceId: string, handlers: Handlers): WorkspaceSocket {
  return API_MODE === "http" ? realSocket(workspaceId, handlers) : mockSocket(workspaceId, handlers);
}
