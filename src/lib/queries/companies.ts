import { sql } from "../db";
import { logActivity } from "../activity";
import type { TimelineEntry } from "./calling";
import type { CompanyPriority, CompanyStatus } from "../companies";

export {
  COMPANY_PRIORITY_LABELS,
  COMPANY_STATUS_LABELS,
  CLOSED_COMPANY_STATUSES,
  companyPriorityLabel,
  companyStatusLabel,
} from "../companies";
export type { CompanyPriority, CompanyStatus } from "../companies";

/**
 * Firmy - hlavní objekt produktu.
 *
 * Kontakt je člověk uvnitř firmy; rozhodujeme se ale o firmě. Proto se
 * priorita, důvod, odpovědná osoba a další krok drží tady, a všechno ostatní
 * (fronta volání, e-maily, schůzky) se k firmě jen dopočítává z dat, která
 * už v aplikaci jsou. Žádná z těchto funkcí nic neodesílá ani nevolá.
 */

export interface CompanyRow {
  id: string;
  name: string;
  website: string | null;
  reason: string | null;
  priority: CompanyPriority;
  status: CompanyStatus;
  owner_id: string | null;
  owner_name: string | null;
  contacts_count: number;
  /** Hlavní kontakt: přednost má ten s telefonem. */
  main_contact_name: string | null;
  main_contact_email: string | null;
  main_contact_phone: string | null;
  last_activity_at: Date | null;
  next_action_at: Date | null;
  /** Je aspoň jeden kontakt firmy právě ve frontě k oslovení? */
  in_queue: boolean;
  meetings: number;
}

export interface CompanyFilters {
  search?: string | null;
  status?: CompanyStatus | null;
  priority?: CompanyPriority | null;
  ownerId?: string | null;
  /** Jen firmy, které právě čekají ve frontě k oslovení. */
  queueOnly?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * Jeden řádek na firmu, se vším, co seznam ukazuje. Sloupců je schválně
 * málo: seznam má odpovědět "koho řešit a proč", ne vypsat celou databázi.
 */
export async function listCompanies(
  filters: CompanyFilters = {},
): Promise<{ rows: CompanyRow[]; total: number }> {
  const search = filters.search?.trim() ? `%${filters.search.trim().toLowerCase()}%` : null;
  const status = filters.status ?? null;
  const priority = filters.priority ?? null;
  const ownerId = filters.ownerId ?? null;
  const queueOnly = filters.queueOnly ?? false;
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const where = sql`
    where (${search}::text is null
           or lower(co.name) like ${search}
           or lower(coalesce(co.reason, '')) like ${search}
           or exists (select 1 from contacts c2 where c2.company_id = co.id
                       and (lower(c2.email) like ${search}
                            or lower(coalesce(c2.first_name, '')) like ${search}
                            or lower(coalesce(c2.last_name, '')) like ${search})))
      and (${status}::text is null or co.status = ${status})
      and (${priority}::text is null or co.priority = ${priority})
      and (${ownerId}::uuid is null or co.owner_id = ${ownerId}::uuid)
      and (${queueOnly} = false or exists (
            select 1
              from campaign_contacts cc
              join campaigns cp on cp.id = cc.campaign_id
              join contacts c3 on c3.id = cc.contact_id
             where c3.company_id = co.id
               and cp.calling_enabled
               and cc.call_status in ('new', 'in_progress', 'callback')
               and cc.call_attempts < cp.max_call_attempts
               and c3.phone is not null and btrim(c3.phone) <> ''
               and not exists (select 1 from call_suppression cs where cs.contact_id = cc.contact_id)
               and (cc.call_status <> 'callback' or cc.next_call_at is null or cc.next_call_at <= now())))
  `;

  const rows = await sql<CompanyRow[]>`
    select co.id, co.name, co.website, co.reason, co.priority, co.status,
           co.owner_id, ow.name as owner_name,
           (select count(*)::int from contacts c where c.company_id = co.id) as contacts_count,
           mc.name as main_contact_name,
           mc.email as main_contact_email,
           mc.phone as main_contact_phone,
           act.last_activity_at,
           nxt.next_action_at,
           coalesce(q.in_queue, false) as in_queue,
           coalesce(mt.meetings, 0) as meetings
      from companies co
      left join callers ow on ow.id = co.owner_id
      left join lateral (
        select nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') as name,
               c.email, c.phone
          from contacts c
         where c.company_id = co.id
         -- Hlavní kontakt je ten, komu jde zavolat.
         order by (c.phone is null or btrim(c.phone) = ''), c.created_at, c.id
         limit 1
      ) mc on true
      left join lateral (
        select greatest(
                 (select max(ca.called_at) from call_activities ca
                    join contacts c on c.id = ca.contact_id where c.company_id = co.id),
                 (select max(coalesce(es.sent_at, es.claimed_at)) from email_sends es
                    join campaign_contacts cc on cc.id = es.campaign_contact_id
                    join contacts c on c.id = cc.contact_id where c.company_id = co.id),
                 (select max(r.received_at) from replies r
                    join contacts c on c.id = r.contact_id where c.company_id = co.id)
               ) as last_activity_at
      ) act on true
      left join lateral (
        -- Další krok je nejbližší z naplánovaného hovoru a domluvené schůzky.
        -- Bez schůzky by firma s termínem v diáři hlásila "žádný další krok".
        select min(t.at) as next_action_at
          from (
            select cc.next_call_at as at
              from campaign_contacts cc join contacts c on c.id = cc.contact_id
             where c.company_id = co.id
               and cc.call_status in ('new','in_progress','callback')
               and cc.next_call_at is not null
            union all
            select cc.meeting_at
              from campaign_contacts cc join contacts c on c.id = cc.contact_id
             where c.company_id = co.id and cc.meeting_booked
               and cc.meeting_at is not null and cc.meeting_outcome = 'scheduled'
          ) t
      ) nxt on true
      left join lateral (
        select true as in_queue
          from campaign_contacts cc
          join campaigns cp on cp.id = cc.campaign_id
          join contacts c on c.id = cc.contact_id
         where c.company_id = co.id
           and cp.calling_enabled
           and cc.call_status in ('new', 'in_progress', 'callback')
           and cc.call_attempts < cp.max_call_attempts
           and c.phone is not null and btrim(c.phone) <> ''
           and not exists (select 1 from call_suppression cs where cs.contact_id = cc.contact_id)
           and (cc.call_status <> 'callback' or cc.next_call_at is null or cc.next_call_at <= now())
         limit 1
      ) q on true
      left join lateral (
        select count(*)::int as meetings
          from campaign_contacts cc
          join contacts c on c.id = cc.contact_id
         where c.company_id = co.id and cc.meeting_booked
      ) mt on true
      ${where}
     order by
       case co.priority when 'high' then 0 when 'normal' then 1 else 2 end,
       nxt.next_action_at nulls last,
       co.name
     limit ${limit} offset ${offset}
  `;

  const [{ count: total }] = await sql<{ count: number }[]>`
    select count(*)::int as count from companies co ${where}
  `;

  return { rows, total };
}

export interface CompanyContact {
  id: string;
  email: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  /** Nejnovější otevřený záznam kontaktu v kampani, pokud existuje. */
  campaign_contact_id: string | null;
  campaign_name: string | null;
  call_status: string | null;
  call_attempts: number | null;
  next_call_at: Date | null;
  email_status: string | null;
  suppressed: boolean;
  do_not_call: boolean;
}

export interface CompanyDetail extends CompanyRow {
  note: string | null;
  created_at: Date;
  /** Kvalifikační kritéria kampaní, ve kterých firma je. */
  qualification: string[];
}

export async function getCompany(id: string): Promise<CompanyDetail | null> {
  const [row] = await sql<CompanyDetail[]>`
    select co.id, co.name, co.website, co.reason, co.priority, co.status,
           co.owner_id, ow.name as owner_name, co.note, co.created_at,
           (select count(*)::int from contacts c where c.company_id = co.id) as contacts_count,
           mc.name as main_contact_name, mc.email as main_contact_email, mc.phone as main_contact_phone,
           act.last_activity_at, nxt.next_action_at,
           false as in_queue,
           coalesce(mt.meetings, 0) as meetings,
           coalesce(qual.criteria, '{}') as qualification
      from companies co
      left join callers ow on ow.id = co.owner_id
      left join lateral (
        select nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') as name,
               c.email, c.phone
          from contacts c where c.company_id = co.id
         order by (c.phone is null or btrim(c.phone) = ''), c.created_at, c.id limit 1
      ) mc on true
      left join lateral (
        select greatest(
                 (select max(ca.called_at) from call_activities ca
                    join contacts c on c.id = ca.contact_id where c.company_id = co.id),
                 (select max(coalesce(es.sent_at, es.claimed_at)) from email_sends es
                    join campaign_contacts cc on cc.id = es.campaign_contact_id
                    join contacts c on c.id = cc.contact_id where c.company_id = co.id),
                 (select max(r.received_at) from replies r
                    join contacts c on c.id = r.contact_id where c.company_id = co.id)
               ) as last_activity_at
      ) act on true
      left join lateral (
        -- Další krok je nejbližší z naplánovaného hovoru a domluvené schůzky.
        -- Bez schůzky by firma s termínem v diáři hlásila "žádný další krok".
        select min(t.at) as next_action_at
          from (
            select cc.next_call_at as at
              from campaign_contacts cc join contacts c on c.id = cc.contact_id
             where c.company_id = co.id
               and cc.call_status in ('new','in_progress','callback')
               and cc.next_call_at is not null
            union all
            select cc.meeting_at
              from campaign_contacts cc join contacts c on c.id = cc.contact_id
             where c.company_id = co.id and cc.meeting_booked
               and cc.meeting_at is not null and cc.meeting_outcome = 'scheduled'
          ) t
      ) nxt on true
      left join lateral (
        select count(*)::int as meetings from campaign_contacts cc
          join contacts c on c.id = cc.contact_id
         where c.company_id = co.id and cc.meeting_booked
      ) mt on true
      left join lateral (
        -- Kvalifikační kritéria už existují na kampani; tady slouží jako
        -- kontext "podle čeho jsme firmu vybrali".
        select array_agg(distinct cp.qualification_criteria) as criteria
          from campaign_contacts cc
          join campaigns cp on cp.id = cc.campaign_id
          join contacts c on c.id = cc.contact_id
         where c.company_id = co.id and cp.qualification_criteria is not null
      ) qual on true
     where co.id = ${id}
  `;
  return row ?? null;
}

export async function listCompanyContacts(companyId: string): Promise<CompanyContact[]> {
  return sql<CompanyContact[]>`
    select c.id, c.email, c.phone, c.first_name, c.last_name,
           cc.id as campaign_contact_id, cp.name as campaign_name,
           cc.call_status, cc.call_attempts, cc.next_call_at,
           cc.status as email_status,
           exists (select 1 from suppression_list s where s.email = c.email) as suppressed,
           exists (select 1 from call_suppression cs where cs.contact_id = c.id) as do_not_call
      from contacts c
      left join lateral (
        select cc2.* from campaign_contacts cc2
         where cc2.contact_id = c.id
         order by (cc2.call_status in ('new','in_progress','callback')) desc, cc2.created_at desc
         limit 1
      ) cc on true
      left join campaigns cp on cp.id = cc.campaign_id
     where c.company_id = ${companyId}
     order by (c.phone is null or btrim(c.phone) = ''), c.created_at, c.id
  `;
}

/**
 * Celá historie firmy na jednom místě: hovory, e-maily i odpovědi napříč
 * všemi kontakty a kampaněmi. Staví na stejných tabulkách jako timeline
 * jednoho kontaktu, jen o úroveň výš.
 */
export async function getCompanyTimeline(companyId: string): Promise<TimelineEntry[]> {
  return sql<TimelineEntry[]>`
    select ca.id::text as id, 'call' as kind, ca.called_at as occurred_at,
           ca.outcome as title,
           concat_ws(' · ', coalesce(c.first_name || ' ' || coalesce(c.last_name, ''), c.email),
                     'pokus ' || ca.attempt_number,
                     case when ca.connected then 'dovoláno' else 'nedovoláno' end,
                     cl.name) as detail,
           ca.note
      from call_activities ca
      join contacts c on c.id = ca.contact_id
      left join callers cl on cl.id = ca.caller_id
     where c.company_id = ${companyId}

    union all

    select es.id::text, 'email', coalesce(es.sent_at, es.claimed_at),
           es.subject,
           concat_ws(' · ', es.intended_email, 'krok ' || es.step_number, es.status),
           null
      from email_sends es
      join campaign_contacts cc on cc.id = es.campaign_contact_id
      join contacts c on c.id = cc.contact_id
     where c.company_id = ${companyId}

    union all

    select r.id::text, 'reply', r.received_at,
           coalesce(r.subject, 'Odpověď'), r.from_email, r.snippet
      from replies r
      join contacts c on c.id = r.contact_id
     where c.company_id = ${companyId}

     order by occurred_at desc
     limit 200
  `;
}

export interface CompanyPatch {
  reason?: string | null;
  priority?: CompanyPriority;
  status?: CompanyStatus;
  ownerId?: string | null;
  note?: string | null;
}

/** Uloží kontext firmy. Nedotýká se kontaktů, kampaní ani odesílání. */
export async function updateCompany(id: string, patch: CompanyPatch): Promise<boolean> {
  const [row] = await sql<{ name: string }[]>`select name from companies where id = ${id}`;
  if (!row) return false;

  await sql`
    update companies
       set reason   = ${patch.reason === undefined ? sql`reason` : patch.reason},
           priority = coalesce(${patch.priority ?? null}, priority),
           status   = coalesce(${patch.status ?? null}, status),
           owner_id = ${patch.ownerId === undefined ? sql`owner_id` : patch.ownerId},
           note     = ${patch.note === undefined ? sql`note` : patch.note},
           updated_at = now()
     where id = ${id}
  `;
  await logActivity({ action: "Firma upravena", detail: row.name });
  return true;
}

export async function listCompanyOptions(): Promise<{ id: string; name: string }[]> {
  return sql`select id, name from companies order by name limit 500`;
}

/** Krátký kontext firmy pro pracovní kartu callera. */
export async function getCompanyContext(
  companyId: string | null,
): Promise<{ reason: string | null; name: string } | null> {
  if (!companyId) return null;
  const [row] = await sql<{ reason: string | null; name: string }[]>`
    select reason, name from companies where id = ${companyId}
  `;
  return row ?? null;
}
