"use client";
/** Toast wrapper styled per DESIGN.md §11.1 (sticker card, tone icon badge). */
import { toast as sonner } from "sonner";
import { CheckCircle, Info, Sparkle, Warning, XCircle } from "@phosphor-icons/react";
import { friendlyError } from "@/lib/api/errors";

type Tone = "success" | "error" | "info" | "warning" | "ai";
const TONE: Record<Tone, { bg: string; Icon: typeof Info }> = {
  success: { bg: "bg-mint", Icon: CheckCircle },
  error: { bg: "bg-pink", Icon: XCircle },
  info: { bg: "bg-sky", Icon: Info },
  warning: { bg: "bg-sun", Icon: Warning },
  ai: { bg: "bg-lavender", Icon: Sparkle },
};

interface Opts {
  description?: string;
  action?: { label: string; onClick: () => void };
  duration?: number;
  id?: string;
}

function show(tone: Tone, title: string, opts: Opts = {}) {
  const { bg, Icon } = TONE[tone];
  return sonner.custom(
    (id) => (
      <div
        role={tone === "error" ? "alert" : "status"}
        className="flex w-[min(92vw,380px)] items-start gap-3 rounded-[22px] border border-line bg-white p-3 pr-2 shadow-pop-lg"
      >
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border border-line ${bg}`}>
          <Icon size={18} weight="bold" />
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-sm font-bold text-ink">{title}</p>
          {opts.description && <p className="mt-0.5 text-xs font-medium text-muted">{opts.description}</p>}
        </div>
        {opts.action && (
          <button
            className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-xs font-bold text-white transition hover:bg-purple"
            onClick={() => {
              opts.action!.onClick();
              sonner.dismiss(id);
            }}
          >
            {opts.action.label}
          </button>
        )}
        <button
          aria-label="Dismiss"
          className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-faint hover:bg-ink/5 hover:text-ink"
          onClick={() => sonner.dismiss(id)}
        >
          ×
        </button>
      </div>
    ),
    { duration: opts.duration ?? (opts.action ? 6000 : 3200), id: opts.id },
  );
}

export const toast = {
  success: (t: string, o?: Opts) => show("success", t, o),
  error: (t: string, o?: Opts) => show("error", t, o),
  info: (t: string, o?: Opts) => show("info", t, o),
  warning: (t: string, o?: Opts) => show("warning", t, o),
  ai: (t: string, o?: Opts) => show("ai", t, o),
  apiError: (err: unknown, o?: Opts) => {
    const f = friendlyError(err);
    return show("error", f.title, { description: f.message, ...o });
  },
  dismiss: (id?: string | number) => sonner.dismiss(id),
};
