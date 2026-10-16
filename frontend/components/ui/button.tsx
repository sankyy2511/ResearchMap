"use client";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

/** DESIGN.md §8 — capsule buttons with tactile press physics. */
const VARIANTS = {
  primary:
    "bg-pill text-white border-2 border-pill shadow-pop-purple hover:-translate-y-0.5 active:translate-y-0 active:shadow-none",
  purple:
    "bg-purple text-white border border-line shadow-pop hover:-translate-y-0.5 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none",
  secondary: "bg-white text-ink shadow-clay-sm hover:-translate-y-0.5 active:scale-[0.97]",
  outline:
    "bg-white text-ink border border-line shadow-pop hover:-translate-y-0.5 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none",
  soft: "bg-lavender-soft text-purple-deep hover:bg-lavender/60 active:scale-[0.97]",
  danger: "bg-danger text-white hover:brightness-110 active:scale-[0.97]",
  success: "bg-success text-white hover:brightness-110 active:scale-[0.97]",
  ghost: "bg-transparent text-ink hover:bg-ink/5 active:scale-[0.97]",
  sun: "bg-sun text-ink border border-line shadow-pop hover:-translate-y-0.5 active:translate-x-[2px] active:translate-y-[2px] active:shadow-none",
} as const;

const SIZES = {
  xs: "h-7 px-2.5 text-[12px] gap-1",
  sm: "h-9 px-3.5 text-[13px] gap-1.5",
  md: "h-11 px-5 text-sm gap-2",
  lg: "h-14 px-7 text-base gap-2.5",
  icon: "h-11 w-11 p-0",
  "icon-sm": "h-9 w-9 p-0",
  "icon-xs": "h-7 w-7 p-0",
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "relative inline-flex select-none items-center justify-center whitespace-nowrap rounded-full font-semibold transition-all duration-200 disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading && (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
      )}
      {children}
    </button>
  );
});
