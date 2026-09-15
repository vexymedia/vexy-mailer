import { sql } from "../db";
import { getCallMetrics } from "./reporting";

/**
 * Přehled pro majitele / obchodního ředitele.
 *
 * Každé číslo tady se počítá z dat, která v aplikaci reálně jsou. Nic se
 * neodhaduje a nic se nedopočítává "aby to vypadalo". Když něco spolehlivě
 * nevíme, není to tu.
 */

/**
 * Firma v těchto stavech se už neoslovuje - nepočítá se do práce.
 * Funkce, ne konstanta: každé použití si bere vlastní fragment.
 */
const CLOSED = () => sql`('won', 'lost', 'excluded')`;

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
  /** Aktivní firmy, které nemají naplánovaný další krok. */
  without_next_step: number;
}

export async function getOverviewStats(): Promise<OverviewStats> {
  const [row] = await sql<OverviewStats[]>`
    select
      (select count(*)::int from companies co
        where co.status not in ${CLOSED()}
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
          and (cc.next_call_at is null or cc.next_call_at <= now())
          and not exists (select 1 from companies qco
                           where qco.id = c.company_id and qco.status in ${CLOSED()}))
        as waiting,

      -- Splatné dnes a dřív, napříč stavy: od zavedení kadence má datum
      -- i "rozvolaný" kontakt, ne jen slíbený callback.
      (select count(*)::int from campaign_contacts cc
        where cc.call_status in ('new', 'in_progress', 'callback')
          and cc.next_call_at is not null
          and cc.next_call_at < (current_date + 1)) as followups_today,

      (select count(*)::int from campaign_contacts cc where cc.meeting_booked) as meetings,

      (select coalesce(sum(cv.unread_count), 0)::int from conversations cv) as new_replies,

      (select count(*)::int from companies co
        where co.status in ('ready', 'in_progress', 'interested', 'meeting')
          and not exists (
            select 1 from campaign_contacts cc join contacts c on c.id = cc.contact_id
             where c.company_id = co.id
               and ((cc.call_status in ('new','in_progress','callback') and cc.next_call_at is not null)
                    or (cc.meeting_booked and cc.meeting_at is not null
                        and cc.meeting_outcome = 'scheduled')))) as without_next_step
  `;
  return row;
}

export interface WeekSummary {
  /** Pokusy o volání - viz definice v queries/reporting.ts. */
  calls: number;
  /** Hovory, kde jsme se skutečně dovolali. */
  connected: number;
  meetings_booked: number;
  emails_sent: number;
  reach_rate: number | null;
  meeting_rate: number | null;
}

/**
 * Co se stalo za posledních 7 dní.
 *
 * Čísla o volání se sem jen přenášejí z `queries/reporting.ts`. Dřív se
 * tu počítala vlastním dotazem nad `call_activities`, což znamenalo, že
 * skutečně proběhlý hovor bez zapsaného výsledku byl pro Přehled
 * neviditelný - a 35 sekund hovoru se ukázalo jako nula.
 */
export async function getWeekSummary(): Promise<WeekSummary> {
  const from = new Date(Date.now() - 7 * 86_400_000);
  const [metrics, row] = await Promise.all([
    getCallMetrics({ from }),
    sql<{ emails_sent: number }[]>`
      select (select count(*)::int from email_sends
               where status in ('sent', 'unknown', 'skipped')
                 and coalesce(sent_at, claimed_at) >= now() - interval '7 days') as emails_sent
    `,
  ]);
  return {
    calls: metrics.attempts,
    connected: metrics.connected,
    meetings_booked: metrics.meetings,
    emails_sent: row[0]?.emails_sent ?? 0,
    reach_rate: metrics.reach_rate,
    meeting_rate: metrics.meeting_rate,
  };
}

export type TodoKind = "overdue" | "followup" | "reply" | "queue" | "attention";

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
 * Pořadí je záměrné a odpovídá tomu, co člověka nejvíc pálí:
 *   1. co mělo být hotové včera,
 *   2. co je na dnešek,
 *   3. nové odpovědi (někdo čeká na reakci),
 *   4. firmy připravené k prvnímu oslovení,
 *   5. aktivní firmy, které nemají další krok - tiché díry v procesu.
 */
export async function getTodayWork(limit = 12): Promise<TodoItem[]> {
  // Splatné hovory rozdělené na "po termínu" a "dnes". Jeden dotaz, aby
  // se pořadí nemohlo rozejít mezi oběma skupinami.
  const due = await sql<TodoItem[]>`
    select case when cc.next_call_at < current_date then 'overdue' else 'followup' end as kind,
           '/osloveni' as href,
           coalesce(co.name, c.company, c.email) as title,
           nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') as subtitle,
           c.phone as detail,
           cc.next_call_at as due_at
      from campaign_contacts cc
      join contacts c on c.id = cc.contact_id
      left join companies co on co.id = c.company_id
     where cc.call_status in ('new', 'in_progress', 'callback')
       and cc.next_call_at is not null
       and cc.next_call_at < (current_date + 1)
       and not exists (select 1 from call_suppression cs where cs.contact_id = cc.contact_id)
       and coalesce(co.status, 'new') not in ${CLOSED()}
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

  let remaining = Math.max(0, limit - due.length - replies.length);
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
       and cc.next_call_at is null
       and cc.call_attempts < cp.max_call_attempts
       and c.phone is not null and btrim(c.phone) <> ''
       and not exists (select 1 from call_suppression cs where cs.contact_id = cc.contact_id)
       and coalesce(co.status, 'new') not in ${CLOSED()}
     order by cc.call_attempts, cc.created_at, cc.id
     limit ${remaining}
  `;

  remaining = Math.max(0, remaining - queue.length);
  const attention = remaining === 0 ? [] : await sql<TodoItem[]>`
    select 'attention' as kind,
           '/firmy/' || co.id::text as href,
           co.name as title,
           'Firmu řešíme, ale nemá naplánovaný další krok' as subtitle,
           null::text as detail,
           null::timestamptz as due_at
      from companies co
     where co.status in ('ready', 'in_progress', 'interested', 'meeting')
       and not exists (
         select 1 from campaign_contacts cc join contacts c on c.id = cc.contact_id
          where c.company_id = co.id
            and ((cc.call_status in ('new','in_progress','callback') and cc.next_call_at is not null)
                 or (cc.meeting_booked and cc.meeting_at is not null
                     and cc.meeting_outcome = 'scheduled')))
     order by case co.priority when 'high' then 0 when 'normal' then 1 else 2 end, co.name
     limit ${remaining}
  `;

  return [...due, ...replies, ...queue, ...attention];
}
