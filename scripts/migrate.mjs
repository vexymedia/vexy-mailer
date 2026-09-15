#!/usr/bin/env node
/**
 * Aplikuje migrace ze supabase/migrations v pořadí podle názvu.
 *
 * Tři vlastnosti, na kterých to stojí:
 *
 *   1. IDEMPOTENCE. Aplikované migrace jsou zapsané v schema_migrations,
 *      takže běžný běh je přeskočí. Pustit to podruhé nic nerozbije.
 *
 *   2. ATOMICITA PO SOUBORECH. Každá migrace i její zápis do
 *      schema_migrations běží v JEDNÉ transakci. Když migrace selže
 *      uprostřed, vrátí se celá a nezůstane zapsaná - takže nikdy
 *      nevznikne stav "zapsáno jako hotové, ale provedené jen z půlky".
 *
 *   3. ZASTAVENÍ PŘI CHYBĚ. První selhání běh ukončí. Další migrace se
 *      nepouštějí, protože by stavěly na schématu, které nevzniklo.
 *
 * Zámek brání dvěma souběžným nasazením migrovat naráz.
 *
 *   npm run db:migrate
 *   DATABASE_URL=… node scripts/migrate.mjs
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config as loadEnv } from "dotenv";
import { MIGRATIONS } from "../src/lib/schema-contract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "supabase", "migrations");

// Stejné pořadí jako u Next.js: .env.local přebíjí .env.
loadEnv({ path: join(root, ".env.local"), quiet: true });
loadEnv({ path: join(root, ".env"), quiet: true });

/** Číslo, na kterém se domluví všechna nasazení téhle aplikace. */
const MIGRATION_LOCK = 4_120_250_915;

export function connect(url) {
  return postgres(url, {
    max: 1,
    prepare: false,
    ssl: url.includes("sslmode=disable") ? false : "prefer",
    onnotice: () => {},
  });
}

/**
 * Soubory na disku proti seznamu v kontraktu.
 *
 * Aplikace za běhu složku supabase/migrations nevidí (na Vercelu se do
 * funkce nedostane), takže porovnává proti seznamu v kódu. Kdyby se ty
 * dva rozešly, aplikace by o chybějící migraci nevěděla - proto je to
 * chyba tady, ne tiché nedorozumění na produkci.
 */
export function migrationDrift() {
  const onDisk = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  return [
    ...onDisk.filter((f) => !MIGRATIONS.includes(f)).map((f) => `${f} je na disku, ale ne v src/lib/schema-contract.mjs`),
    ...MIGRATIONS.filter((f) => !onDisk.includes(f)).map((f) => `${f} je v src/lib/schema-contract.mjs, ale ne na disku`),
  ];
}

/**
 * Aplikuje, co chybí. Vrací přehled, nic nevypisuje sám - volající
 * rozhodne, jestli to jde do terminálu nebo do logu nasazení.
 */
export async function applyMigrations(sql, { force = false, onProgress } = {}) {
  const drift = migrationDrift();
  if (drift.length > 0) {
    throw new Error(`Seznam migrací nesedí se soubory:\n  ${drift.join("\n  ")}`);
  }

  await sql`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;

  // Dvě souběžná nasazení by jinak pustila tutéž migraci dvakrát. Zámek
  // se drží po celou dobu spojení; druhý běh počká, než první doběhne,
  // a pak už nemá co dělat.
  await sql`select pg_advisory_lock(${MIGRATION_LOCK})`;
  try {
    const applied = new Set((await sql`select name from schema_migrations`).map((r) => r.name));
    const results = [];

    for (const file of MIGRATIONS) {
      if (applied.has(file) && !force) {
        results.push({ file, status: "skipped" });
        onProgress?.({ file, status: "skipped" });
        continue;
      }
      onProgress?.({ file, status: "applying" });
      // Migrace i její zápis v jedné transakci: buď obojí, nebo nic.
      await sql.begin(async (tx) => {
        await tx.unsafe(readFileSync(join(dir, file), "utf8"));
        await tx`insert into schema_migrations (name) values (${file}) on conflict (name) do nothing`;
      });
      results.push({ file, status: "applied" });
      onProgress?.({ file, status: "applied" });
    }
    return results;
  } finally {
    await sql`select pg_advisory_unlock(${MIGRATION_LOCK})`;
  }
}

/** Spouští se jen jako skript, ne při importu. */
const isEntrypoint = process.argv[1]?.endsWith("migrate.mjs");
if (isEntrypoint) await main();

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("Chybí DATABASE_URL. Zkopírujte .env.example do .env.local a vyplňte ho.");
    process.exit(1);
  }

  const sql = connect(url);
  try {
    const results = await applyMigrations(sql, {
      force: process.argv.includes("--force"),
      onProgress: ({ file, status }) => {
        if (status === "skipped") console.log(`  přeskočeno  ${file} (už aplikované)`);
        if (status === "applying") process.stdout.write(`  aplikuji    ${file} ... `);
        if (status === "applied") console.log("ok");
      },
    });
    const count = results.filter((r) => r.status === "applied").length;
    console.log(count === 0 ? "\nDatabáze je aktuální." : `\nAplikováno migrací: ${count}.`);
  } catch (error) {
    // Jasně a bez stack trace: tohle se čte ve spěchu, často z logu nasazení.
    console.error("\nMigrace selhala a byla vrácena zpět. Schéma zůstalo, jaké bylo.");
    console.error(`  ${error.message}`);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}
