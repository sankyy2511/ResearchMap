"use client";
/** SESSION STATE — tracking session + AI pipeline activity feed (job.status). */
import { create } from "zustand";
import type { JobStatus, Session } from "@/types/api";

export interface ActivityItem extends JobStatus {
  id: number;
  at: number;
}

interface SessionState {
  session: Session | null;
  jobs: ActivityItem[];
  setSession: (s: Session | null) => void;
  pushJob: (j: JobStatus) => void;
  clearJobs: () => void;
}

let seq = 0;
export const useSessionStore = create<SessionState>((set) => ({
  session: null,
  jobs: [],
  setSession: (session) => set({ session }),
  pushJob: (j) => set((s) => ({ jobs: [{ ...j, id: ++seq, at: Date.now() }, ...s.jobs].slice(0, 40) })),
  clearJobs: () => set({ jobs: [] }),
}));

/** Elapsed tracked time for a session, excluding pauses. */
export function sessionElapsed(s: Session, now = Date.now()): number {
  const end = s.ended_at ? Date.parse(s.ended_at) : s.paused_at ? Date.parse(s.paused_at) : now;
  return Math.max(0, end - Date.parse(s.started_at) - s.paused_ms);
}
