"use client";
/** DESIGN.md §11.3 — empty, error and loading states. */
import type { ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowClockwise, WifiSlash } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { friendlyError } from "@/lib/api/errors";
import { cn } from "@/lib/utils/cn";
import type { Tone } from "@/lib/domain/meta";
import { ArtTile } from "./primitives";
import { Button } from "./button";

export function EmptyState({
  icon,
  tone = "lavender",
  title,
  message,
  action,
  compact,
  className,
}: {
  icon: Icon;
  tone?: Tone;
  title: string;
  message?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}
      className={cn("rounded-[28px] bg-white/60 text-center", compact ? "p-6" : "p-8 sm:p-14", className)}
    >
      <div className="mx-auto mb-4 w-fit animate-float">
        <ArtTile icon={icon} tone={tone} size={compact ? 52 : 72} />
      </div>
      <h3 className="font-display text-lg font-bold text-ink">{title}</h3>
      {message && <p className="mx-auto mt-2 max-w-sm text-sm text-muted">{message}</p>}
      {action && <div className="mt-5 flex justify-center gap-2">{action}</div>}
    </motion.div>
  );
}

export function ErrorState({ error, onRetry, title, className }: { error?: unknown; onRetry?: () => void; title?: string; className?: string }) {
  const f = friendlyError(error);
  return (
    <div
      role="alert"
      className={cn("rounded-[28px] border-2 border-dashed border-danger/30 bg-danger-soft/40 px-6 py-10 text-center", className)}
    >
      <WifiSlash size={36} weight="duotone" className="mx-auto text-danger" />
      <h3 className="mt-3 font-display text-lg font-bold text-ink">{title ?? f.title}</h3>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{f.message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" className="mt-5" onClick={onRetry}>
          <ArrowClockwise size={16} weight="bold" /> Retry
        </Button>
      )}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton rounded-2xl", className)} aria-hidden />;
}

export function LoadingBlock({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 py-10 text-sm font-semibold text-muted", className)} role="status">
      <div className="h-2 w-40 overflow-hidden rounded-full bg-ink/10">
        <motion.div
          className="h-full w-1/3 rounded-full bg-gradient-to-r from-lavender to-purple"
          animate={{ x: ["-100%", "300%"] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
      {label}
    </div>
  );
}
