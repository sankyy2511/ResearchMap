"use client";
/** Shown on the workspaces page until the Chrome extension is installed. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, PuzzlePiece } from "@phosphor-icons/react";
import { ArtTile } from "@/components/ui/primitives";
import { API_MODE } from "@/lib/api/config";
import { connectExtension } from "@/lib/extension/bridge";

export function ExtensionNotice() {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (API_MODE !== "http") return;
    // Also connects an installed extension to this account, so the notice only stays when it is not installed.
    void connectExtension()
      .catch(() => false)
      .then((ok) => setMissing(!ok));
  }, []);
  if (!missing) return null;
  return (
    <div className="mt-6 flex flex-col gap-4 rounded-[24px] border border-line bg-white/80 p-5 shadow-soft backdrop-blur-md sm:flex-row sm:items-center">
      <ArtTile icon={PuzzlePiece} tone="sun" />
      <div className="flex-1">
        <p className="font-bold text-ink">Install the Chrome extension to start</p>
        <p className="text-sm text-muted">It adds the pages you read to your canvas. Three quick steps, once.</p>
      </div>
      <Link
        href="/extension"
        className="inline-flex h-11 items-center justify-center gap-2 rounded-full border-2 border-pill bg-pill px-5 text-sm font-bold text-white shadow-pop-purple transition hover:-translate-y-0.5"
      >
        See the steps <ArrowRight size={16} weight="bold" />
      </Link>
    </div>
  );
}
