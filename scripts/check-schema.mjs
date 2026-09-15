#!/usr/bin/env node
/**
 * Ověří, že databáze obsahuje všechno, co nasazená aplikace čte.
 *
 * Vzniklo z konkrétního výpadku: na produkci chyběla migrace 0011 a detail
 * firmy spadl na "Application error ... Digest: ...". Seznam firem přitom
 * fungoval dál, protože nové sloupce nečte - takže z chování aplikace
 * nešlo poznat, co se děje.
 *
 *   DATABASE_URL=… node scripts/check-schema.mjs
 *   npm run db:check
 *
 * Kontroluje dvě věci zvlášť, protože se můžou rozejít:
 *
 *   1. Jsou všechny migrace ze souborů zapsané v schema_migrations?
 *   2. Existují opravdu sloupce a tabulky, které aplikace čte?
 *
 * Druhá kontrola je tu proto, že zápis v schema_migrations negarantuje,
 * že migrace doběhla celá.
 *
 * Nic nemění. Konec s kódem 1, když něco chybí - dá se pověsit do CI
 * nebo spustit po deployi.
 */
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config as loadEnv } from "dotenv";
import { MIGRATIONS, REQUIRED, findMissing } from "../src/lib/schema-contract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: join(root, ".env.local"), quiet: true });
loadEnv({ path: join(root, ".env"), quiet: true });

export { REQUIRED, findMissing };

/** Spouští se jen jako skript, ne při importu z testu. */
const isEntrypoint = process.argv[1] && process.argv[1].endsWith("check-schema.mjs");
if (!isEntrypoint) {
  // Import z testu: exportuje se jen REQUIRED a findMissing.
} else {
await main();
}

async function main() {
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Chybí DATABASE_URL.");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });
let problems = 0;

// Nedostupná databáze je jiný problém než rozjeté schéma a nesmí skončit
// stack tracem - tenhle skript se spouští proti produkci, často ve spěchu.
try {
  await sql`select 1`;
} catch (error) {
  console.error("K databázi se nepodařilo připojit.");
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  console.error("");
  console.error("Zkontrolujte DATABASE_URL — u Supabase se používá connection");
  console.error("pooler a v adrese musí být i ?sslmode=require.");
  await sql.end();
  process.exit(2);
}

try {
  // ---- 1. migrace ------------------------------------------------------
  // Soubory na disku musí odpovídat kontraktu. Kdyby někdo přidal migraci
  // a zapomněl ji do seznamu, aplikace za běhu (kde složka není) by o ní
  // nevěděla - takže je to chyba hned tady, ne až na produkci.
  const onDisk = readdirSync(join(root, "supabase", "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const files = [...MIGRATIONS];
  const drift = [
    ...onDisk.filter((f) => !files.includes(f)).map((f) => `  + ${f} (na disku, ne v kontraktu)`),
    ...files.filter((f) => !onDisk.includes(f)).map((f) => `  - ${f} (v kontraktu, ne na disku)`),
  ];
  if (drift.length > 0) {
    problems += drift.length;
    console.log("Seznam migrací v src/lib/schema-contract.mjs nesedí se soubory:");
    for (const line of drift) console.log(line);
    console.log("");
  }

  const [table] = await sql`select to_regclass('public.schema_migrations') as name`;
  const applied = table?.name
    ? new Set((await sql`select name from schema_migrations`).map((r) => r.name))
    : new Set();

  const missing = files.filter((f) => !applied.has(f));
  if (missing.length === 0) {
    console.log(`Migrace: všech ${files.length} je aplikovaných.`);
  } else {
    problems += missing.length;
    console.log(`Migrace: CHYBÍ ${missing.length} z ${files.length}`);
    for (const file of missing) console.log(`  - ${file}`);
  }

  // ---- 2. skutečné sloupce --------------------------------------------
  console.log("");
  const rows = await sql`
    select table_name, column_name from information_schema.columns
     where table_schema = 'public'
  `;
  const present = new Map();
  for (const row of rows) {
    if (!present.has(row.table_name)) present.set(row.table_name, new Set());
    present.get(row.table_name).add(row.column_name);
  }

  for (const gap of findMissing(present)) {
    problems++;
    console.log(
      gap.missingTable
        ? `CHYBÍ tabulka ${gap.table}  (${gap.since} · ${gap.feature})`
        : `CHYBÍ ${gap.table}.${gap.columns.join(", ")}  (${gap.since} · ${gap.feature})`,
    );
  }

  console.log("");
  if (problems === 0) {
    console.log("Databáze odpovídá nasazené aplikaci.");
  } else {
    console.log(`Databáze je pozadu za aplikací (${problems} ${problems === 1 ? "problém" : "problémů"}).`);
    console.log("Spusťte:  npm run db:migrate");
    console.log("Dokud se to nespraví, stránky, které chybějící sloupce čtou,");
    console.log("skončí chybou 500 — ostatní budou vypadat funkčně.");
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
}
