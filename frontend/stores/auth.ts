"use client";
import { create } from "zustand";
import type { LoginRequest, RegisterRequest, User } from "@/types/api";
import { authApi } from "@/lib/api/auth";
import { setSessionToken } from "@/lib/api/session";
import { ApiError, friendlyError } from "@/lib/api/errors";

type AuthStatus = "idle" | "loading" | "authenticated" | "unauthenticated" | "error";

interface AuthState {
  user: User | null;
  status: AuthStatus;
  error: string | null;
  bootstrap: () => Promise<void>;
  login: (body: LoginRequest) => Promise<boolean>;
  /** "verify" when an email code was sent, "done" when signed in, false on error. */
  register: (body: RegisterRequest) => Promise<"verify" | "done" | false>;
  verify: (email: string, code: string) => Promise<boolean>;
  signedIn: (user: User) => void;
  clearError: () => void;
  logout: () => Promise<void>;
}

const message = (e: unknown) => (e instanceof ApiError ? e.message : friendlyError(e).message);

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  status: "idle",
  error: null,
  bootstrap: async () => {
    if (get().status === "loading" || get().status === "authenticated") return;
    set({ status: "loading", error: null });
    try {
      const user = await authApi.me();
      set({ user, status: "authenticated" });
    } catch (e) {
      if (e instanceof ApiError && e.code === "unauthorized") {
        setSessionToken(null); // an expired token must not be sent again
        set({ user: null, status: "unauthenticated" });
      }
      else set({ status: "error", error: friendlyError(e).message });
    }
  },
  login: async (body) => {
    set({ status: "loading", error: null });
    try {
      const { user } = await authApi.login(body);
      set({ user, status: "authenticated" });
      return true;
    } catch (e) {
      set({ status: "unauthenticated", error: e instanceof ApiError ? e.message : friendlyError(e).message });
      return false;
    }
  },
  register: async (body) => {
    set({ status: "loading", error: null });
    try {
      const res = await authApi.register(body);
      if ("user" in res) {
        set({ user: res.user, status: "authenticated" });
        return "done";
      }
      set({ status: "unauthenticated" });
      return "verify";
    } catch (e) {
      set({ status: "unauthenticated", error: message(e) });
      return false;
    }
  },
  verify: async (email, code) => {
    set({ status: "loading", error: null });
    try {
      const { user } = await authApi.verify(email, code);
      set({ user, status: "authenticated" });
      return true;
    } catch (e) {
      set({ status: "unauthenticated", error: message(e) });
      return false;
    }
  },
  signedIn: (user) => set({ user, status: "authenticated", error: null }),
  clearError: () => set({ error: null }),
  logout: async () => {
    try {
      await authApi.logout();
    } finally {
      set({ user: null, status: "unauthenticated", error: null });
    }
  },
}));
