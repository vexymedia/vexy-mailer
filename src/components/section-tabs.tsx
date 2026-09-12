import { Tabs } from "./ui";

/** Podnavigace Komunikace: uživatelské věci vepředu, technické v Nastavení. */
export function KomunikaceTabs({ active }: { active: string }) {
  return (
    <Tabs
      active={active}
      items={[
        { href: "/inbox", label: "Odpovědi" },
        { href: "/campaigns", label: "Kampaně" },
      ]}
    />
  );
}

/** Podnavigace Nastavení: sem patří všechno technické. */
export function NastaveniTabs({ active }: { active: string }) {
  return (
    <Tabs
      active={active}
      items={[
        { href: "/settings", label: "Obecné" },
        { href: "/mailboxes", label: "Schránky" },
        { href: "/suppression", label: "Vyloučené firmy" },
      ]}
    />
  );
}
