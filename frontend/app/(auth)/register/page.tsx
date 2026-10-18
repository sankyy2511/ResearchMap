"use client";
import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { EnvelopeSimple, UserPlus } from "@phosphor-icons/react";
import { AuthShell } from "@/features/auth/AuthShell";
import { CodeInput, FormError, GoogleSignIn, PasswordRules, passwordRules, useCooldown } from "@/features/auth/AuthParts";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/primitives";
import { authApi } from "@/lib/api/auth";
import { ApiError } from "@/lib/api/errors";
import { useAuthStore } from "@/stores/auth";
import { safeNext } from "@/lib/utils/url";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Step 2: the code sent to the email address. */
function VerifyStep({ email, onBack, next }: { email: string; onBack: () => void; next: string }) {
  const router = useRouter();
  const { verify, status, error, clearError } = useAuthStore();
  const [code, setCode] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const cooldown = useCooldown();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    // New accounts see the extension install steps first.
    if (code.length === 6 && (await verify(email, code))) router.replace(`/extension?next=${encodeURIComponent(next)}`);
  };
  const resend = async () => {
    clearError();
    try {
      await authApi.resend(email);
      setNote("A new code has been sent.");
      cooldown.restart();
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : "The code could not be sent. Please try again.");
    }
  };

  return (
    <>
      <span className="grid size-12 place-items-center rounded-2xl bg-sky-soft text-sky-deep">
        <EnvelopeSimple size={24} weight="bold" />
      </span>
      <h2 className="mt-5 text-balance text-[1.875rem] font-extrabold leading-tight text-ink">Check your email</h2>
      <p className="mt-2 text-sm text-muted">
        We sent a six-digit code to <span className="font-semibold text-ink">{email}</span>. Enter it below to create your account. The code is valid for 10 minutes.
      </p>
      <form onSubmit={submit} className="mt-8 space-y-4" noValidate>
        <CodeInput value={code} onChange={setCode} />
        <FormError message={error} />
        {note && !error && <p className="text-sm text-muted">{note}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" disabled={code.length !== 6} loading={status === "loading"}>
          Confirm and create account
        </Button>
      </form>
      <div className="mt-6 flex items-center justify-between text-sm">
        <button type="button" onClick={onBack} className="font-semibold text-muted hover:text-ink">
          Change email
        </button>
        <button type="button" onClick={() => void resend()} disabled={cooldown.left > 0} className="font-bold text-purple-deep disabled:font-semibold disabled:text-muted">
          {cooldown.left > 0 ? `Send a new code in ${cooldown.left}s` : "Send a new code"}
        </button>
      </div>
      <p className="mt-6 text-xs text-muted">Cannot find it? Check your spam or promotions folder.</p>
    </>
  );
}

function RegisterForm() {
  const router = useRouter();
  const next = safeNext(useSearchParams().get("next"));
  const { register, status, error, clearError } = useAuthStore();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const nameOk = form.name.trim().length >= 2;
  const emailOk = EMAIL.test(form.email.trim());
  const pwOk = passwordRules(form.password, form.email.trim(), form.name).every((r) => r.ok);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!nameOk || !emailOk || !pwOk) return;
    const res = await register({ ...form, email: form.email.trim(), name: form.name.trim() });
    if (res === "done") router.replace(`/extension?next=${encodeURIComponent(next)}`); // new accounts see the install steps first
    if (res === "verify") setPending(form.email.trim().toLowerCase());
  };

  if (pending) return <VerifyStep email={pending} next={next} onBack={() => { clearError(); setPending(null); }} />;

  return (
    <>
      <h2 className="text-balance text-[1.875rem] font-extrabold leading-tight text-ink">Create your account</h2>
      <p className="mt-2 text-sm text-muted">Free to use. Your research stays private to you.</p>
      <div className="mt-8">
        <GoogleSignIn next={next} />
      </div>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div>
          <Label htmlFor="name">Name</Label>
          <Input id="name" autoComplete="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Your full name" aria-invalid={touched && !nameOk} />
          {touched && !nameOk && <p className="mt-1 text-xs font-semibold text-danger">Enter your name.</p>}
        </div>
        <div>
          <Label htmlFor="email">Work or personal email</Label>
          <Input id="email" type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@company.com" aria-invalid={touched && !emailOk} />
          {touched && !emailOk && <p className="mt-1 text-xs font-semibold text-danger">Enter a valid email address.</p>}
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} aria-invalid={touched && !pwOk} />
          <PasswordRules password={form.password} email={form.email.trim()} name={form.name} />
        </div>
        <FormError message={error} />
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={status === "loading"}>
          <UserPlus size={20} weight="bold" /> Create account
        </Button>
      </form>
      <p className="mt-8 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-bold text-purple-deep underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}

export default function RegisterPage() {
  return (
    <AuthShell>
      <Suspense>
        <RegisterForm />
      </Suspense>
    </AuthShell>
  );
}
