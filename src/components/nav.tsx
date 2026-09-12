"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { logoutAction } from "@/lib/actions";

const LINKS = [
  { href: "/", label: "Přehled" },
  { href: "/volani", label: "Volání" },
  { href: "/inbox", label: "Doručená pošta" },
  { href: "/campaigns", label: "Kampaně" },
  { href: "/contacts", label: "Kontakty" },
  { href: "/calleri", label: "Calleři" },
  { href: "/mailboxes", label: "Schránky" },
  { href: "/suppression", label: "Nekontaktovat" },
  { href: "/activity", label: "Aktivita" },
  { href: "/settings", label: "Nastavení" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="border-b border-zinc-200 bg-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-1 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="mr-4 text-sm font-semibold tracking-tight text-zinc-900">
          vexy<span className="text-zinc-400">-mailer</span>
        </Link>
        {LINKS.map((link) => {
          const active = link.href === "/" ? pathname === "/" : pathname.startsWith(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                active ? "bg-zinc-100 font-medium text-zinc-900" : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
              }`}
            >
              {link.label}
            </Link>
          );
        })}
        <form action={logoutAction} className="ml-auto">
          <button type="submit" className="text-sm text-zinc-500 hover:text-zinc-900">
            Odhlásit
          </button>
        </form>
      </div>
    </nav>
  );
}
