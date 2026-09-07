import postgres from "postgres";
import { env } from "./env";

/**
 * Single postgres.js client, cached on globalThis so warm serverless
 * invocations reuse it instead of opening a connection per request.
 *
 * `prepare: false` is required when connecting through Supabase's transaction
 * pooler (port 6543) - PgBouncer in transaction mode cannot support the
 * extended-protocol prepared statements postgres.js would otherwise use.
 */

type Sql = ReturnType<typeof postgres>;

const globalForDb = globalThis as unknown as { __vexySql?: Sql };

function createClient(): Sql {
  const url = env.databaseUrl;
  const usingPooler = url.includes(":6543") || url.includes("pooler.supabase.com");
  return postgres(url, {
    max: Number(process.env.DB_POOL_MAX ?? 5),
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: !usingPooler,
    // Supabase requires TLS; `sslmode=require` in the URL is honoured, but be
    // explicit for direct connections that omit it.
    ssl: url.includes("sslmode=disable") ? false : "prefer",
    onnotice: () => {},
  });
}

export const sql: Sql = globalForDb.__vexySql ?? createClient();
if (process.env.NODE_ENV !== "production") globalForDb.__vexySql = sql;

/** Postgres unique-violation SQLSTATE. */
export const UNIQUE_VIOLATION = "23505";
/** Raised by the suppression-list trigger. */
export const CHECK_VIOLATION = "23514";

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === UNIQUE_VIOLATION;
}

export function isSuppressionViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; message?: string };
  return err.code === CHECK_VIOLATION && Boolean(err.message?.includes("suppression list"));
}
