"use client";
/** DESIGN.md §11.2 adaptive modal / sheet — bottom sheet on phones, modal or side drawer on desktop. */
import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { X } from "@phosphor-icons/react";
import { cn } from "@/lib/utils/cn";

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = "md",
  side = false,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  side?: boolean;
}) {
  const w = { sm: "sm:max-w-md", md: "sm:max-w-lg", lg: "sm:max-w-2xl", xl: "sm:max-w-5xl" }[size];
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-ink/40 backdrop-blur-[2px] data-[state=open]:animate-[fadeIn_.2s]" />
        <Dialog.Content
          className={cn(
            "fixed inset-x-0 bottom-0 z-[61] flex max-h-[92dvh] flex-col rounded-t-[32px] border border-line bg-canvas shadow-float outline-none",
            side
              ? "sm:inset-x-auto sm:bottom-3 sm:right-3 sm:top-3 sm:w-[520px] sm:max-h-none sm:rounded-[32px]"
              : cn("sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[32px] sm:shadow-float", w),
          )}
        >
          <div className="mx-auto mt-2.5 h-1.5 w-12 rounded-full bg-ink/15 sm:hidden" aria-hidden />
          <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-4 sm:px-6 sm:pt-6">
            <div className="min-w-0">
              <Dialog.Title className="font-display text-lg font-bold text-ink">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-1 text-sm text-muted">{description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">Dialog</Dialog.Description>
              )}
            </div>
            <Dialog.Close
              aria-label="Close"
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white shadow-clay-sm transition hover:rotate-90"
            >
              <X size={18} weight="bold" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 sm:px-6">{children}</div>
          {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-4 sm:px-6">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  message,
  confirmLabel = "Confirm",
  danger,
  onConfirm,
  loading,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  loading?: boolean;
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <button className="h-11 rounded-full px-5 text-sm font-semibold hover:bg-ink/5" onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button
            disabled={loading}
            className={cn(
              "h-11 rounded-full px-5 text-sm font-semibold text-white transition active:scale-[0.97] disabled:opacity-50",
              danger ? "bg-danger hover:brightness-110" : "border border-line bg-purple shadow-pop",
            )}
            onClick={onConfirm}
          >
            {loading ? "Working…" : confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-sm text-ink-soft">{message}</div>
    </Modal>
  );
}

/* ---------------------------------------------------------------- Menu */

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export function MenuContent({ children, align = "end", className }: { children: ReactNode; align?: "start" | "end" | "center"; className?: string }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        align={align}
        sideOffset={8}
        className={cn("z-[80] min-w-52 rounded-[20px] border border-line bg-white p-1.5 shadow-pop-lg", className)}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}
export function MenuItem({ children, onSelect, danger, disabled }: { children: ReactNode; onSelect?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <DropdownMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-semibold outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[highlighted]:bg-canvas",
        danger ? "text-danger" : "text-ink",
      )}
    >
      {children}
    </DropdownMenu.Item>
  );
}
export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenu.Label className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-faint">{children}</DropdownMenu.Label>;
}
export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}

/* ---------------------------------------------------------------- Popover */

export function Pop({ trigger, children, align = "start", className }: { trigger: ReactNode; children: ReactNode; align?: "start" | "end" | "center"; className?: string }) {
  return (
    // modal: a click anywhere outside closes it, also on the map (the map stops normal click events).
    <Popover.Root modal>
      <Popover.Trigger asChild>{trigger}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          sideOffset={8}
          className={cn("z-[80] w-80 rounded-[22px] border border-line bg-white p-4 shadow-pop-lg outline-none", className)}
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
