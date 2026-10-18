"use client";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Key } from "@phosphor-icons/react";
import { AuthShell } from "@/features/auth/AuthShell";
import { CodeInput, FormError, PasswordRules, passwordRules, useCooldown } from "@/features/auth/AuthParts";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { authApi } from "@/lib/api/auth";
import { ApiError, friendlyError } from "@/lib/api/errors";
import { useAuthStore } from "@/stores/auth";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const message = (e: unknown) => (e instanceof ApiError ? e.message : friendlyError(e).message);

/** Forgot password: email a code, then set a new password with it. */
function ForgotForm() {
  const router = useRouter();
  const signedIn = useAuthStore((s) => s.signedIn);
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const cooldown = useCooldown();

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (!EMAIL.test(email.trim())) return setError("Enter a valid email address.");
    setBusy(true);
    try {
      await authApi.forgot(email.trim());
      if (sent) setNote("A new code has been sent.");
      setSent(true);
      cooldown.restart();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (code.length !== 6) return setError("Enter the six-digit code from the email.");
    if (!passwordRules(password, email.trim(), "").every((r) => r.ok)) return setError("Choose a password that meets every rule below.");
    setBusy(true);
    try {
      const { user } = await authApi.reset(email.trim(), code, password);
      signedIn(user);
      router.replace("/workspaces");
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <span className="grid size-12 place-items-center rounded-2xl bg-sun-soft text-sun-deep">
        <Key size={24} weight="bold" />
      </span>
      <h2 className="mt-5 text-balance text-[1.875rem] font-extrabold leading-tight text-ink">Reset your password</h2>
      {!sent ? (
        <>
          <p className="mt-2 text-sm text-muted">Enter the email of your account. We will send you a six-digit code to set a new password.</p>
          <form onSubmit={send} className="mt-8 space-y-4" noValidate>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
            </div>
            <FormError message={error} />
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
              Send code
            </Button>
          </form>
        </>
      ) : (
        <>
          <p className="mt-2 text-sm text-muted">
            If an account exists for <span className="font-semibold text-ink">{email.trim()}</span>, a code has been sent to it. The code is valid for 10 minutes.
          </p>
          <form onSubmit={reset} className="mt-8 space-y-4" noValidate>
            <div>
              <Label htmlFor="code">Code</Label>
              <CodeInput value={code} onChange={setCode} />
            </div>
            <div>
              <Label htmlFor="password">New password</Label>
              <Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              <PasswordRules password={password} email={email.trim()} name="" />
            </div>
            <FormError message={error} />
            {note && !error && <p className="text-sm text-muted">{note}</p>}
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
              Set new password and sign in
            </Button>
          </form>
          <div className="mt-6 flex items-center justify-between text-sm">
            <button type="button" onClick={() => { setSent(false); setCode(""); setError(null); }} className="font-semibold text-muted hover:text-ink">
              Change email
            </button>
            <button type="button" onClick={() => void send()} disabled={cooldown.left > 0 || busy} className="font-bold text-purple-deep disabled:font-semibold disabled:text-muted">
              {cooldown.left > 0 ? `Send a new code in ${cooldown.left}s` : "Send a new code"}
            </button>
          </div>
        </>
      )}
      <p className="mt-8 text-center text-sm text-muted">
        Remembered it?{" "}
        <Link href="/login" className="font-bold text-purple-deep underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}

export default function ForgotPage() {
  return (
    <AuthShell>
      <ForgotForm />
    </AuthShell>
  );
}
