import { requireAdmin } from "@/lib/auth";

/**
 * Administrace.
 *
 * Route group `(admin)` neovlivňuje adresy - `/settings` zůstává
 * `/settings`. Jediné, co přidává, je tenhle layout: jedna kontrola
 * role pro všechny stránky uvnitř. Díky tomu je zřejmé, co je
 * administrace, už z uspořádání souborů, a nedá se sem přidat stránka
 * a zapomenout na oprávnění.
 *
 * Skrytí položky v menu je UX. Tohle je bezpečnost - platí i když si
 * někdo adresu napíše ručně.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return <>{children}</>;
}
