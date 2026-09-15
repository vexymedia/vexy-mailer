import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Integration-test harness. Points the app at a throwaway database and rebuilds
 * it from the real migration files, so these tests exercise the same DDL that
 * production runs - constraints included.
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/vexy_mailer_test?sslmode=disable";

let configured = false;

export function configureTestEnv(): void {
  if (configured) return;
  process.env.DATABASE_URL = TEST_DATABASE_URL;
  process.env.ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
  process.env.SESSION_SECRET ??= "test-session-secret";
  process.env.CRON_SECRET ??= "test-cron-secret";
  process.env.APP_URL ??= "http://localhost:3000";
  configured = true;
}

/**
 * Drops and recreates the public schema, then applies every migration.
 *
 * Zapisuje i do `schema_migrations`, přesně jako to dělá ostrý runner.
 * Bez toho by testovací databáze vypadala jako čerstvě zmigrovaná, ale
 * tvrdila by, že žádná migrace aplikovaná není - a kontrola schématu by
 * se testovala proti stavu, který v provozu nikdy nenastane.
 */
export async function resetDatabase(): Promise<void> {
  configureTestEnv();
  const { sql } = await import("@/lib/db");
  await sql.unsafe("drop schema public cascade; create schema public;");
  const dir = join(process.cwd(), "supabase", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await sql.unsafe(readFileSync(join(dir, file), "utf8"));
  }
  await sql`create table if not exists schema_migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`;
  for (const file of files) {
    await sql`insert into schema_migrations (name) values (${file}) on conflict do nothing`;
  }
}

export async function closeDatabase(): Promise<void> {
  const { sql } = await import("@/lib/db");
  await sql.end({ timeout: 5 });
}
