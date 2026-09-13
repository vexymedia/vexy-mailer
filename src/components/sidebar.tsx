"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { logoutAction } from "@/lib/actions";

/**
 * Hlavní navigace.
 *
 * Sedm položek, seřazených podle toho, jak den obchodníka probíhá:
 * co se děje → koho řešíme → co mám udělat → co přišlo → co se stalo.
 * Technické věci (schránky, vyloučené firmy, worker) do hlavního menu
 * nepatří, jsou v Nastavení.
 */

interface Item {
  href: string;
  label: string;
  /** Další cesty, které do téhle sekce patří (kvůli zvýraznění). */
  also?: string[];
  icon: React.ReactNode;
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-[18px] shrink-0"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const ITEMS: Item[] = [
  { href: "/", label: "Přehled", icon: <Icon d="M3 12h6v9H3zM9 3h6v18H9zM15 8h6v13h-6z" /> },
  { href: "/firmy", label: "Firmy", also: ["/kontakt", "/contacts"], icon: <Icon d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h.01M15 17h.01" /> },
  { href: "/osloveni", label: "Oslovení", also: ["/volani"], icon: <Icon d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.1 9.9a16 16 0 0 0 6 6l1.26-1.26a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" /> },
  { href: "/inbox", label: "Komunikace", also: ["/campaigns"], icon: <Icon d="M4 4h16v16H4zM4 7l8 6 8-6" /> },
  { href: "/activity", label: "Aktivita", icon: <Icon d="M3 12h4l3 8 4-16 3 8h4" /> },
  { href: "/tym", label: "Tým", also: ["/calleri"], icon: <Icon d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /> },
  { href: "/settings", label: "Nastavení", also: ["/mailboxes", "/suppression"], icon: <Icon d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /> },
];

function isActive(pathname: string, item: Item): boolean {
  const paths = [item.href, ...(item.also ?? [])];
  if (item.href === "/") return pathname === "/";
  return paths.some((p) => p !== "/" && (pathname === p || pathname.startsWith(`${p}/`)));
}

function NavList({
  modeLabel,
  modeTone,
  onNavigate,
}: {
  modeLabel: string;
  modeTone: "live" | "test" | "warn";
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  const toneClass =
    modeTone === "live"
      ? "bg-red-500/15 text-red-200 ring-red-500/30"
      : modeTone === "warn"
        ? "bg-amber-500/15 text-amber-200 ring-amber-500/30"
        : "bg-zinc-100/10 text-zinc-300 ring-white/10";

  return (
    <nav className="flex h-full flex-col">
      <div className="px-5 py-5">
        <Link href="/" className="text-[15px] font-semibold tracking-tight text-white" onClick={onNavigate}>
          VEXY
        </Link>
        <p className="mt-0.5 text-[11px] text-zinc-500">Obchodní příprava a oslovení</p>
      </div>

      <ul className="flex-1 space-y-0.5 px-3">
        {ITEMS.map((item) => {
          const active = isActive(pathname, item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                  active
                    ? "bg-white/10 font-medium text-white"
                    : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                }`}
              >
                {item.icon}
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="space-y-3 border-t border-white/10 px-5 py-4">
        <Link href="/settings" onClick={onNavigate} className={`badge w-full justify-center ring-1 ${toneClass}`}>
          {modeLabel}
        </Link>
        <form action={logoutAction}>
          <button type="submit" className="text-xs text-zinc-500 transition-colors hover:text-zinc-200">
            Odhlásit
          </button>
        </form>
      </div>
    </nav>
  );
}

/** Pevná navigace na desktopu. */
export function SidebarRail(props: { modeLabel: string; modeTone: "live" | "test" | "warn" }) {
  return (
    <aside className="hidden w-60 shrink-0 border-r border-zinc-800 bg-zinc-900 lg:block">
      <div className="sticky top-0 h-screen">
        <NavList {...props} />
      </div>
    </aside>
  );
}

/**
 * Mobilní lišta s vysouvací navigací.
 *
 * Patří dovnitř obsahového sloupce, ne vedle sidebaru - jako flex sourozenec
 * by obsah odsunula do strany a stránka by přetékala do šířky.
 */
export function MobileNav(props: { modeLabel: string; modeTone: "live" | "test" | "warn" }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="flex items-center gap-3 border-b border-zinc-200 bg-white px-4 py-3 lg:hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label="Navigace"
          className="btn-secondary !px-2 !py-1.5"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-5">
            <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />
          </svg>
        </button>
        <span className="text-sm font-semibold tracking-tight text-zinc-900">VEXY</span>
      </div>

      {open ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Zavřít navigaci"
            className="absolute inset-0 bg-zinc-900/40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-64 bg-zinc-900">
            <NavList {...props} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
