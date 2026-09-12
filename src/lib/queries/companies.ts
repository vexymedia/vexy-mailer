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

/**
 * Další krok firmy: nejbližší naplánovaný hovor nebo domluvená schůzka.
 *
 * Funkce, ne konstanta, aby si každý dotaz vzal vlastní fragment. Používá se
 * i ve WHERE, protože filtr "Bez dalšího kroku" musí platit i pro count -
 * a ten žádné lateraly nemá.
 */
const nextActionAt = () => sql`(
  select min(t.at)
    from (
      select cc.next_call_at as at
        from campaign_contacts cc join contacts c on c.id = cc.contact_id
       where c.company_id = co.id
         and cc.call_status in ('new', 'in_progress', 'callback')
         and cc.next_call_at is not null
      union all
      select cc.meeting_at
        from campaign_contacts cc join contacts c on c.id = cc.contact_id
       where c.company_id = co.id and cc.meeting_booked
         and cc.meeting_at is not null and cc.meeting_outcome = 'scheduled'
    ) t
)`;

/** Kolikrát jsme se o firmu pokusili - přes všechny její kontakty dohromady. */
const companyAttempts = () => sql`(
  select coalesce(sum(cc.call_attempts), 0)::int
    from campaign_contacts cc join contacts c on c.id = cc.contact_id
   where c.company_id = co.id
)`;

/** Poslední stopa po firmě: hovor, odeslaný e-mail nebo odpověď. */
const lastActivityAt = () => sql`greatest(
  (select max(ca.called_at) from call_activities ca
     join contacts c on c.id = ca.contact_id where c.company_id = co.id),
  (select max(coalesce(es.sent_at, es.claimed_at)) from email_sends es
     join campaign_contacts cc on cc.id = es.campaign_contact_id
     join contacts c on c.id = cc.contact_id where c.company_id = co.id),
  (select max(r.received_at) from replies r
     join contacts c on c.id = r.contact_id where c.company_id = co.id)
)`;

/**
 * Je aspoň jeden kontakt firmy právě na řadě?
 *
 * Stejné podmínky jako fronta volání v queries/calling.ts - firma nesmí
 * v seznamu tvrdit "je ve frontě", když ji caller nikdy neuvidí.
 */
const inCallQueue = () => sql`exists (
  select 1
    from campaign_contacts cc
    join campaigns cp on cp.id = cc.campaign_id
    join contacts c on c.id = cc.contact_id
   where c.company_id = co.id
     and cp.calling_enabled
     and cc.call_status in ('new', 'in_progress', 'callback')
     and cc.call_attempts < cp.max_call_attempts
     and c.phone is not null and btrim(c.phone) <> ''
     and not exists (select 1 from call_suppression cs where cs.contact_id = cc.contact_id)
     and (cc.next_call_at is null or cc.next_call_at <= now())
     and co.status not in ('won', 'lost', 'excluded')
)`;

/**
 * Stavy, ve kterých firmu aktivně řešíme. Firma v některém z nich BEZ
 * dalšího kroku je přesně to, co se v praxi ztratí - proto má vlastní
 * příznak i vlastní pohled v seznamu.
 */
const ACTIVE_COMPANY_STATUSES = ["ready", "in_progress", "interested", "meeting"];

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
  /** Součet pokusů o volání přes všechny kontakty firmy. */
  attempts: number;
  /** Aktivní firma bez naplánovaného dalšího kroku. */
  needs_attention: boolean;
}

/**
 * Co dělat s firmou dál:
 *   `due`   - další krok už měl proběhnout nebo je na dnešek,
 *   `today` - dnešní follow-up,
 *   `none`  - aktivní firma, která žádný další krok nemá.
 */
export type NextActionFilter = "due" | "today" | "none";

/** Jak dávno se s firmou naposledy něco dělo. */
export type ActivityFilter = "7d" | "30d" | "stale" | "never";

export interface CompanyFilters {
  search?: string | null;
  status?: CompanyStatus | null;
  priority?: CompanyPriority | null;
  ownerId?: string | null;
  /** Jen firmy, které právě čekají ve frontě k oslovení. */
  queueOnly?: boolean;
  nextAction?: NextActionFilter | null;
  activity?: ActivityFilter | null;
  /** "Zkoušeli jsme to už N×" - pohled na firmy, kde volání nikam nevede. */
  minAttempts?: number | null;
  /** Jen firmy s domluvenou schůzkou. */
  meetingsOnly?: boolean;
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
  const nextAction = filters.nextAction ?? null;
  const activity = filters.activity ?? null;
  const minAttempts = filters.minAttempts ?? null;
  const meetingsOnly = filters.meetingsOnly ?? false;
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
      and (${queueOnly} = false or ${inCallQueue()})
      and (${meetingsOnly} = false or exists (
            select 1 from campaign_contacts cc join contacts c4 on c4.id = cc.contact_id
             where c4.company_id = co.id and cc.meeting_booked))
      and (${minAttempts}::int is null or ${companyAttempts()} >= ${minAttempts}::int)
      and case ${nextAction}::text
            when 'due'   then ${nextActionAt()} is not null
                            and ${nextActionAt()} < date_trunc('day', now()) + interval '1 day'
            when 'today' then ${nextActionAt()} >= date_trunc('day', now())
                            and ${nextActionAt()} < date_trunc('day', now()) + interval '1 day'
            -- "Bez dalšího kroku" schválně jen pro aktivní firmy. Nová firma,
            -- kterou jsme ještě nezačali řešit, nikde nechybí.
            when 'none'  then co.status = any(${ACTIVE_COMPANY_STATUSES}::text[])
                            and ${nextActionAt()} is null
            else true
          end
      and case ${activity}::text
            when '7d'    then ${lastActivityAt()} >= now() - interval '7 days'
            when '30d'   then ${lastActivityAt()} >= now() - interval '30 days'
            when 'stale' then ${lastActivityAt()} is null
                            or ${lastActivityAt()} < now() - interval '14 days'
            when 'never' then ${lastActivityAt()} is null
            else true
          end
  `;

  const rows = await sql<CompanyRow[]>`
    select co.id, co.name, co.website, co.reason, co.priority, co.status,
           co.owner_id, ow.name as owner_name,
           (select count(*)::int from contacts c where c.company_id = co.id) as contacts_count,
           mc.name as main_contact_name,
           mc.email as main_contact_email,
           mc.phone as main_contact_phone,
           ${lastActivityAt()} as last_activity_at,
           ${nextActionAt()} as next_action_at,
           ${inCallQueue()} as in_queue,
           ${companyAttempts()} as attempts,
           (co.status = any(${ACTIVE_COMPANY_STATUSES}::text[]) and ${nextActionAt()} is null)
             as needs_attention,
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
        select count(*)::int as meetings
          from campaign_contacts cc
          join contacts c on c.id = cc.contact_id
         where c.company_id = co.id and cc.meeting_booked
      ) mt on true
      ${where}
     order by
       -- Práce napřed: co je splatné dnes, pak priorita, pak jméno. Firma bez
       -- dalšího kroku je taky práce, jen ji nikdo nenaplánoval.
       case when ${nextActionAt()} < date_trunc('day', now()) + interval '1 day' then 0
            when co.status = any(${ACTIVE_COMPANY_STATUSES}::text[]) and ${nextActionAt()} is null then 1
            else 2 end,
       case co.priority when 'high' then 0 when 'normal' then 1 else 2 end,
       ${nextActionAt()} nulls last,
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
  last_call_at: Date | null;
  last_call_outcome: string | null;
  email_status: string | null;
  suppressed: boolean;
  do_not_call: boolean;
  /**
   * Jde tomuhle člověku teď zavolat? Stejné podmínky jako fronta - tlačítko
   * "Zavolat" nesmí vést na kontakt, který je na do-not-call listu nebo
   * nemá telefon.
   */
  callable: boolean;
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
           ${lastActivityAt()} as last_activity_at,
           ${nextActionAt()} as next_action_at,
           ${inCallQueue()} as in_queue,
           ${companyAttempts()} as attempts,
           (co.status = any(${ACTIVE_COMPANY_STATUSES}::text[]) and ${nextActionAt()} is null)
             as needs_attention,
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
           cc.last_call_at, cc.last_call_outcome,
           cc.status as email_status,
           exists (select 1 from suppression_list s where s.email = c.email) as suppressed,
           exists (select 1 from call_suppression cs where cs.contact_id = c.id) as do_not_call,
           (cc.id is not null
            and cp.calling_enabled
            and cc.call_status in ('new', 'in_progress', 'callback')
            and cc.call_attempts < cp.max_call_attempts
            and c.phone is not null and btrim(c.phone) <> ''
            and not exists (select 1 from call_suppression cs2 where cs2.contact_id = c.id))
             as callable
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
