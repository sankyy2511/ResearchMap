"use client";
import {
  forwardRef,
  useState,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Check } from "@phosphor-icons/react";
import type { Icon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils/cn";
import { initials } from "@/lib/utils/format";
import { TONE_BG, TONE_HEX, TONE_SOFT, type Tone } from "@/lib/domain/meta";

/* ---------------------------------------------------------------- Card (§9) */

const CARD = {
  clay: "bg-white shadow-clay rounded-[28px]",
  bento: "bg-white border border-line-cool shadow-soft rounded-2xl",
  sticker: "bg-white border border-line shadow-pop-lg rounded-[24px]",
  flat: "bg-white rounded-2xl border border-line",
  soft: "rounded-[24px]",
} as const;

export function Card({
  variant = "clay",
  interactive,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { variant?: keyof typeof CARD; interactive?: boolean }) {
  return (
    <div
      className={cn(
        CARD[variant],
        interactive && "cursor-pointer transition duration-300 hover:-translate-y-0.5 hover:shadow-pop",
        className,
      )}
      {...rest}
    />
  );
}

/* ---------------------------------------------------------------- Inputs (§10) */

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-12 w-full rounded-2xl border-2 border-transparent bg-white px-4 text-sm font-medium text-ink shadow-clay-sm outline-none transition placeholder:text-faint focus:border-purple aria-[invalid=true]:border-danger",
        className,
      )}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "min-h-28 w-full resize-none rounded-2xl border-2 border-transparent bg-white px-4 py-3 text-sm font-medium text-ink shadow-clay-sm outline-none placeholder:text-faint focus:border-purple",
          className,
        )}
        {...rest}
      />
    );
  },
);

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-11 cursor-pointer appearance-none rounded-2xl border-2 border-transparent bg-white bg-[length:12px] bg-[right_14px_center] bg-no-repeat pl-4 pr-9 text-sm font-semibold text-ink shadow-clay-sm outline-none focus:border-purple",
        "bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2212%22 height=%2212%22 viewBox=%220 0 256 256%22><path fill=%22%231c1b2b%22 d=%22M213.66 101.66l-80 80a8 8 0 0 1-11.32 0l-80-80a8 8 0 0 1 11.32-11.32L128 164.69l74.34-74.35a8 8 0 0 1 11.32 11.32Z%22/></svg>')]",
        className,
      )}
      {...rest}
    />
  );
}

export function Label({ children, htmlFor, hint }: { children: ReactNode; htmlFor?: string; hint?: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 flex items-baseline justify-between gap-2 text-[13px] font-bold text-ink-soft">
      <span>{children}</span>
      {hint && <span className="text-xs font-medium text-faint">{hint}</span>}
    </label>
  );
}

export function Chip({
  selected,
  tone = "lavender",
  size = "sm",
  className,
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean; tone?: Tone; size?: "sm" | "md" }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-semibold transition-all active:scale-95",
        size === "sm" ? "h-8 px-3 text-xs" : "h-10 px-4 text-sm",
        selected ? cn(TONE_BG[tone], "text-ink shadow-pop ring-2 ring-ink") : "bg-white text-ink-soft shadow-clay-sm hover:-translate-y-0.5",
        className,
      )}
      {...rest}
    >
      {selected && <Check size={12} weight="bold" />}
      {children}
    </button>
  );
}

export function Switch({ checked, onCheckedChange, label, id }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; id?: string }) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      aria-label={label}
      className="relative h-7 w-12 shrink-0 rounded-full bg-ink/15 transition-colors data-[state=checked]:bg-purple"
    >
      <SwitchPrimitive.Thumb className="block h-5 w-5 translate-x-1 rounded-full bg-white shadow-md transition-transform data-[state=checked]:translate-x-6" />
    </SwitchPrimitive.Root>
  );
}

/* ---------------------------------------------------------------- Badges / Kicker / ArtTile */

export function Pill({ tone = "ink", className, children, ...rest }: HTMLAttributes<HTMLSpanElement> & { tone?: Tone }) {
  return (
    <span
      className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold leading-4", TONE_SOFT[tone], className)}
      {...rest}
    >
      {children}
    </span>
  );
}

export function Kicker({ children, className, tone = "sun" }: { children: ReactNode; className?: string; tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-block -rotate-1 rounded-full border border-line px-3 py-1 text-[11px] font-bold uppercase tracking-[0.14em] text-ink shadow-pop",
        TONE_BG[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function ArtTile({ icon: IconC, tone, size = 44, className }: { icon: Icon; tone: Tone; size?: number; className?: string }) {
  return (
    <span
      className={cn("inline-grid shrink-0 place-items-center rounded-[30%]", TONE_BG[tone], className)}
      style={{ width: size, height: size, background: TONE_HEX[tone].solid }}
      aria-hidden
    >
      <IconC size={size * 0.52} weight="bold" color={tone === "purple" || tone === "ink" ? "#ffffff" : TONE_HEX[tone].deep} />
    </span>
  );
}

export function Avatar({ name, color, size = 28, ring, className }: { name: string; color: string; size?: number; ring?: boolean; className?: string }) {
  return (
    <span
      title={name}
      className={cn("inline-grid shrink-0 place-items-center rounded-full border-2 border-white font-bold text-white", ring && "ring-2 ring-ink", className)}
      style={{ width: size, height: size, background: color, fontSize: size * 0.38 }}
    >
      {initials(name)}
    </span>
  );
}

export function AvatarStack({ people, max = 4, size = 28 }: { people: { name: string; color: string; online?: boolean }[]; max?: number; size?: number }) {
  return (
    <div className="flex items-center">
      {people.slice(0, max).map((p, i) => (
        <span key={i} className="relative -ml-2 first:ml-0">
          <Avatar name={p.name} color={p.color} size={size} />
          {p.online && <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-success" />}
        </span>
      ))}
      {people.length > max && (
        <span className="-ml-2 grid place-items-center rounded-full border-2 border-white bg-canvas-cool text-[10px] font-bold text-ink-soft" style={{ width: size, height: size }}>
          +{people.length - max}
        </span>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Tooltip */

export function Tip({ label, children, side = "bottom" }: { label: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <TooltipPrimitive.Root delayDuration={250}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className="z-[95] max-w-xs rounded-xl bg-ink px-2.5 py-1.5 text-xs font-semibold text-white shadow-float"
        >
          {label}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/* ---------------------------------------------------------------- Segmented tabs with spring pill */

import { motion } from "motion/react";
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  layoutId,
  size = "sm",
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; icon?: Icon; hint?: string }[];
  layoutId: string;
  size?: "xs" | "sm";
  className?: string;
}) {
  return (
    <div role="tablist" className={cn("inline-flex items-center gap-0.5 rounded-full bg-white p-1 shadow-clay-sm", className)}>
      {options.map((o) => {
        const active = o.value === value;
        const I = o.icon;
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            title={o.hint ?? o.label}
            onClick={() => onChange(o.value)}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-full font-semibold transition-colors",
              size === "xs" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]",
              active ? "text-white" : "text-ink-soft hover:text-ink",
            )}
          >
            {active && (
              <motion.span layoutId={layoutId} className="absolute inset-0 rounded-full bg-pill" transition={{ type: "spring", stiffness: 400, damping: 32 }} />
            )}
            {I && <I size={15} weight={active ? "fill" : "bold"} className="relative" />}
            <span className="relative">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- Confidence meter */

export function Confidence({ value, className }: { value: number | null; className?: string }) {
  if (value == null) return null;
  const pct = Math.round(value * 100);
  const color = pct >= 70 ? "#23864b" : pct >= 50 ? "#a4660a" : "#c93535";
  return (
    <span className={cn("inline-flex items-center gap-2", className)} aria-label={`Confidence ${pct}%`}>
      <span className="h-2 w-20 overflow-hidden rounded-full bg-ink/10">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </span>
      <span className="tabular text-xs font-bold" style={{ color }}>
        {pct}%
      </span>
    </span>
  );
}

/* ---------------------------------------------------------------- tiny Markdown renderer (safe: no raw HTML) */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("**")) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("[")) {
      const [, label, href] = t.match(/\[([^\]]+)\]\(([^)]+)\)/) ?? [];
      const safe = href && /^https?:\/\//.test(href) ? href : undefined;
      out.push(
        <a key={k} href={safe} target="_blank" rel="noreferrer noopener">
          {label}
        </a>,
      );
    } else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split(/\r?\n/);
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const L = list.ordered ? "ol" : "ul";
    blocks.push(
      <L key={`l${blocks.length}`}>
        {list.items.map((it, i) => (
          <li key={i}>{inline(it, `li${blocks.length}-${i}`)}</li>
        ))}
      </L>,
    );
    list = null;
  };
  lines.forEach((line, idx) => {
    const ul = line.match(/^\s*[-*]\s+(.*)/);
    const ol = line.match(/^\s*\d+\.\s+(.*)/);
    if (ul || ol) {
      const ordered = !!ol;
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push((ul ?? ol)![1]!);
      return;
    }
    flush();
    if (!line.trim()) return;
    const h = line.match(/^(#{1,3})\s+(.*)/);
    if (h) blocks.push(<h3 key={idx}>{inline(h[2]!, `h${idx}`)}</h3>);
    else if (line.startsWith("> ")) blocks.push(<blockquote key={idx}>{inline(line.slice(2), `q${idx}`)}</blockquote>);
    else blocks.push(<p key={idx}>{inline(line, `p${idx}`)}</p>);
  });
  flush();
  return <div className={cn("md text-sm leading-relaxed", className)}>{blocks}</div>;
}

/* ---------------------------------------------------------------- Copy field */

export function CopyField({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-canvas p-1.5 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-soft">{value}</code>
      <button
        className="shrink-0 rounded-full bg-ink px-3 py-1.5 text-xs font-bold text-white hover:bg-purple"
        onClick={() => {
          void navigator.clipboard?.writeText(value).catch(() => undefined);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied ✓" : label}
      </button>
    </div>
  );
}
