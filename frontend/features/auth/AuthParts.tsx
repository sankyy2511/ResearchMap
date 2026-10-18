"use client";
/** Shared pieces of the sign-in, sign-up and password reset pages. */
import { useEffect, useState } from "react";
import { CheckCircle, Circle } from "@phosphor-icons/react";
import { authApi } from "@/lib/api/auth";
import { API_BASE_URL, API_MODE } from "@/lib/api/config";
import { cn } from "@/lib/utils/cn";

const COMMON = ["password", "12345678", "123456789", "qwerty", "letmein", "welcome", "iloveyou", "admin123", "abc12345"];

/** The same rules the server checks. */
export function passwordRules(pw: string, email: string, name: string) {
  const low = pw.toLowerCase();
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  const personal =
    (local.length >= 3 && low.includes(local)) ||
    name.toLowerCase().split(/\s+/).some((p) => p.length >= 3 && low.includes(p)) ||
    COMMON.some((c) => low.includes(c));
  return [
    { label: "8 to 72 characters", ok: pw.length >= 8 && pw.length <= 72 },
    { label: "An uppercase and a lowercase letter", ok: /\p{Lu}/u.test(pw) && /\p{Ll}/u.test(pw) },
    { label: "A number", ok: /\p{Nd}/u.test(pw) },
    { label: "A symbol, such as ! @ # or a space", ok: /[\p{P}\p{S}\s]/u.test(pw) },
    { label: "Not your name, email or a common password", ok: pw.length > 0 && !personal },
  ];
}

export function PasswordRules({ password, email, name }: { password: string; email: string; name: string }) {
  return (
    <ul className="mt-2 grid gap-1 text-xs" aria-label="Password rules">
      {passwordRules(password, email, name).map((r) => (
        <li key={r.label} className={cn("flex items-center gap-1.5", r.ok ? "text-success" : "text-muted")}>
          {r.ok ? <CheckCircle size={14} weight="fill" /> : <Circle size={14} />} {r.label}
        </li>
      ))}
    </ul>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-2xl bg-danger-soft px-4 py-2.5 text-sm font-semibold text-danger">
      {message}
    </p>
  );
}

/** A six-digit code field. */
export function CodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      id="code"
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      placeholder="000000"
      aria-label="Six-digit code"
      className="h-14 w-full rounded-2xl border-2 border-transparent bg-white text-center font-display text-2xl font-bold tracking-[0.5em] text-ink shadow-clay-sm outline-none transition placeholder:text-line focus:border-purple"
    />
  );
}

/** Seconds left before a new code can be requested. */
export function useCooldown(seconds = 60) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (left <= 0) return;
    const t = setTimeout(() => setLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [left]);
  return { left, restart: () => setLeft(seconds) };
}

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z" />
    </svg>
  );
}

/** What the server offers: Google sign-in, and email codes (sign-up confirmation and password reset). */
export function useAuthOptions() {
  const [opts, setOpts] = useState({ google: false, email_codes: API_MODE !== "http" });
  useEffect(() => {
    if (API_MODE !== "http") return;
    authApi.options().then((o) => setOpts({ google: !!o.google, email_codes: o.email_codes !== false })).catch(() => undefined);
  }, []);
  return opts;
}

/** "Continue with Google", shown only when the server has Google sign-in turned on. */
export function GoogleSignIn({ next }: { next: string }) {
  const enabled = useAuthOptions().google;
  if (!enabled) return null;
  return (
    <>
      <a
        href={`${API_BASE_URL}/auth/google?next=${encodeURIComponent(next)}`}
        className="flex h-12 w-full items-center justify-center gap-3 rounded-2xl border-2 border-transparent bg-white text-sm font-semibold text-ink shadow-clay-sm transition-colors hover:bg-sun-soft"
      >
        <GoogleLogo /> Continue with Google
      </a>
      <div className="my-6 flex items-center gap-3 text-xs font-semibold text-muted">
        <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
      </div>
    </>
  );
}

export const GOOGLE_ERRORS: Record<string, string> = {
  google_cancelled: "Google sign-in was cancelled.",
  google_failed: "Google sign-in did not work. Please try again.",
  google_unverified: "Your Google account email is not verified, so it cannot be used to sign in.",
  google_off: "Google sign-in is not available right now. Please use your email and password.",
};
