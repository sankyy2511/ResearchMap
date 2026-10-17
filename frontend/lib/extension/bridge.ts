"use client";
/**
 * Web app ↔ Chrome extension messaging (§9.4, §F27).
 * Web → extension: chrome.runtime.sendMessage(EXTENSION_ID, …) via externally_connectable.
 * Extension → web: a long-lived port (chrome.runtime.connect) carrying TABS_STATE, SNAPSHOT, LIVE_STREAM_ID, TRACKING_STATE.
 */
import { API_MODE, EXTENSION_ID, absoluteApiBase } from "@/lib/api/config";
import { tokensApi } from "@/lib/api/auth";
import { toast } from "@/lib/toast";
import { useAuthStore } from "@/stores/auth";
import { useExtensionStore } from "@/stores/extension";

type ExtMessage =
  | { type: "PING" }
  | { type: "CONNECT_TOKEN"; token: string; user_id?: string; api_base: string }
  | { type: "FOCUS_TAB"; url: string }
  | { type: "OPEN_URLS_AS_GROUP"; title: string; color: string; urls: string[] }
  | { type: "CLOSE_SAVED_TABS"; urls: string[] }
  | { type: "REQUEST_LIVE_VIDEO"; url: string }
  | { type: "ENABLE_INTERACTIVE_EMBED"; url: string }
  | { type: "START_TRACKING"; workspace_id: string; session_id: string; open_tab?: boolean; goal?: string }
  | { type: "GOAL_CHANGED"; goal: string }
  | { type: "PAUSE_TRACKING" }
  | { type: "RESUME_TRACKING" }
  | { type: "STOP_TRACKING" }
  | { type: "GET_OPEN_TABS" }
  | { type: "RELOAD" };

interface Port {
  onMessage: { addListener: (fn: (m: Record<string, unknown>) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}
interface ChromeRuntime {
  sendMessage: (id: string, msg: unknown, cb?: (res: unknown) => void) => void;
  connect?: (id: string) => Port;
}
function chromeRuntime(): ChromeRuntime | null {
  const c = (globalThis as unknown as { chrome?: { runtime?: ChromeRuntime } }).chrome;
  return c?.runtime?.sendMessage ? c.runtime : null;
}

function call<T = Record<string, unknown>>(msg: ExtMessage, timeoutMs = 1500): Promise<T | null> {
  return new Promise((resolve) => {
    const rt = chromeRuntime();
    if (!rt || !EXTENSION_ID) return resolve(null);
    const t = setTimeout(() => resolve(null), timeoutMs);
    try {
      rt.sendMessage(EXTENSION_ID, msg, (res) => {
        clearTimeout(t);
        resolve((res as T) ?? null);
      });
    } catch {
      clearTimeout(t);
      resolve(null);
    }
  });
}

export async function detectExtension(): Promise<boolean> {
  return !!(await call({ type: "PING" }, 800));
}

/** Lowest extension version this web app works with. Raise it together with extension/manifest.json. */
const NEEDED_EXTENSION_VERSION = [1, 1, 8];
let reloadTried = false; // one self-reload per page load, so a stale folder cannot cause a reload loop
let manualShown = false;

function isOlder(version: string) {
  const have = version.split(".").map((n) => Number(n) || 0);
  const i = NEEDED_EXTENSION_VERSION.findIndex((n, k) => (have[k] ?? 0) !== n); // first part that differs
  return i >= 0 && (have[i] ?? 0) < NEEDED_EXTENSION_VERSION[i]!;
}

/** Chrome runs an unpacked extension's old code until it reloads, so ask it to reload itself. */
async function updateIfOutdated(version = "0") {
  if (!isOlder(version)) return;
  if (!reloadTried) {
    reloadTried = true;
    const res = await call<{ ok: boolean }>({ type: "RELOAD" });
    if (res?.ok) {
      toast.info("Updating the Chrome extension…");
      setTimeout(() => void connectExtension(), 2500);
      return;
    }
  }
  // Versions before 1.1.0 cannot reload themselves, or the folder still has old code.
  if (manualShown) return;
  manualShown = true;
  toast.warning("Please update the Chrome extension", {
    description: "Open your browser's extensions page (chrome://extensions or brave://extensions), click the reload button on Research Map, then reload this page.",
    duration: Infinity,
  });
}

/** The server address this browser last gave the extension (kept in this browser only). */
const EXT_API_KEY = "rm_extension_api";
function lastExtensionApi(): string | null {
  try {
    return localStorage.getItem(EXT_API_KEY);
  } catch {
    return null;
  }
}
function rememberExtensionApi(apiBase: string) {
  try {
    localStorage.setItem(EXT_API_KEY, apiBase);
  } catch {
    /* storage blocked: the extension is connected again on the next page load */
  }
}

let portOpen = false;
function openPort() {
  const rt = chromeRuntime();
  if (portOpen || !rt?.connect || !EXTENSION_ID) return;
  const port = rt.connect(EXTENSION_ID);
  portOpen = true;
  const st = useExtensionStore.getState();
  port.onMessage.addListener((m) => {
    switch (m.type) {
      case "TABS_STATE":
        st.setTabs(m.tabs as Record<string, "active" | "open">);
        break;
      case "SNAPSHOT":
        st.setSnapshot(String(m.url), String(m.image));
        break;
      case "LIVE_STREAM_ID":
        st.setLiveStream(String(m.url), String(m.stream_id));
        break;
      case "TRACKING_STATE":
        st.setTracking({ tracking: !!m.tracking, paused: !!m.paused, workspace_id: (m.workspace_id as string) ?? null });
        break;
    }
  });
  port.onDisconnect.addListener(() => {
    portOpen = false;
    useExtensionStore.getState().setConnected(false);
  });
}

/** Detects the extension, gives it an extension token if it has none, and opens the message port. */
export async function connectExtension(opts: { forceNewToken?: boolean } = {}): Promise<boolean> {
  if (API_MODE !== "http") return detectExtension();
  const ping = await call<{ ok: boolean; connected: boolean; version?: string; user_id?: string | null }>({ type: "PING" }, 800);
  if (!ping) {
    useExtensionStore.getState().setConnected(false);
    return false;
  }
  void updateIfOutdated(ping.version);
  // Connect again when the extension has no token, belongs to another (or a deleted) account,
  // or was connected to an older server address (it would send pages where this page does not listen).
  const userId = useAuthStore.getState().user?.id;
  const apiBase = process.env.NEXT_PUBLIC_EXTENSION_API_BASE || absoluteApiBase();
  const movedServer = lastExtensionApi() !== apiBase;
  if (!ping.connected || opts.forceNewToken || movedServer || (userId && ping.user_id !== userId)) {
    const t = await tokensApi.create("extension", "Chrome extension");
    const res = await call<{ ok: boolean }>({ type: "CONNECT_TOKEN", token: t.token, user_id: userId, api_base: apiBase });
    if (res?.ok) rememberExtensionApi(apiBase);
  }
  openPort();
  useExtensionStore.getState().setConnected(true);
  return true;
}

function send(msg: ExtMessage, simulatedMessage: string): boolean {
  const { connected, simulated } = useExtensionStore.getState();
  const rt = chromeRuntime();
  if (connected && rt && EXTENSION_ID) {
    rt.sendMessage(EXTENSION_ID, msg);
    return true;
  }
  toast.warning("Chrome extension connection required.", {
    description: simulated ? `Demo mode: ${simulatedMessage}` : "Install the extension and click Connect extension in Settings.",
  });
  return false;
}

export const extensionBridge = {
  goToTab: (url: string) => send({ type: "FOCUS_TAB", url }, "would switch Chrome to this tab."),
  openAsTabGroup: (title: string, color: string, urls: string[]) =>
    send({ type: "OPEN_URLS_AS_GROUP", title, color, urls }, `would open ${urls.length} tabs as the group “${title}”.`),
  closeSavedTabs: (urls: string[]) => send({ type: "CLOSE_SAVED_TABS", urls }, `would close ${urls.length} saved tabs.`),
  requestLive: (url: string) => {
    const ok = send({ type: "REQUEST_LIVE_VIDEO", url }, "press Alt+Shift+L on the tab to stream it.");
    if (ok) toast.info("Switched to the tab", { description: "Press Alt+Shift+L there to stream it live into this node." });
    return ok;
  },
  enableEmbed: (url: string) => (useExtensionStore.getState().connected ? void call({ type: "ENABLE_INTERACTIVE_EMBED", url }) : undefined),
  /** openTab=false when re-attaching to a session that is already running (page reload), so no extra tab opens. */
  startTracking: (workspaceId: string, sessionId: string, openTab = true, goal = "") =>
    send({ type: "START_TRACKING", workspace_id: workspaceId, session_id: sessionId, open_tab: openTab, goal }, "tracking started."),
  /** The extension uses the goal to warn about pages that are not part of it. */
  goalChanged: (goal: string) => void call({ type: "GOAL_CHANGED", goal }),
  pauseTracking: () => void call({ type: "PAUSE_TRACKING" }),
  resumeTracking: () => void call({ type: "RESUME_TRACKING" }),
  stopTracking: () => void call({ type: "STOP_TRACKING" }),
  /** Open http(s) tabs as reported by the extension (normalized URLs); null when the extension is not reachable. */
  getOpenTabs: async (): Promise<string[] | null> => {
    const res = await call<{ ok: boolean; tabs: { url_normalized: string }[] }>({ type: "GET_OPEN_TABS" });
    return res?.ok ? res.tabs.map((t) => t.url_normalized) : null;
  },
  openUrl: (url: string) => window.open(url, "_blank", "noopener,noreferrer"),
};
