"use client";
import Link from "next/link";
import { AppScreenshot } from "@/components/site/AppScreenshot";
import { SiteShell } from "@/components/site/SiteShell";
import { useDemoLogin } from "@/components/site/useDemoLogin";

const POINTS = ["Set a goal for today", "Get a warning when you go off topic", "See all your tabs on one canvas"];

const STEPS = [
  { n: "1", tint: "bg-sun-soft", title: "Write your goal", text: "Tell the app what you want to finish, for example: prepare for my networks exam." },
  { n: "2", tint: "bg-coral-soft", title: "Browse as usual", text: "Open the pages you read. Each one is added to your canvas, with a short summary." },
  { n: "3", tint: "bg-mint-soft", title: "Stay on your goal", text: "If a page is about something else, the app tells you, so you can get back to your work." },
];

export default function LandingPage() {
  const demo = useDemoLogin();

  return (
    <SiteShell
      hero={
        <div className="mx-auto flex max-w-6xl flex-col items-center px-6 pb-24 pt-10 text-center sm:px-8">
          <h1 className="max-w-2xl text-balance font-display text-[32px] font-black leading-[1.25] tracking-[-0.02em] sm:text-[38px] lg:text-[44px]">
            Research with many tabs open?
            <br />
            Track them all on{" "}
            <span className="whitespace-nowrap">
              one <span className="rounded-2xl bg-brand-gradient px-2.5">canvas.</span>
            </span>
          </h1>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
            <button
              onClick={demo.start}
              disabled={demo.busy}
              className="rounded-full bg-ink px-7 py-3.5 text-base font-semibold text-white shadow-pop-lg transition hover:-translate-y-0.5 disabled:opacity-60"
            >
              {demo.busy ? "Opening…" : "Try the demo"}
            </button>
            <Link href="/how-it-works" className="rounded-full bg-white px-7 py-3.5 text-base font-semibold shadow-pop transition hover:-translate-y-0.5">
              See how it works
            </Link>
          </div>

          <ul className="mt-10 flex flex-col items-center gap-3 text-[15px] font-medium text-ink-soft sm:flex-row sm:gap-8">
            {POINTS.map((p) => <li key={p}>{p}</li>)}
          </ul>

          <div className="mt-14 w-full max-w-5xl rounded-[30px] border border-white/70 bg-white/50 p-2.5 backdrop-blur-sm sm:p-3.5">
            <AppScreenshot />
          </div>
        </div>
      }
    >
      <section className="mx-auto max-w-6xl px-6 py-20 sm:px-8">
        <h2 className="text-center font-display text-3xl font-black sm:text-4xl">Too many tabs? We fix this.</h2>
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <div className="rounded-3xl border border-line bg-white p-8 shadow-pop">
            <p className="text-sm font-semibold text-coral-deep">The problem</p>
            <p className="mt-3 text-xl font-semibold leading-snug">
              With many tabs open, the titles are cut short. It is hard to read them, and hard to click the tab you want.
            </p>
          </div>
          <div className="rounded-3xl border border-line bg-white p-8 shadow-pop">
            <p className="text-sm font-semibold text-mint-deep">With Research Map</p>
            <p className="mt-3 text-xl font-semibold leading-snug">
              Every tab you open appears on one canvas with its full title. Click any page to read its summary or go straight to it.
            </p>
          </div>
        </div>
      </section>

      <section className="border-t border-line bg-white/60 py-16">
        <div className="mx-auto max-w-6xl px-6 sm:px-8">
          <h2 className="text-center font-display text-3xl font-black sm:text-4xl">How it works</h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.n} className="rounded-3xl border border-line bg-white p-6 shadow-pop">
                <span className={`grid h-10 w-10 place-items-center rounded-2xl font-display text-base font-black ${s.tint}`}>{s.n}</span>
                <h3 className="mt-4 font-display text-lg font-black">{s.title}</h3>
                <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">{s.text}</p>
              </div>
            ))}
          </div>
          <p className="mt-10 text-center text-[15px] text-ink-soft">
            Tracking starts only when you press Start Tracking, and private sites are never read.{" "}
            <Link href="/privacy" className="font-semibold underline underline-offset-4">Read about privacy</Link>
          </p>
        </div>
      </section>
    </SiteShell>
  );
}
