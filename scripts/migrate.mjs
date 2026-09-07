#!/usr/bin/env node
/**
 * Applies every SQL file in supabase/migrations in filename order.
 *
 * Each migration is written to be idempotent (CREATE TABLE IF NOT EXISTS and
 * friends), so re-running this is safe. Applied files are recorded in
 * schema_migrations so a normal run skips them entirely.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { config as loadEnv } from "dotenv";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "supabase", "migrations");

// Match Next.js's precedence: .env.local wins over .env.
loadEnv({ path: join(root, ".env.local"), quiet: true });
loadEnv({ path: join(root, ".env"), quiet: true });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  process.exit(1);
}

const sql = postgres(url, {
  max: 1,
  prepare: false,
  ssl: url.includes("sslmode=disable") ? false : "prefer",
  onnotice: () => {},
});

try {
  await sql`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;

  const applied = new Set(
    (await sql`select name from schema_migrations`).map((row) => row.name),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let count = 0;

  for (const file of files) {
    if (applied.has(file) && !process.argv.includes("--force")) {
      console.log(`  skip   ${file} (already applied)`);
      continue;
    }
    process.stdout.write(`  apply  ${file} ... `);
    await sql.unsafe(readFileSync(join(dir, file), "utf8"));
    await sql`insert into schema_migrations (name) values (${file}) on conflict (name) do nothing`;
    console.log("ok");
    count++;
  }
  console.log(count === 0 ? "\nDatabase already up to date." : `\nApplied ${count} migration(s).`);
} catch (error) {
  console.error("\nMigration failed:", error.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
