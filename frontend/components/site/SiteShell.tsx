"use client";
/** Header and footer shared by the landing page and the explanation pages. */
import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { Browsers, Cloud } from "@phosphor-icons/react";
import { useAuthStore } from "@/stores/auth";
import { useDemoLogin } from "./useDemoLogin";

const NAV = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/features", label: "Features" },
  { href: "/privacy", label: "Privacy" },
];

// Where the product runs: the web app on Firebase Hosting, the server on Google Cloud Run.
const FIREBASE_URL = "https://research-map-88f54.web.app";
const CLOUD_RUN_STATUS = "https://research-map-api-812274791846.asia-southeast1.run.app/api/v1/readyz";

/** A thin top bar that shows where the product is hosted. */
function HostingBanner() {
  const link = "font-extrabold text-ink underline decoration-purple decoration-2 underline-offset-4 transition-colors hover:text-purple-deep";
  return (
    <div className="border-b border-ink/10 bg-brand-gradient px-6 py-3 text-[15px] font-semibold text-ink-soft">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-center gap-x-3 gap-y-2">
        <span className="inline-flex shrink-0 items-center gap-2 rounded-full bg-ink px-3 py-1 text-xs font-bold text-white">
          <Cloud size={14} weight="bold" /> Live on Google Cloud
        </span>
        <p className="text-center">
          The web app runs on{" "}
          <a href={FIREBASE_URL} target="_blank" rel="noreferrer" className={link}>Firebase Hosting</a>
          {" "}and the server runs on{" "}
          <a href={CLOUD_RUN_STATUS} target="_blank" rel="noreferrer" className={link}>Google Cloud Run</a>.
        </p>
      </div>
    </div>
  );
}

/** hero: an optional top section. It is drawn together with the header on one full-width gradient. */
export function SiteShell({ hero, children }: { hero?: ReactNode; children: ReactNode }) {
  const { status, user, bootstrap } = useAuthStore();
  const demo = useDemoLogin();
  const signedIn = status === "authenticated" && !!user;

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <div className={`flex min-h-screen flex-col font-sans text-ink selection:bg-lavender ${hero ? "bg-white" : "bg-canvas"}`}>
      <HostingBanner />
      <div className={hero ? "bg-hero-glow" : undefined}>
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-5 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand-gradient text-ink shadow-sm">
            <Browsers size={18} weight="bold" />
          </span>
          <span className="font-display text-[22px] font-black tracking-tight">Research Map</span>
        </Link>

        <nav className="hidden items-center gap-8 text-[15px] font-semibold text-ink/70 md:flex" aria-label="Main">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="transition hover:text-ink">{item.label}</Link>
          ))}
        </nav>

        <div className="flex items-center gap-4 text-sm font-bold">
          {signedIn ? (
            <Link href="/workspaces" className="rounded-full bg-ink px-5 py-2.5 text-white transition hover:bg-ink-soft">Open my workspaces</Link>
          ) : (
            <>
              <Link href="/login" className="transition hover:text-purple">Log in</Link>
              <button onClick={demo.start} disabled={demo.busy} className="rounded-full bg-ink px-5 py-2.5 text-white transition hover:bg-ink-soft disabled:opacity-60">
                {demo.busy ? "Opening…" : "Try the demo"}
              </button>
            </>
          )}
        </div>
      </header>
      {hero}
      </div>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-line bg-white py-8 text-sm text-muted">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 sm:flex-row sm:px-8">
          <span className="font-display font-black text-ink">Research Map</span>
          <nav className="flex gap-6 font-semibold" aria-label="Footer">
            {NAV.map((item) => (
              <Link key={item.href} href={item.href} className="hover:text-ink">{item.label}</Link>
            ))}
            <Link href="/login" className="hover:text-ink">Log in</Link>
          </nav>
          <span className="flex items-center gap-4">
            {/* The live server status, answered by the backend on Google Cloud Run. */}
            <a href={CLOUD_RUN_STATUS} target="_blank" rel="noreferrer" className="font-semibold hover:text-ink">
              Runs on Google Cloud Run
            </a>
            <span>© 2026 Research Map</span>
          </span>
        </div>
      </footer>
    </div>
  );
}
