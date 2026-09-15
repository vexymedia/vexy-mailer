#!/usr/bin/env node
/**
 * Jeden krok nasazení: dorovnat databázi a ověřit, že sedí s aplikací.
 *
 * Vzniklo proto, že se nasazovalo řetězcem ručních příkazů v PowerShellu -
 * nastavit DATABASE_URL, pustit migraci, pustit kontrolu, někdy nakopírovat
 * SQL do Supabase editoru. Každý z nich šlo zapomenout nebo pustit proti
 * špatné databázi.
 *
 *   npm run release          aplikuje migrace a zkontroluje schéma
 *   npm run release:check    jen zkontroluje, NIC nemění
 *
 * Kde to běží:
 *
 *   * Jako Build Command na Vercelu (viz docs/DEPLOY.md). Tím se migrace
 *     stanou součástí nasazení - řízeným krokem, ne něčím, co se spustí
 *     při HTTP requestu.
 *   * Nebo ručně jedním příkazem, když se nasazuje odjinud.
 *
 * Tři pojistky, aby automatizace nebyla horší než ruční krok:
 *
 *   1. NA PREVIEW SE NEMIGRUJE. Preview nasazení sdílí proměnné s produkcí
 *      a bez téhle pojistky by každý pull request migroval ostrou databázi.
 *   2. BEZ DATABASE_URL se jen přeskočí. Lokální `npm run build` nesmí
 *      kvůli tomuhle spadnout.
 *   3. PŘI CHYBĚ SE KONČÍ. Migrace se vrací v transakci, běh skončí
 *      nenulovým kódem a nasazení se nepustí dál s napůl hotovým schématem.
 *
 * Nic destruktivního: aplikují se jen migrace z repozitáře. Žádné mazání,
 * žádný reset, žádná „oprava" schématu podle rozdílu.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { applyMigrations, connect, migrationDrift } from "./migrate.mjs";
import { MIGRATIONS, REQUIRED, findMissing } from "../src/lib/schema-contract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: join(root, ".env.local"), quiet: true });
loadEnv({ path: join(root, ".env"), quiet: true });

const checkOnly = process.argv.includes("--check");

/** Chyba z databáze bez hesla a hostitele. Tohle končí v logu nasazení. */
function safeMessage(error) {
  const code = error?.code;
  if (code === "28P01" || code === "28000") return "Databáze odmítla přihlašovací údaje.";
  if (code === "3D000") return "Databáze s tímto jménem neexistuje.";
  if (code === "ECONNREFUSED") return "Databáze odmítla spojení.";
  if (code === "ENOTFOUND") return "Adresu databáze se nepodařilo přeložit.";
  if (code === "ETIMEDOUT" || code === "CONNECT_TIMEOUT") return "Databáze neodpověděla včas.";
  return error?.message ?? String(error);
}

function done(message) {
  console.log(message);
  process.exit(0);
}

function fail(message, hint) {
  console.error(message);
  if (hint) console.error(hint);
  process.exit(1);
}

// --- 1. kde vůbec jsme -----------------------------------------------------

// Preview a development na Vercelu sdílí proměnné s produkcí. Migrovat
// odsud by znamenalo, že ostrou databázi mění každý pull request.
const vercelEnv = process.env.VERCEL_ENV;
if (!checkOnly && vercelEnv && vercelEnv !== "production") {
  done(`release: nasazení typu "${vercelEnv}" databázi nemigruje. Přeskočeno.`);
}

const url = process.env.DATABASE_URL;
if (!url) {
  // Build bez databáze je legitimní (lokální `npm run build`, CI bez
  // přístupu). Spadnout na tom by znamenalo, že se nedá ani sestavit.
  done("release: DATABASE_URL není nastavená, databáze se nekontroluje. Přeskočeno.");
}

// --- 2. seznam migrací vs. soubory ----------------------------------------

const drift = migrationDrift();
if (drift.length > 0) {
  fail(
    "release: seznam migrací nesedí se soubory v supabase/migrations:\n  " + drift.join("\n  "),
    "Doplňte chybějící název do MIGRATIONS v src/lib/schema-contract.mjs.",
  );
}

// --- 3. migrace ------------------------------------------------------------

const sql = connect(url);
try {
  try {
    await sql`select 1`;
  } catch (error) {
    fail(`release: k databázi se nepodařilo připojit — ${safeMessage(error)}`,
         "Zkontrolujte DATABASE_URL v nastavení hostingu.");
  }

  if (!checkOnly) {
    const results = await applyMigrations(sql, {
      onProgress: ({ file, status }) => {
        if (status === "applied") console.log(`release: aplikováno ${file}`);
      },
    });
    const applied = results.filter((r) => r.status === "applied").length;
    console.log(applied === 0 ? "release: databáze byla aktuální." : `release: aplikováno migrací: ${applied}.`);
  }

  // --- 4. ověření, že schéma opravdu sedí ---------------------------------
  //
  // Zápis v schema_migrations negarantuje, že migrace doběhla celá, takže
  // se sloupce kontrolují zvlášť. Bez téhle kontroly by šlo nasadit verzi,
  // která spadne až na první obrazovce, co nový sloupec čte.
  const appliedNames = new Set((await sql`select name from schema_migrations`).map((r) => r.name));
  const missing = MIGRATIONS.filter((file) => !appliedNames.has(file));

  const rows = await sql`
    select table_name, column_name from information_schema.columns where table_schema = 'public'`;
  const present = new Map();
  for (const row of rows) {
    if (!present.has(row.table_name)) present.set(row.table_name, new Set());
    present.get(row.table_name).add(row.column_name);
  }
  const gaps = findMissing(present, REQUIRED);

  if (missing.length === 0 && gaps.length === 0) {
    console.log(`release: schéma odpovídá aplikaci (${MIGRATIONS.length} migrací).`);
  } else {
    for (const file of missing) console.error(`release: CHYBÍ migrace ${file}`);
    for (const gap of gaps) {
      console.error(
        gap.missingTable
          ? `release: CHYBÍ tabulka ${gap.table} (${gap.since} · ${gap.feature})`
          : `release: CHYBÍ ${gap.table}.${gap.columns.join(", ")} (${gap.since} · ${gap.feature})`,
      );
    }
    fail(
      "release: databáze neodpovídá téhle verzi aplikace.",
      checkOnly ? "Spusťte: npm run release" : "Migrace proběhly, ale schéma pořád nesedí — podívejte se na výpis výš.",
    );
  }
} catch (error) {
  fail(`release: selhalo — ${safeMessage(error)}`);
} finally {
  await sql.end();
}
