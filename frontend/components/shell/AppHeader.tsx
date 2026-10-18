"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { motion } from "motion/react";
import { GearSix, PuzzlePiece, SignOut, SquaresFour } from "@phosphor-icons/react";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils/cn";
import { Avatar } from "@/components/ui/primitives";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/overlay";
import { Logo } from "./Logo";

const NAV = [
  { href: "/workspaces", label: "Workspaces", Icon: SquaresFour },
  { href: "/extension", label: "Extension", Icon: PuzzlePiece },
  { href: "/settings", label: "Settings", Icon: GearSix },
];

export function UserMenu() {
  const { user, logout } = useAuthStore();
  const router = useRouter();
  if (!user) return null;
  return (
    <Menu>
      <MenuTrigger asChild>
        <button aria-label="Account menu" className="rounded-full transition hover:-translate-y-0.5">
          <Avatar name={user.name} color={user.avatar_color} size={36} />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Signed in as</MenuLabel>
        <div className="px-3 pb-2">
          <p className="text-sm font-bold">{user.name}</p>
          <p className="text-xs text-muted">{user.email}</p>
        </div>
        <MenuSeparator />
        <MenuItem onSelect={() => router.push("/workspaces")}>
          <SquaresFour size={18} weight="bold" /> Workspaces
        </MenuItem>
        <MenuItem onSelect={() => router.push("/settings")}>
          <GearSix size={18} weight="bold" /> Settings & extension
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          danger
          onSelect={async () => {
            await logout();
            router.replace("/login");
          }}
        >
          <SignOut size={18} weight="bold" /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function AppHeader() {
  const pathname = usePathname();
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-ink/5 bg-white/60 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <Logo />
          <nav className="hidden items-center gap-1 rounded-full bg-white p-1 shadow-clay-sm md:flex" aria-label="Main">
            {NAV.map(({ href, label, Icon }) => {
              const active = pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={cn("relative inline-flex h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold transition-colors", active ? "text-white" : "text-ink-soft hover:text-ink")}
                >
                  {active && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded-full bg-pill" transition={{ type: "spring", stiffness: 400, damping: 32 }} />}
                  <Icon size={18} weight={active ? "fill" : "regular"} className="relative" />
                  <span className="relative">{label}</span>
                </Link>
              );
            })}
          </nav>
          <UserMenu />
        </div>
      </header>
      <nav className="fixed inset-x-3 bottom-3 z-40 rounded-[28px] border border-line bg-white/95 px-2 py-1.5 shadow-pop backdrop-blur md:hidden" aria-label="Main">
        <ul className="flex items-center justify-around">
          {NAV.map(({ href, label, Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <li key={href}>
                <Link href={href} className="flex min-w-14 flex-col items-center gap-0.5 rounded-2xl px-2 py-1">
                  <span className={cn("grid h-9 w-12 place-items-center rounded-full transition-colors", active ? "bg-pill text-white" : "text-ink-soft")}>
                    <Icon size={20} weight={active ? "fill" : "regular"} />
                  </span>
                  <span className={cn("text-[10px] font-semibold", active ? "text-ink" : "text-muted")}>{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
