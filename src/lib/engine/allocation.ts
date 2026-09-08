import type { Sql, TransactionSql } from "postgres";

/**
 * Accepts either the pooled client or a transaction handle. The quota check
 * only means anything inside a transaction, but the read-only capacity helpers
 * are useful from both.
 */
type Db = Sql | TransactionSql;

/**
 * Sender selection and daily-quota accounting for multi-mailbox campaigns.
 *
 * Two caps apply to every automated send, independently:
 *
 *   * the campaign's own daily limit, counted per campaign;
 *   * the mailbox's global daily limit, counted across ALL campaigns.
 *
 * The second is the important one. Two campaigns each configured for 40/day
 * that share one mailbox must still send at most that mailbox's limit in
 * total - never 80.
 *
 * "Today" is resolved in the mailbox's own timezone, not the campaign's, so a
 * mailbox shared by campaigns in different zones has exactly one day boundary.
 *
 * Only campaign sends count. Manual replies from the inbox live in `messages`
 * and are deliberately outside this ledger: answering a human who wrote to you
 * should never be blocked because a cold-email quota ran out.
 */

/** Statuses that consume quota. `unknown` counts because it may have been delivered. */
export const QUOTA_CONSUMING_STATUSES = ["sent", "unknown", "skipped"] as const;

export interface MailboxCapacity {
  mailbox_id: string;
  from_email: string;
  name: string;
  enabled: boolean;
  daily_limit: number;
  used_today: number;
  remaining: number;
  /** used_today / daily_limit, 0..1+. The fair-allocation sort key. */
  utilisation: number;
}

/**
 * Per-mailbox usage for today, each in its own timezone.
 *
 * `date_trunc('day', now() at time zone tz) at time zone tz` is the UTC
 * instant of local midnight for that mailbox - the same construction the
 * dashboard uses, kept in SQL so the count and the boundary cannot drift apart.
 */
function usageCte(sql: Db) {
  return sql`
    mailbox_usage as (
      select m.id            as mailbox_id,
             m.from_email,
             m.name,
             m.enabled,
             m.daily_limit,
             count(es.id)::int as used_today
        from mailboxes m
        left join email_sends es
          on es.mailbox_id = m.id
         and es.status = any(${QUOTA_CONSUMING_STATUSES as unknown as string[]})
         and coalesce(es.sent_at, es.claimed_at)
             >= date_trunc('day', now() at time zone m.timezone) at time zone m.timezone
       group by m.id
    )
  `;
}

/** Capacity of every mailbox, for the Mailboxes screen. */
export async function allMailboxCapacity(sql: Db): Promise<MailboxCapacity[]> {
  const rows = await sql<Omit<MailboxCapacity, "remaining" | "utilisation">[]>`
    with ${usageCte(sql)}
    select mailbox_id, from_email, name, enabled, daily_limit, used_today
      from mailbox_usage order by from_email
  `;
  return rows.map(decorate);
}

function decorate(row: Omit<MailboxCapacity, "remaining" | "utilisation">): MailboxCapacity {
  return {
    ...row,
    remaining: Math.max(0, row.daily_limit - row.used_today),
    utilisation: row.daily_limit > 0 ? row.used_today / row.daily_limit : 1,
  };
}

/**
 * Fair allocation for a contact that has never been written to.
 *
 * Least-utilised first, by the ratio rather than the absolute count, so a
 * mailbox with a small limit is not starved by one with a large limit. Ties
 * break deterministically - fewer sends, then oldest mailbox - so the same
 * inputs always produce the same choice, which makes behaviour reproducible
 * and testable rather than merely "random enough".
 *
 * Returns null when no mailbox in the pool can take the send right now.
 */
export async function allocateSender(sql: Db, campaignId: string): Promise<string | null> {
  const [row] = await sql<{ mailbox_id: string }[]>`
    with ${usageCte(sql)}
    select mu.mailbox_id
      from mailbox_usage mu
      join campaign_mailboxes cm on cm.mailbox_id = mu.mailbox_id
      join mailboxes m on m.id = mu.mailbox_id
     where cm.campaign_id = ${campaignId}
       and mu.enabled
       and mu.used_today < mu.daily_limit
       and m.last_test_ok is true
     order by (mu.used_today::numeric / nullif(mu.daily_limit, 0)) asc,
              mu.used_today asc,
              m.created_at asc,
              mu.mailbox_id asc
     limit 1
  `;
  return row?.mailbox_id ?? null;
}

export interface MailboxReservation {
  ok: boolean;
  reason?: string;
  used_today?: number;
  daily_limit?: number;
}

/**
 * Confirms a mailbox may send one more email right now, and serialises that
 * decision against every other worker.
 *
 * MUST be called inside the claim transaction. `for update` on the mailbox row
 * is what makes the check-then-insert atomic: a second worker asking about the
 * same mailbox blocks here until the first has committed its email_sends row,
 * so it sees the updated count. Without it, two workers could both read 39 of
 * 40 and both send.
 */
export async function reserveMailboxSlot(
  tx: Db,
  mailboxId: string,
): Promise<MailboxReservation> {
  const [mailbox] = await tx<
    { id: string; enabled: boolean; daily_limit: number; timezone: string; last_test_ok: boolean | null }[]
  >`
    select id, enabled, daily_limit, timezone, last_test_ok
      from mailboxes where id = ${mailboxId}
       for update
  `;
  if (!mailbox) return { ok: false, reason: "The sender mailbox no longer exists." };
  if (!mailbox.enabled) return { ok: false, reason: "The sender mailbox is disabled." };
  if (mailbox.last_test_ok !== true) {
    return { ok: false, reason: "The sender mailbox has no successful connection test." };
  }

  const [{ used_today }] = await tx<{ used_today: number }[]>`
    select count(*)::int as used_today
      from email_sends
     where mailbox_id = ${mailboxId}
       and status = any(${QUOTA_CONSUMING_STATUSES as unknown as string[]})
       and coalesce(sent_at, claimed_at)
           >= date_trunc('day', now() at time zone ${mailbox.timezone}) at time zone ${mailbox.timezone}
  `;

  if (used_today >= mailbox.daily_limit) {
    return {
      ok: false,
      reason: `Mailbox daily limit reached (${used_today}/${mailbox.daily_limit}).`,
      used_today,
      daily_limit: mailbox.daily_limit,
    };
  }
  return { ok: true, used_today, daily_limit: mailbox.daily_limit };
}
