"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { SignIn, Sparkle } from "@phosphor-icons/react";
import { AuthShell } from "@/features/auth/AuthShell";
import { FormError, GOOGLE_ERRORS, GoogleSignIn, useAuthOptions } from "@/features/auth/AuthParts";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { useAuthStore } from "@/stores/auth";
import { API_MODE } from "@/lib/api/config";
import { detectExtension } from "@/lib/extension/bridge";
import { safeNext } from "@/lib/utils/url";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const { login, status, error, bootstrap } = useAuthStore();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const submitting = useRef(false);
  const googleError = GOOGLE_ERRORS[params.get("error") ?? ""] ?? null;
  const emailCodes = useAuthOptions().email_codes;

  useEffect(() => void bootstrap(), [bootstrap]);
  useEffect(() => {
    // Already signed in when the page opened; a fresh sign-in is sent on by submit().
    if (status === "authenticated" && !submitting.current) router.replace(next);
  }, [status, router, next]);

  const submit = async (e?: React.FormEvent, creds?: { email: string; password: string }) => {
    e?.preventDefault();
    setTouched(true);
    const body = creds ?? { email: email.trim(), password };
    if (!body.email || !body.password) return;
    submitting.current = true;
    const ok = await login(body);
    submitting.current = ok;
    if (!ok) return;
    // Without the extension, show the install steps first.
    const hasExtension = API_MODE !== "http" || (await detectExtension());
    router.replace(hasExtension ? next : `/extension?next=${encodeURIComponent(next)}`);
  };
  const missing = touched && (!email.trim() || !password) ? "Enter your email and password." : null;

  return (
    <>
      <h2 className="text-balance text-[1.875rem] font-extrabold leading-tight text-ink">Welcome back</h2>
      <p className="mt-2 text-sm text-muted">Sign in to open your research workspaces.</p>
      <div className="mt-8">
        <GoogleSignIn next={next} />
      </div>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" aria-invalid={!!error || (touched && !email.trim())} />
        </div>
        <div>
          <Label htmlFor="password" hint={emailCodes ? <Link href="/forgot" className="font-semibold text-purple-deep hover:underline">Forgot password?</Link> : undefined}>Password</Label>
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!error || (touched && !password)} />
        </div>
        <FormError message={error ?? missing ?? googleError} />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={status === "loading"}>
          <SignIn size={20} weight="bold" /> Sign in
        </Button>
      </form>
      {API_MODE === "mock" && (
        <div className="mt-6 rounded-[24px] border-2 border-dashed border-purple/40 bg-lavender-soft/60 p-4">
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-purple-deep">Demo mode</p>
          <p className="mt-1 text-sm text-ink-soft">
            The backend is simulated in your browser. Use the demo account to explore the seeded “AI in Healthcare” workspace.
          </p>
          <Button
            variant="purple"
            size="sm"
            className="mt-3"
            onClick={() => void submit(undefined, { email: "demo@researchmap.app", password: "demo1234" })}
          >
            <Sparkle size={16} weight="fill" /> Continue with demo account
          </Button>
        </div>
      )}
      <p className="mt-8 text-center text-sm text-muted">
        New here?{" "}
        <Link href={`/register${next !== "/workspaces" ? `?next=${encodeURIComponent(next)}` : ""}`} className="font-bold text-purple-deep underline-offset-4 hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );
}

export default function LoginPage() {
  return (
    <AuthShell>
      <Suspense>
        <LoginForm />
      </Suspense>
    </AuthShell>
  );
}
