import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { REQUIRED, findMissing } from "../scripts/check-schema.mjs";

/**
 * Rozjetá databáze proti nasazené aplikaci.
 *
 * Vzniklo z produkčního výpadku: na Vercelu chyběla migrace 0011, takže
 * `contacts.loom_url` neexistoval a detail firmy skončil na
 * "Application error ... Digest". Seznam firem fungoval dál, protože ty
 * sloupce nečte - z chování aplikace tedy nešlo poznat, co se děje.
 *
 * Testují se dvě strany té samé chyby:
 *
 *   1. Aplikace nesmí číst sloupec, který žádná migrace nevytváří.
 *      (To je verze, která se dá chytit u nás, před nasazením.)
 *   2. Kontrola schématu musí chybějící sloupec opravdu najít.
 *      (Aby se na ni dalo spolehnout při ověřování produkce.)
 */

let sql: typeof import("@/lib/db").sql;

beforeAll(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
});

afterAll(async () => {
  await closeDatabase();
});

/** Co v databázi po všech migracích skutečně je. */
async function actualColumns(): Promise<Map<string, Set<string>>> {
  const rows = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
     where table_schema = 'public'
  `;
  const present = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!present.has(row.table_name)) present.set(row.table_name, new Set());
    present.get(row.table_name)!.add(row.column_name);
  }
  return present;
}

describe("schéma odpovídá aplikaci", () => {
  it("po všech migracích nechybí nic, co aplikace čte", async () => {
    const missing = findMissing(await actualColumns());
    // Kdyby tohle spadlo, znamená to, že kód čte sloupec, který žádná
    // migrace nevytváří - a na produkci by z toho byla chyba 500.
    expect(missing).toEqual([]);
  });

  it("sloupce z migrace 0011 v databázi opravdu jsou", async () => {
    // Konkrétně ty, na kterých produkce spadla.
    const present = await actualColumns();
    const contacts = present.get("contacts");
    for (const column of ["loom_url", "loom_title", "loom_sent_at", "loom_note", "call_opener"]) {
      expect(contacts?.has(column)).toBe(true);
    }
  });
});

describe("kontrola schématu chybějící migraci najde", () => {
  it("pozná chybějící sloupec", async () => {
    const present = await actualColumns();
    // Přesně produkční stav: 0011 neproběhla.
    present.get("contacts")!.delete("loom_url");

    const missing = findMissing(present);
    expect(missing).toHaveLength(1);
    expect(missing[0].table).toBe("contacts");
    expect(missing[0].columns).toEqual(["loom_url"]);
    expect(missing[0].since).toBe("0011");
  });

  it("pozná chybějící tabulku", async () => {
    const present = await actualColumns();
    present.delete("clients");

    const missing = findMissing(present);
    expect(missing.some((gap) => gap.table === "clients" && gap.missingTable)).toBe(true);
  });

  it("hlídá i migrace, které přišly po volání a klientech", () => {
    // Seznam se musí rozšiřovat s migracemi, jinak kontrola tiše zestárne.
    const covered = new Set(REQUIRED.map((need: { since: string }) => need.since));
    for (const migration of ["0011", "0012", "0013"]) {
      expect(covered.has(migration)).toBe(true);
    }
  });
});
