import Link from "next/link";
import { getSettings } from "@/lib/settings";

/**
 * Deliberately loud in both directions. The dangerous state is not "test mode
 * on" - it is being wrong about which mode you are in, so both are stated
 * explicitly on every page.
 */
export async function TestModeBanner() {
  const settings = await getSettings();

  if (!settings.test_mode) {
    return (
      <div className="border-b border-red-200 bg-red-600 px-4 py-2 text-center text-sm font-medium text-white">
        OSTRÉ ODESÍLÁNÍ — testovací režim je vypnutý. E-maily jdou skutečným kontaktům.{" "}
        <Link href="/settings" className="underline underline-offset-2">
          Nastavení
        </Link>
      </div>
    );
  }

  // Redirect mode without an address blocks every send, so say so plainly
  // instead of rendering "redirected to null".
  if (settings.test_behavior === "redirect" && !settings.test_email) {
    return (
      <div className="border-b border-red-200 bg-red-100 px-4 py-2 text-center text-sm text-red-900">
        <span className="font-semibold">TESTOVACÍ REŽIM je špatně nastavený</span> — je zvolené
        přesměrování, ale chybí testovací adresa, takže nelze odeslat vůbec nic.{" "}
        <Link href="/settings" className="underline underline-offset-2">
          Opravit v nastavení
        </Link>
      </div>
    );
  }

  return (
    <div className="border-b border-amber-200 bg-amber-100 px-4 py-2 text-center text-sm text-amber-900">
      <span className="font-semibold">TESTOVACÍ REŽIM</span>{" "}
      {settings.test_behavior === "simulate"
        ? "— na žádný SMTP server se nic neposílá; odeslání se jen zapíše do aktivity."
        : `— každý e-mail se přesměruje na ${settings.test_email}.`}{" "}
      <Link href="/settings" className="underline underline-offset-2">
        Nastavení
      </Link>
    </div>
  );
}
