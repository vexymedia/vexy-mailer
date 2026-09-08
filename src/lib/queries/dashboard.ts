import { sql } from "../db";
import type { CampaignStatus } from "../types";

export interface CampaignStats {
  id: string;
  name: string;
  status: CampaignStatus;
  /**
   * Every mailbox in the campaign's sender pool, by address. Empty when the
   * pool is empty - which is surfaced, never used to hide the campaign.
   */
  mailbox_names: string[];
  daily_limit: number;
  timezone: string;
  send_days: number[];
  send_start_minute: number;
  send_end_minute: number;
  next_slot_at: Date | null;
  contacts: number;
  sent: number;
  replies: number;
  failed: number;
  remaining: number;
  needs_review: number;
  sent_today: number;
}

/** One row per campaign with every counter the dashboard shows. */
export async function listCampaignStats(): Promise<CampaignStats[]> {
  return sql<CampaignStats[]>`
    select cp.id, cp.name, cp.status, cp.daily_limit, cp.timezone, cp.send_days,
           cp.send_start_minute, cp.send_end_minute, cp.next_slot_at,
           coalesce(mb.mailbox_names, '{}') as mailbox_names,
           coalesce(cc.contacts, 0)  as contacts,
           coalesce(es.sent, 0)      as sent,
           coalesce(cc.replies, 0)   as replies,
           coalesce(cc.failed, 0)    as failed,
           coalesce(cc.remaining, 0) as remaining,
           coalesce(es.needs_review, 0) as needs_review,
           coalesce(es.sent_today, 0)   as sent_today
      from campaigns cp
      -- LEFT JOIN LATERAL over the sender pool, never an inner join through
      -- campaigns.mailbox_id. That column is deprecated and NULL for every
      -- campaign created since the multi-mailbox migration, so joining through
      -- it silently dropped live campaigns from this list entirely.
      left join lateral (
        select coalesce(array_agg(m.from_email order by m.from_email), '{}') as mailbox_names
          from campaign_mailboxes cm
          join mailboxes m on m.id = cm.mailbox_id
         where cm.campaign_id = cp.id
      ) mb on true
      left join lateral (
        select count(*)::int as contacts,
               count(*) filter (where status = 'replied')::int as replies,
               count(*) filter (where status = 'failed')::int  as failed,
               count(*) filter (where status in ('pending','scheduled','sent'))::int as remaining
          from campaign_contacts where campaign_id = cp.id
      ) cc on true
      left join lateral (
        select count(*) filter (where status = 'sent')::int as sent,
               count(*) filter (where status = 'unknown')::int as needs_review,
               count(*) filter (
                 where status in ('sent','unknown','skipped')
                   and coalesce(sent_at, claimed_at) >= date_trunc('day', now() at time zone cp.timezone) at time zone cp.timezone
               )::int as sent_today
          from email_sends where campaign_id = cp.id
      ) es on true
     order by
       case cp.status when 'active' then 0 when 'paused' then 1 when 'draft' then 2 else 3 end,
       cp.created_at desc
  `;
}

/**
 * How a sender pool reads on a campaign card. One mailbox reads as itself;
 * several are listed; none is called out rather than left blank, because an
 * empty pool is the reason a campaign cannot send.
 */
export function describeSenderPool(mailboxNames: string[]): string {
  if (mailboxNames.length === 0) return "No sender mailbox";
  if (mailboxNames.length <= 2) return mailboxNames.join(", ");
  return `${mailboxNames[0]} +${mailboxNames.length - 1} more`;
}

export interface ActivityRow {
  id: string;
  created_at: Date;
  level: string;
  action: string;
  detail: string | null;
  campaign_name: string | null;
  contact_email: string | null;
}

export async function listActivity(options: { campaignId?: string; limit?: number } = {}): Promise<ActivityRow[]> {
  const campaignId = options.campaignId ?? null;
  return sql<ActivityRow[]>`
    select al.id::text, al.created_at, al.level, al.action, al.detail,
           cp.name as campaign_name,
           c.email as contact_email
      from activity_logs al
      left join campaigns cp on cp.id = al.campaign_id
      left join contacts c   on c.id = al.contact_id
     where (${campaignId}::uuid is null or al.campaign_id = ${campaignId}::uuid)
     order by al.created_at desc, al.id desc
     limit ${options.limit ?? 200}
  `;
}

export interface CampaignContactRow {
  id: string;
  email: string;
  first_name: string | null;
  company: string | null;
  status: string;
  current_step: number;
  last_sent_at: Date | null;
  next_send_at: Date | null;
  replied_at: Date | null;
  last_error: string | null;
  sends: number;
}

export async function listCampaignContacts(campaignId: string): Promise<CampaignContactRow[]> {
  return sql<CampaignContactRow[]>`
    select cc.id, c.email, c.first_name, c.company, cc.status, cc.current_step,
           cc.last_sent_at, cc.next_send_at, cc.replied_at, cc.last_error,
           (select count(*)::int from email_sends es
             where es.campaign_contact_id = cc.id and es.status in ('sent','skipped')) as sends
      from campaign_contacts cc
      join contacts c on c.id = cc.contact_id
     where cc.campaign_id = ${campaignId}
     order by
       case cc.status when 'replied' then 0 when 'failed' then 1 else 2 end,
       cc.next_send_at nulls last, c.email
  `;
}

export interface GlobalStats {
  campaigns: number;
  active_campaigns: number;
  contacts: number;
  suppressed: number;
  sent_total: number;
  replies_total: number;
  needs_review: number;
}

export async function getGlobalStats(): Promise<GlobalStats> {
  const [row] = await sql<GlobalStats[]>`
    select (select count(*)::int from campaigns) as campaigns,
           (select count(*)::int from campaigns where status = 'active') as active_campaigns,
           (select count(*)::int from contacts) as contacts,
           (select count(*)::int from suppression_list) as suppressed,
           (select count(*)::int from email_sends where status = 'sent') as sent_total,
           (select count(*)::int from replies where campaign_contact_id is not null) as replies_total,
           (select count(*)::int from email_sends where status = 'unknown') as needs_review
  `;
  return row;
}
