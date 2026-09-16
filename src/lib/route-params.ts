import { notFound } from "next/navigation";

/**
 * Kontrola id z adresy, než se s ním půjde do databáze.
 *
 * Každá dynamická route bere id z URL a to si může kdokoli napsat ručně.
 * Postgres na `where id = 'neni-uuid'` odpoví chybou 22P02, ta probublá
 * ven jako neodchycená výjimka a uživatel dostane holé
 * „Application error … Digest: …" - tedy pád, ne stránku.
 *
 * Nesmyslné id není chyba serveru. Je to adresa, která neexistuje, takže
 * patří 404 - stejně jako u id, které má správný tvar, ale nic mu
 * neodpovídá. Uživatel tak vidí totéž v obou případech a nedá se z toho
 * vyčíst, co v databázi je a co ne.
 */

/** Tvar UUID, jak ho Postgres přijme. Verzi ani variantu neřešíme. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | null | undefined): boolean {
  return typeof value === "string" && UUID.test(value.trim());
}

/**
 * Vrátí id, nebo rovnou zobrazí 404.
 *
 * Používá se na začátku dynamické stránky, hned po `await params`.
 */
export function requireUuid(value: string): string {
  if (!isUuid(value)) notFound();
  return value;
}
