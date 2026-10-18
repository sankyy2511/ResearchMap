import Link from "next/link";
import { Browsers } from "@phosphor-icons/react/dist/ssr";
import { APP_NAME } from "@/lib/api/config";
import { cn } from "@/lib/utils/cn";

export function Logo({ href = "/workspaces", compact, className }: { href?: string; compact?: boolean; className?: string }) {
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2 rounded-full", className)} aria-label={`${APP_NAME} home`}>
      <span className="grid h-9 w-9 -rotate-6 place-items-center rounded-[30%] border border-white/70 bg-brand-gradient shadow-pop">
        <Browsers size={20} weight="bold" className="text-ink" />
      </span>
      {!compact && <span className="font-display text-[15px] font-extrabold tracking-tight text-ink">{APP_NAME}</span>}
    </Link>
  );
}
