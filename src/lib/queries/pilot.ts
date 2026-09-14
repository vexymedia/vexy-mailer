import { sql } from "../db";

/**
 * Čísla jedné kampaně tak, jak se o nich mluví s klientem.
 *
 * Celý smysl je jeden rozdíl, na kterém se dá reporting snadno rozbít:
 *
 *   POKUS   = jedno vytočení. Jeden kontakt jich může mít víc.
 *   KONTAKT = člověk. Počítá se jednou, ať jsme mu volali kolikrát chceme.
 *
 * Když se tyhle dvě věci slijí, vypadá pilot jako by měl třikrát víc
 * práce hotové, než doopravdy má. Proto tu nic nevrací "počet hovorů"
 * tam, kde se ptáme na lidi.
 *
 * Definice pokusu a spojení se přebírá z `queries/reporting.ts`, aby
 * klientský report a interní čísla nemohly říkat každé něco jiného.
 */

/** Výsledky, po kterých se na kontakt v téhle kampani přestává volat. */
const TERMINAL_STATUSES = ["meeting_booked", "won", "lost", "do_not_call", "max_attempts"];

/** Výsledky, které znamenají reálný obchodní posun, ne jen spojení. */
const POSITIVE_OUTCOMES = ["meeting_booked", "won", "send_info", "callback"];

export interface PilotReport {
  /** Unikátní kontakty v kampani. Rozsah pilotu. */
  target_contacts: number;
  /** Kontakty s terminálním výsledkem, nebo s platným dalším krokem. */
  processed_contacts: number;
  /** Kontakty, které ještě čekají na první nebo další pokus. */
  remaining_contacts: number;
  /** Kontakty bez telefonu - volat je nejde, i když v kampani jsou. */
  unreachable_contacts: number;
  /** Skutečná vytočení. Jeden kontakt jich má běžně několik. */
  call_attempts: number;
  /** Unikátní kontakty, se kterými se někdo opravdu bavil. */
  connected_contacts: number;
  /** Unikátní kontakty s domluveným termínem dalšího hovoru. */
  callbacks: number;
  /** Unikátní kontakty s pozitivním obchodním výsledkem. */
  positive_conversations: number;
  /** Unikátní kontakty s domluvenou schůzkou. */
  meetings: number;
  /** Kontakty, u kterých jsme skončili bez obchodu. */
  disqualified: number;
}

export async function getPilotReport(campaignId: string): Promise<PilotReport> {
  const [row] = await sql<PilotReport[]>`
    select
      (select count(*)::int from campaign_contacts
        where campaign_id = ${campaignId}) as target_contacts,

      -- Zpracovaný = má terminální výsledek, nebo naplánovaný další krok.
      -- Kontakt, na kterém se ještě nic nestalo, se sem počítat nesmí.
      (select count(*)::int from campaign_contacts cc
        where cc.campaign_id = ${campaignId}
          and (cc.call_status = any(${TERMINAL_STATUSES})
               or (cc.call_attempts > 0 and cc.next_call_at is not null))) as processed_contacts,

      (select count(*)::int from campaign_contacts cc
        join contacts c on c.id = cc.contact_id
        where cc.campaign_id = ${campaignId}
          and cc.call_status not in ('meeting_booked', 'won', 'lost', 'do_not_call', 'max_attempts')
          and c.phone is not null and btrim(c.phone) <> ''
          and cc.call_attempts < (select max_call_attempts from campaigns where id = ${campaignId}))
        as remaining_contacts,

      (select count(*)::int from campaign_contacts cc
        join contacts c on c.id = cc.contact_id
        where cc.campaign_id = ${campaignId}
          and (c.phone is null or btrim(c.phone) = '')) as unreachable_contacts,

      -- Pokusy z tabulky hovorů: to je skutečné vytáčení, ne zapsaný výsledek.
      -- Ručně zapsaný hovor bez telefonátu se přidává zvlášť, aby se
      -- neztratila práce udělaná z mobilu.
      ((select count(*)::int from calls cl
         join campaign_contacts cc on cc.id = cl.campaign_contact_id
        where cc.campaign_id = ${campaignId} and cl.provider_call_sid is not null)
       + (select count(*)::int from call_activities ca
           where ca.campaign_id = ${campaignId}
             and not exists (select 1 from calls c2 where c2.call_activity_id = ca.id)))
        as call_attempts,

      -- Spojení se počítá na lidi, ne na hovory.
      (select count(distinct cc.id)::int
         from campaign_contacts cc
        where cc.campaign_id = ${campaignId}
          and (exists (select 1 from calls cl
                        where cl.campaign_contact_id = cc.id and cl.answered_at is not null)
               or exists (select 1 from call_activities ca
                           where ca.campaign_contact_id = cc.id and ca.connected)))
        as connected_contacts,

      (select count(*)::int from campaign_contacts
        where campaign_id = ${campaignId}
          and call_status = 'callback' and next_call_at is not null) as callbacks,

      (select count(distinct ca.campaign_contact_id)::int from call_activities ca
        where ca.campaign_id = ${campaignId}
          and ca.outcome = any(${POSITIVE_OUTCOMES})) as positive_conversations,

      (select count(*)::int from campaign_contacts
        where campaign_id = ${campaignId} and meeting_booked) as meetings,

      (select count(*)::int from campaign_contacts
        where campaign_id = ${campaignId}
          and call_status in ('lost', 'do_not_call', 'max_attempts')) as disqualified
  `;
  return row;
}

export interface DisqualificationReason {
  outcome: string;
  contacts: number;
}

/**
 * Proč jsme přestali.
 *
 * Počítá se poslední výsledek na kontakt, ne všechny zápisy: kontakt,
 * kterému jsme třikrát nedovolali a pak řekl "nemá zájem", je jeden
 * důvod vyřazení, ne čtyři.
 */
export async function listDisqualificationReasons(
  campaignId: string,
): Promise<DisqualificationReason[]> {
  return sql<DisqualificationReason[]>`
    select last_outcome as outcome, count(*)::int as contacts
      from (
        select distinct on (cc.id) cc.id, ca.outcome as last_outcome
          from campaign_contacts cc
          join call_activities ca on ca.campaign_contact_id = cc.id
         where cc.campaign_id = ${campaignId}
           and cc.call_status in ('lost', 'do_not_call', 'max_attempts')
         order by cc.id, ca.called_at desc
      ) latest
     group by last_outcome
     order by contacts desc, last_outcome
  `;
}
