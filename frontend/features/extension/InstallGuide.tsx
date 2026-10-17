"use client";
/** Three short steps to install the Chrome extension, each with a small picture. */
import type { ReactNode } from "react";
import { DownloadSimple, FileZip, FolderSimple } from "@phosphor-icons/react";
import { CopyField } from "@/components/ui/primitives";

export const EXTENSION_ZIP = "/research-map-extension.zip";

function Step({ n, title, children, picture }: { n: number; title: string; children?: ReactNode; picture: ReactNode }) {
  return (
    <li className="flex flex-col rounded-[24px] border border-line bg-white p-5 shadow-soft">
      <div className="flex h-24 items-center justify-center rounded-2xl bg-canvas">{picture}</div>
      <div className="mt-4 flex items-start gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-gradient font-display text-xs font-black text-ink">{n}</span>
        <p className="text-sm font-semibold leading-6 text-ink">{title}</p>
      </div>
      {children && <div className="mt-3">{children}</div>}
    </li>
  );
}

export function InstallGuide() {
  return (
    <ol className="grid gap-4 md:grid-cols-3">
      <Step
        n={1}
        title="Unzip the downloaded file"
        picture={
          <span className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 py-2 text-xs font-semibold text-ink shadow-soft">
            <FileZip size={20} weight="duotone" className="text-purple-deep" /> research-map-extension.zip
          </span>
        }
      />
      <Step
        n={2}
        title="Open this page and turn on Developer mode"
        picture={
          <span className="flex items-center gap-3 rounded-xl border border-line bg-white px-3 py-2 text-xs font-semibold text-ink shadow-soft">
            Developer mode
            <span className="relative h-5 w-9 rounded-full bg-sky-deep">
              <span className="absolute right-0.5 top-0.5 size-4 rounded-full bg-white" />
            </span>
          </span>
        }
      >
        <CopyField value="chrome://extensions" />
      </Step>
      <Step
        n={3}
        title="Click Load unpacked and choose the unzipped folder"
        picture={
          <span className="flex flex-col items-center gap-2">
            <span className="rounded-full border border-sky-deep/40 bg-white px-3 py-1.5 text-xs font-semibold text-sky-deep shadow-soft">Load unpacked</span>
            <span className="flex items-center gap-1.5 text-xs font-semibold text-ink">
              <FolderSimple size={18} weight="duotone" className="text-sun-deep" /> research-map-extension
            </span>
          </span>
        }
      />
    </ol>
  );
}

export function DownloadButton({ className = "" }: { className?: string }) {
  return (
    <a
      href={EXTENSION_ZIP}
      download
      className={`inline-flex h-12 items-center justify-center gap-2 rounded-full border-2 border-pill bg-pill px-6 text-sm font-bold text-white shadow-pop-purple transition hover:-translate-y-0.5 ${className}`}
    >
      <DownloadSimple size={18} weight="bold" /> Download extension
    </a>
  );
}
