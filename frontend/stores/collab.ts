"use client";
/** COLLABORATION STATE — presence + socket connection status. */
import { create } from "zustand";
import type { Conflict, PresenceUser, RadarResponse } from "@/types/api";
import type { SocketStatus } from "@/lib/ws/socket";

interface CollabState {
  presence: PresenceUser[];
  socketStatus: SocketStatus;
  setPresence: (p: PresenceUser[]) => void;
  setSocketStatus: (s: SocketStatus) => void;
}

export const useCollabStore = create<CollabState>((set) => ({
  presence: [],
  socketStatus: "closed",
  setPresence: (presence) => set({ presence }),
  setSocketStatus: (socketStatus) => set({ socketStatus }),
}));

/** SIGNALS — Conflict Radar + Research Radar data used for node badges. */
interface SignalsState {
  conflicts: Conflict[];
  radar: RadarResponse | null;
  setConflicts: (c: Conflict[]) => void;
  upsertConflict: (c: Conflict) => void;
  setRadar: (r: RadarResponse) => void;
}
export const useSignalsStore = create<SignalsState>((set) => ({
  conflicts: [],
  radar: null,
  setConflicts: (conflicts) => set({ conflicts }),
  upsertConflict: (c) =>
    set((s) => ({ conflicts: s.conflicts.some((x) => x.id === c.id) ? s.conflicts.map((x) => (x.id === c.id ? c : x)) : [c, ...s.conflicts] })),
  setRadar: (radar) => set({ radar }),
}));
