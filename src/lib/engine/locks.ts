import { sql } from "../db";

/**
 * Lease-based mutual exclusion.
 *
 * A single atomic UPDATE both tests and takes the lock, so two concurrent cron
 * ticks can never both win. The lease carries an expiry rather than relying on
 * the holder to release it, which means a worker that is killed mid-tick (a
 * serverless timeout, a redeploy) frees the lock automatically.
 */
export async function acquireLock(name: string, ttlMs: number, holder: string): Promise<boolean> {
  const rows = await sql<{ name: string }[]>`
    update worker_locks
       set locked_until = now() + ${`${Math.ceil(ttlMs / 1000)} seconds`}::interval,
           holder = ${holder},
           acquired_at = now()
     where name = ${name}
       and locked_until < now()
    returning name
  `;
  return rows.length > 0;
}

/** Releases a lease, but only if we are still the holder. */
export async function releaseLock(name: string, holder: string): Promise<void> {
  await sql`
    update worker_locks
       set locked_until = now() - interval '1 second'
     where name = ${name} and holder = ${holder}
  `;
}

export async function withLock<T>(
  name: string,
  ttlMs: number,
  holder: string,
  fn: () => Promise<T>,
): Promise<T | { skipped: "locked" }> {
  if (!(await acquireLock(name, ttlMs, holder))) return { skipped: "locked" };
  try {
    return await fn();
  } finally {
    await releaseLock(name, holder);
  }
}
