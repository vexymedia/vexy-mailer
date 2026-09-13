import { Tabs } from "./ui";

/**
 * Oslovení má tři pohledy na tutéž práci: co dělat teď, co čeká, a kdy to
 * kdo bude dělat. Týdenní plán je proto podsekce, ne další hlavní modul.
 */
export function OsloveniTabs({ active }: { active: string }) {
  return (
    <Tabs
      active={active}
      items={[
        { href: "/osloveni", label: "Dnes" },
        { href: "/osloveni/fronta", label: "Fronta" },
        { href: "/osloveni/plan", label: "Plán" },
      ]}
    />
  );
}
