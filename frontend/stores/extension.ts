"use client";
/**
 * Chrome extension bridge state (§9.4). Real messages (TABS_STATE, SNAPSHOT, LIVE_STREAM_ID, TRACKING_STATE)
 * arrive on the port opened in lib/extension/bridge.ts; in mock mode the browsing simulator fills this store instead.
 */
import { create } from "zustand";
import type { TabState } from "@/types/api";
import { API_MODE } from "@/lib/api/config";

export type PreviewMode = "snapshot" | "live" | "interactive";

interface ExtensionState {
  /** Real extension connected through externally_connectable. */
  connected: boolean;
  /** Demo simulator is standing in for the extension (mock mode only). */
  simulated: boolean;
  /** url_normalized → tab state */
  tabs: Record<string, Exclude<TabState, "closed" | "live">>;
  previewMode: Record<string, PreviewMode>;
  /** url_normalized → latest JPEG data URL sent by the extension */
  snapshots: Record<string, string>;
  /** url_normalized → tabCapture stream id (Live Video) */
  liveStreams: Record<string, string>;
  tracking: { tracking: boolean; paused: boolean; workspace_id: string | null } | null;
  setConnected: (c: boolean) => void;
  setSimulated: (s: boolean) => void;
  setTabs: (t: ExtensionState["tabs"]) => void;
  setPreviewMode: (nodeId: string, m: PreviewMode) => void;
  setSnapshot: (url: string, image: string) => void;
  setLiveStream: (url: string, id: string | null) => void;
  setTracking: (t: ExtensionState["tracking"]) => void;
}

export const useExtensionStore = create<ExtensionState>((set) => ({
  connected: false,
  simulated: API_MODE === "mock",
  tabs: {},
  previewMode: {},
  snapshots: {},
  liveStreams: {},
  tracking: null,
  setConnected: (connected) => set({ connected }),
  setSimulated: (simulated) => set({ simulated }),
  setTabs: (tabs) => set({ tabs }),
  setPreviewMode: (nodeId, m) =>
    set((s) => {
      const next = { ...s.previewMode, [nodeId]: m };
      // limits from §13.1: max 4 live videos, max 3 interactive
      const count = (mode: PreviewMode) => Object.values(next).filter((x) => x === mode).length;
      if (m === "live" && count("live") > 4) return s;
      if (m === "interactive" && count("interactive") > 3) return s;
      return { previewMode: next };
    }),
  setSnapshot: (url, image) => set((s) => ({ snapshots: { ...s.snapshots, [url]: image } })),
  setLiveStream: (url, id) =>
    set((s) => {
      const next = { ...s.liveStreams };
      if (id) next[url] = id;
      else delete next[url];
      return { liveStreams: next };
    }),
  setTracking: (tracking) => set({ tracking }),
}));
