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

/**
 * Adresa pro migrace. Schválně JINÁ než runtime.
 *
 * Runtime jede přes transaction pooler (:6543), protože serverless
 * potřebuje spojení vracet po každé transakci. Jenže právě to rozbíjí
 * `pg_advisory_lock()`: zámek je vázaný na SEZENÍ, a v transakčním režimu
 * se spojení po commitu vrátí do poolu a příští dotaz může jít po jiném
 * fyzickém spojení. Zámek by pak nedržel nic - dvě souběžná nasazení by
 * si o tom nic neřekla a migrovala naráz.
 *
 * Proto má migrace vlastní `MIGRATION_DATABASE_URL` mířící na SESSION
 * pooler (:5432) nebo na přímé spojení. Migrace běží jednou za nasazení,
 * takže jí strop session režimu nevadí.
 *
 * Když proměnná chybí, zkusí se DATABASE_URL - kvůli lokálnímu vývoji,
 * kde je to jedna a tatáž přímá adresa.
 */
export function migrationUrl() {
  return process.env.MIGRATION_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim() || "";
}

/** Vede adresa přes transaction pooler? Tam advisory zámek nedrží. */
export function isTransactionPooler(url) {
  return url.includes(":6543");
}

/**
 * Proč se přes tuhle adresu migrovat nesmí. Null = smí se.
 *
 * Radši hlasité selhání než tichá migrace bez funkčního zámku: to druhé
 * se projeví až tím, že dvě nasazení pustí tutéž migraci naráz.
 */
export function migrationUrlProblem(url = migrationUrl()) {
  if (!url) return "Chybí MIGRATION_DATABASE_URL (ani DATABASE_URL).";
  if (isTransactionPooler(url)) {
    return (
      "MIGRATION_DATABASE_URL vede přes transaction pooler (port 6543).\n" +
      "  Tam nedrží pg_advisory_lock, takže by dvě souběžná nasazení mohla\n" +
      "  migrovat naráz. Nastavte MIGRATION_DATABASE_URL na Supabase SESSION\n" +
      "  pooler (port 5432); DATABASE_URL nechte na 6543 pro runtime."
    );
  }
  return null;
}

export function connect(url) {
  return postgres(url, {
    // Jedno spojení: zámek i migrace musí jít po tomtéž sezení.
    max: 1,
    prepare: false,
    // Stejně jako v runtime klientovi: vyžadovat, ne preferovat. `prefer`
    // by při nedostupném TLS tiše přešlo na nešifrované spojení, a přes
    // tohle spojení jde celé schéma. Options přebíjejí parametry z URL,
    // takže `?sslmode=require` v adrese by se stejně neuplatnilo.
    ssl: url.includes("sslmode=disable") ? false : "require",
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
 *
 * @param {any} sql
 * @param {{ force?: boolean,
 *           onProgress?: (event: { file: string,
 *                                  status: "skipped" | "applying" | "applied" }) => void
 *                        | Promise<void> }} [options]
 * @returns {Promise<Array<{ file: string, status: "skipped" | "applied" }>>}
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

  // Dvě souběžná nasazení by jinak pustila tutéž migraci dvakrát.
  //
  // `reserve()` vytáhne z poolu JEDNO spojení a drží ho po celý běh. To je
  // podstatné: pg_advisory_lock je zámek SEZENÍ, takže musí být vzat
  // i uvolněn po tomtéž spojení a všechno mezi tím musí jít po něm taky.
  // Spoléhat na to, že při max:1 to stejně vyjde na totéž, by byla tichá
  // domněnka o vnitřnostech knihovny.
  const held = await sql.reserve();
  try {
    await held`select pg_advisory_lock(${MIGRATION_LOCK})`;
    try {
      const applied = new Set(
        (await held`select name from schema_migrations`).map((r) => r.name),
      );
      const results = [];

      for (const file of MIGRATIONS) {
        if (applied.has(file) && !force) {
          results.push({ file, status: "skipped" });
          onProgress?.({ file, status: "skipped" });
          continue;
        }
        onProgress?.({ file, status: "applying" });
        // Migrace i její zápis v JEDNÉ transakci: buď obojí, nebo nic.
        //
        // Transakce se řídí ručně, protože rezervované spojení `begin()`
        // nenabízí (na rozdíl od toho, co slibují typy) - a hlavně to
        // musí proběhnout po TOMTÉŽ sezení, které drží advisory zámek.
        await held`begin`;
        try {
          await held.unsafe(readFileSync(join(dir, file), "utf8"));
          await held`insert into schema_migrations (name) values (${file}) on conflict (name) do nothing`;
          await held`commit`;
        } catch (error) {
          await held`rollback`.catch(() => {});
          throw error;
        }
        results.push({ file, status: "applied" });
        onProgress?.({ file, status: "applied" });
      }
      return results;
    } finally {
      await held`select pg_advisory_unlock(${MIGRATION_LOCK})`;
    }
  } finally {
    held.release();
  }
}

/** Spouští se jen jako skript, ne při importu. */
const isEntrypoint = process.argv[1]?.endsWith("migrate.mjs");
if (isEntrypoint) await main();

async function main() {
  const url = migrationUrl();
  const problem = migrationUrlProblem(url);
  if (problem) {
    console.error(problem);
    console.error("  Zkopírujte .env.example do .env.local a vyplňte ho.");
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
