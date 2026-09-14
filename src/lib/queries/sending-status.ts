import { sql } from "../db";
import { followUpBacklogWarning, poolTargets } from "../engine/pools";
import { allMailboxCapacity } from "../engine/allocation";
import { listMailboxHealth, mailboxProblem } from "./deliverability";

/**
 * "Co se dnes děje s odesíláním."
 *
 * Jedna funkce pro obrazovku kampaně i pro Přehled, aby obě nemohly
 * tvrdit něco jiného. Všechna čísla se počítají stejnými podmínkami jako
 * dispatcher - včetně toho, že se den určuje v timezone kampaně a že
 * rezervovaný (`sending`) send se počítá stejně jako odeslaný.
 */

export interface SendingStatus {
  dailyLimit: number;
  newRatio: number;
  sentToday: number;
  sentNew: number;
  sentFollowUp: number;
  targetNew: number;
  targetFollowUp: number;
  /** Kolik nových kontaktů ještě čeká na první oslovení. */
  waitingNew: number;
  /** Follow-upy splatné dnes. */
  dueFollowUps: number;
  /** Follow-upy splatné dřív než dnes. */
  overdueFollowUps: number;
  mailboxesActive: number;
  mailboxesTotal: number;
  /** Schránky, které vyžadují pozornost, i s důvodem. */
  problems: { from_email: string; problem: string }[];
  /** Upozornění na rostoucí backlog, nebo null. */
  backlogWarning: string | null;
}

export async function getSendingStatus(campaignId: string): Promise<SendingStatus | null> {
  const [campaign] = await sql<
    { id: string; daily_limit: number; new_ratio: number; timezone: string }[]
  >`select id, daily_limit, new_ratio, timezone from campaigns where id = ${campaignId}`;
  if (!campaign) return null;

  const [today] = await sql<{ sent_new: number; sent_follow_up: number }[]>`
    select count(*) filter (where pool is distinct from 'follow_up')::int as sent_new,
           count(*) filter (where pool = 'follow_up')::int as sent_follow_up
      from email_sends
     where campaign_id = ${campaign.id}
       and status in ('sending', 'sent', 'unknown', 'skipped')
       and coalesce(sent_at, claimed_at)
           >= date_trunc('day', now() at time zone ${campaign.timezone}) at time zone ${campaign.timezone}
  `;

  const [queue] = await sql<{ waiting_new: number; due: number; overdue: number }[]>`
    select count(*) filter (where cc.last_sent_at is null)::int as waiting_new,
           count(*) filter (where cc.last_sent_at is not null
                              and cc.next_send_at <= now())::int as due,
           count(*) filter (where cc.last_sent_at is not null
                              and cc.next_send_at < date_trunc('day', now() at time zone ${campaign.timezone})
                                                    at time zone ${campaign.timezone})::int as overdue
      from campaign_contacts cc
      join contacts c on c.id = cc.contact_id
     where cc.campaign_id = ${campaign.id}
       and cc.status in ('scheduled', 'sent')
       and cc.next_send_at is not null
       and not exists (select 1 from suppression_list s where s.email = c.email)
  `;

  const [pool] = await sql<{ total: number; active: number }[]>`
    select count(*)::int as total,
           count(*) filter (where m.enabled and m.last_test_ok is true)::int as active
      from campaign_mailboxes cm
      join mailboxes m on m.id = cm.mailbox_id
     where cm.campaign_id = ${campaign.id}
  `;

  const health = await listMailboxHealth();
  const inPool = new Set(
    (await sql<{ mailbox_id: string }[]>`
      select mailbox_id from campaign_mailboxes where campaign_id = ${campaign.id}
    `).map((r) => r.mailbox_id),
  );
  const problems = health
    .filter((h) => inPool.has(h.mailbox_id))
    .map((h) => ({ from_email: h.from_email, problem: mailboxProblem(h) }))
    .filter((p): p is { from_email: string; problem: string } => p.problem !== null);

  const targets = poolTargets(campaign.daily_limit, campaign.new_ratio);

  return {
    dailyLimit: campaign.daily_limit,
    newRatio: campaign.new_ratio,
    sentToday: today.sent_new + today.sent_follow_up,
    sentNew: today.sent_new,
    sentFollowUp: today.sent_follow_up,
    targetNew: targets.new,
    targetFollowUp: targets.follow_up,
    waitingNew: queue.waiting_new,
    dueFollowUps: queue.due,
    overdueFollowUps: queue.overdue,
    mailboxesActive: pool.active,
    mailboxesTotal: pool.total,
    problems,
    backlogWarning: followUpBacklogWarning({
      dueFollowUps: queue.due,
      followUpTarget: targets.follow_up,
    }),
  };
}

/**
 * Totéž napříč všemi aktivními kampaněmi, pro Přehled. Odpovídá na
 * otázku "co dnes potřebuje moji pozornost", ne "jak si vedeme".
 */
export interface TodaySending {
  sentToday: number;
  dailyLimit: number;
  dueFollowUps: number;
  overdueFollowUps: number;
  mailboxProblems: number;
}

export async function getTodaySending(): Promise<TodaySending> {
  const [row] = await sql<{ sent_today: number; daily_limit: number }[]>`
    select coalesce(sum(
             (select count(*) from email_sends es
               where es.campaign_id = cp.id
                 and es.status in ('sending', 'sent', 'unknown', 'skipped')
                 and coalesce(es.sent_at, es.claimed_at)
                     >= date_trunc('day', now() at time zone cp.timezone) at time zone cp.timezone)
           ), 0)::int as sent_today,
           coalesce(sum(cp.daily_limit), 0)::int as daily_limit
      from campaigns cp
     where cp.status = 'active'
  `;

  const [queue] = await sql<{ due: number; overdue: number }[]>`
    select count(*) filter (where cc.next_send_at <= now())::int as due,
           count(*) filter (where cc.next_send_at < current_date)::int as overdue
      from campaign_contacts cc
      join campaigns cp on cp.id = cc.campaign_id
      join contacts c on c.id = cc.contact_id
     where cp.status = 'active'
       and cc.status in ('scheduled', 'sent')
       and cc.last_sent_at is not null
       and cc.next_send_at is not null
       and not exists (select 1 from suppression_list s where s.email = c.email)
  `;

  const health = await listMailboxHealth();
  return {
    sentToday: row.sent_today,
    dailyLimit: row.daily_limit,
    dueFollowUps: queue.due,
    overdueFollowUps: queue.overdue,
    mailboxProblems: health.filter((h) => mailboxProblem(h) !== null).length,
  };
}

export { allMailboxCapacity };
