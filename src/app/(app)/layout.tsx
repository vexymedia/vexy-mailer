import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSettings } from "@/lib/settings";
import { MobileNav, SidebarRail } from "@/components/sidebar";
import { CallProvider } from "@/components/call/call-provider";
import { CallSurface } from "@/components/call/call-surface";

export const dynamic = "force-dynamic";

/**
 * Aplikační shell: pevná levá navigace, světlá pracovní plocha.
 *
 * Režim odesílání se hlásí decentním štítkem v sidebaru, ne přes celou
 * šířku obrazovky. Přes celou šířku se ozve jen stav, který reálně blokuje
 * práci - tedy špatně nastavené přesměrování.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const settings = await getSettings();

  const misconfigured = settings.test_mode && settings.test_behavior === "redirect" && !settings.test_email;
  const modeLabel = settings.test_mode ? "Testovací režim" : "Ostré odesílání";
  const modeTone = misconfigured ? "warn" : settings.test_mode ? "test" : "live";

  return (
    // CallProvider obaluje celý shell schválně: hovor drží layout, ne
    // stránka, takže přechod na jinou obrazovku ho nepoloží.
    <CallProvider>
      <div className="flex min-h-screen bg-zinc-50">
        <SidebarRail modeLabel={modeLabel} modeTone={modeTone} role={user.role} userName={user.name} />
        <div className="flex min-w-0 flex-1 flex-col">
          <MobileNav modeLabel={modeLabel} modeTone={modeTone} role={user.role} userName={user.name} />
          {misconfigured ? (
            <div className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-amber-900">
              Je zvolené přesměrování, ale chybí testovací adresa — nic se neodešle.{" "}
              <Link href="/settings" className="underline underline-offset-2">
                Opravit v nastavení
              </Link>
            </div>
          ) : null}
          <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
            {children}
          </main>
          {/* Uvnitř obsahového sloupce: lišta je fixní, ale rozpěrka pod
              obsahem musí být v normálním toku, jinak by ze sebe vedle
              sidebaru udělala další sloupec. */}
          <CallSurface />
        </div>
      </div>
    </CallProvider>
  );
}
