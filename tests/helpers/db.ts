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
  process.env.APP_PASSWORD ??= "test-password";
  process.env.CRON_SECRET ??= "test-cron-secret";
  process.env.APP_URL ??= "http://localhost:3000";
  configured = true;
}

/** Drops and recreates the public schema, then applies every migration. */
export async function resetDatabase(): Promise<void> {
  configureTestEnv();
  const { sql } = await import("@/lib/db");
  await sql.unsafe("drop schema public cascade; create schema public;");
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await sql.unsafe(readFileSync(join(dir, file), "utf8"));
  }
}

export async function closeDatabase(): Promise<void> {
  const { sql } = await import("@/lib/db");
  await sql.end({ timeout: 5 });
}
