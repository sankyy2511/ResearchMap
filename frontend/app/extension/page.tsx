"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowClockwise, ArrowRight, CheckCircle, PuzzlePiece } from "@phosphor-icons/react";
import { AuthGate } from "@/components/shell/AuthGate";
import { AppHeader } from "@/components/shell/AppHeader";
import { Button } from "@/components/ui/button";
import { ArtTile, Kicker } from "@/components/ui/primitives";
import { DownloadButton, InstallGuide } from "@/features/extension/InstallGuide";
import { connectExtension } from "@/lib/extension/bridge";
import { safeNext } from "@/lib/utils/url";

function ExtensionView() {
  const next = safeNext(useSearchParams().get("next"));
  const [status, setStatus] = useState<"checking" | "connected" | "missing">("checking");

  useEffect(() => {
    let alive = true;
    void connectExtension()
      .catch(() => false)
      .then((ok) => alive && setStatus(ok ? "connected" : "missing"));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="min-h-dvh bg-app pb-28 md:pb-12">
      <AppHeader />
      <main className="mx-auto max-w-4xl space-y-6 px-4 pt-8 sm:px-6">
        <div>
          <Kicker tone="sky">Chrome extension</Kicker>
          <h1 className="mt-3 text-balance text-[1.875rem] font-extrabold leading-tight">Install the extension</h1>
          <p className="mt-2 text-sm text-muted">It adds the pages you read to your canvas. You do this once.</p>
        </div>

        {status === "connected" ? (
          <div className="flex flex-col gap-4 rounded-[24px] border border-success/30 bg-success-soft p-5 sm:flex-row sm:items-center">
            <CheckCircle size={32} weight="fill" className="shrink-0 text-success" />
            <div className="flex-1">
              <p className="font-bold text-ink">The extension is installed and connected</p>
            </div>
            <Link href={next}>
              <Button variant="primary">
                Continue <ArrowRight size={16} weight="bold" />
              </Button>
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-4 rounded-[24px] border border-line bg-white p-5 shadow-soft sm:flex-row sm:items-center">
            <ArtTile icon={PuzzlePiece} tone="sun" />
            <div className="flex-1">
              <p className="font-bold text-ink">{status === "checking" ? "Looking for the extension…" : "Not installed yet"}</p>
              <p className="text-sm text-muted">Works in Chrome, Edge and Brave.</p>
            </div>
            <DownloadButton />
          </div>
        )}

        <InstallGuide />

        <div className="flex flex-col items-center gap-3 pb-4 text-center">
          <Button variant="secondary" onClick={() => window.location.reload()}>
            <ArrowClockwise size={18} weight="bold" /> Done, check again
          </Button>
          <Link href={next} className="text-sm font-semibold text-muted hover:text-ink">
            Skip for now
          </Link>
        </div>
      </main>
    </div>
  );
}

export default function ExtensionPage() {
  return (
    <AuthGate>
      <Suspense>
        <ExtensionView />
      </Suspense>
    </AuthGate>
  );
}
