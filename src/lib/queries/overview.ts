import { sql } from "../db";

/**
 * Přehled pro majitele / obchodního ředitele.
 *
 * Každé číslo tady se počítá z dat, která v aplikaci reálně jsou. Nic se
 * neodhaduje a nic se nedopočítává "aby to vypadalo". Když něco spolehlivě
 * nevíme, není to tu.
 */

export interface OverviewStats {
  /** Firmy, které jde oslovit: mají telefon a nejsou uzavřené. */
  companies_ready: number;
  /** Kontakty, které právě čekají ve frontě k oslovení. */
  waiting: number;
  /** Follow-upy splatné dnes a dřív. */
  followups_today: number;
  /** Firmy s domluvenou schůzkou. */
  meetings: number;
  /** Nepřečtené odpovědi v doručené poště. */
  new_replies: number;
}

export async function getOverviewStats(): Promise<OverviewStats> {
  const [row] = await sql<OverviewStats[]>`
    select
      (select count(*)::int from companies co
        where co.status not in ('won', 'lost', 'excluded')
          and exists (select 1 from contacts c
                       where c.company_id = co.id
                         and c.phone is not null and btrim(c.phone) <> '')) as companies_ready,

      (select count(*)::int
         from campaign_contacts cc
         join campaigns cp on cp.id = cc.campaign_id
         join contacts c on c.id = cc.contact_id
        where cp.calling_enabled
          and cc.call_status in ('new', 'in_progress', 'callback')
          and cc.call_attempts < cp.max_call_attempts
          and c.phone is not null and btrim(c.phone) <> ''
          and not exists (select 1 from call_suppression cs where cs.contact_id = cc.contact_id)
          and (cc.call_status <> 'callback' or cc.next_call_at is null or cc.next_call_at <= now()))
        as waiting,

      (select count(*)::int from campaign_contacts cc
        where cc.call_status = 'callback'
          and cc.next_call_at is not null
          and cc.next_call_at < (current_date + 1)) as followups_today,

      (select count(*)::int from campaign_contacts cc where cc.meeting_booked) as meetings,

      (select coalesce(sum(cv.unread_count), 0)::int from conversations cv) as new_replies
  `;
  return row;
}

export interface WeekSummary {
  calls: number;
  connected: number;
  meetings_booked: number;
  emails_sent: number;
}

/** Co se stalo za posledních 7 dní. */
export async function getWeekSummary(): Promise<WeekSummary> {
  const [row] = await sql<WeekSummary[]>`
    select
      (select count(*)::int from call_activities
        where called_at >= now() - interval '7 days') as calls,
      (select count(*)::int from call_activities
        where connected and called_at >= now() - interval '7 days') as connected,
      (select count(*)::int from call_activities
        where outcome = 'meeting_booked' and called_at >= now() - interval '7 days') as meetings_booked,
      (select count(*)::int from email_sends
        where status = 'sent' and sent_at >= now() - interval '7 days') as emails_sent
  `;
  return row;
}

export type TodoKind = "followup" | "reply" | "queue";

export interface TodoItem {
  kind: TodoKind;
  /** Kam akce vede. */
  href: string;
  title: string;
  subtitle: string | null;
  detail: string | null;
  due_at: Date | null;
}

/**
 * "Dnes řešit" - jeden seznam, který vede rovnou do práce.
 *
 * Pořadí je záměrné: splatné follow-upy (někomu jsme slíbili, že se ozveme),
 * pak nové odpovědi (někdo čeká na reakci), pak čerstvá fronta.
 */
export async function getTodayWork(limit = 12): Promise<TodoItem[]> {
  const followups = await sql<TodoItem[]>`
    select 'followup' as kind,
           '/osloveni' as href,
           coalesce(co.name, c.company, c.email) as title,
           nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') as subtitle,
           c.phone as detail,
           cc.next_call_at as due_at
      from campaign_contacts cc
      join contacts c on c.id = cc.contact_id
      left join companies co on co.id = c.company_id
     where cc.call_status = 'callback'
       and cc.next_call_at is not null
       and cc.next_call_at < (current_date + 1)
     order by cc.next_call_at
     limit ${limit}
  `;

  const replies = await sql<TodoItem[]>`
    select 'reply' as kind,
           '/inbox/' || cv.id::text as href,
           coalesce(co.name, c.company, c.email) as title,
           nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') as subtitle,
           cv.subject as detail,
           cv.last_inbound_at as due_at
      from conversations cv
      join contacts c on c.id = cv.contact_id
      left join companies co on co.id = c.company_id
     where cv.unread_count > 0
     order by cv.last_inbound_at desc nulls last
     limit ${limit}
  `;

  const remaining = Math.max(0, limit - followups.length - replies.length);
  const queue = remaining === 0 ? [] : await sql<TodoItem[]>`
    select 'queue' as kind,
           '/osloveni' as href,
           coalesce(co.name, c.company, c.email) as title,
           nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') as subtitle,
           c.phone as detail,
           null::timestamptz as due_at
      from campaign_contacts cc
      join campaigns cp on cp.id = cc.campaign_id
      join contacts c on c.id = cc.contact_id
      left join companies co on co.id = c.company_id
     where cp.calling_enabled
       and cc.call_status in ('new', 'in_progress')
       and cc.call_attempts < cp.max_call_attempts
       and c.phone is not null and btrim(c.phone) <> ''
       and not exists (select 1 from call_suppression cs where cs.contact_id = cc.contact_id)
     order by cc.call_attempts, cc.created_at, cc.id
     limit ${remaining}
  `;

  return [...followups, ...replies, ...queue];
}
