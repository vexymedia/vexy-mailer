import { sql } from "../db";

/**
 * Příležitosti k předání klientovi.
 *
 * VEXY prodává první část salesu: vybrat lidi, oslovit je, navolat
 * a předat klientovi konkrétní jednání. Tohle je ta poslední část -
 * seznam, ze kterého se dá říct „tady jsou jednání, která má váš obchodník
 * převzít".
 *
 * ŽÁDNÁ nová entita. Čte se jen to, co už v databázi je: stav volání,
 * klasifikace konverzace, poznámka z hovoru, termín schůzky. Nic se tu
 * nedovozuje ani neklasifikuje automaticky - příležitost je jen to, co
 * někdo výslovně takhle označil.
 *
 * Dva zdroje, protože zájem přijde dvěma kanály:
 *   * z hovoru  - výsledek `meeting_booked` nebo `won`,
 *   * z e-mailu - konverzace ručně označená jako „Pozitivní".
 *
 * Kontakt může mít obojí; řádek je proto jeden na enrollment a oba důvody
 * se na něm ukážou vedle sebe.
 */

export interface Opportunity {
  campaign_contact_id: string;
  contact_id: string;
  contact_name: string | null;
  email: string;
  phone: string | null;
  position: string | null;
  company: string | null;
  company_id: string | null;
  client_name: string | null;
  campaign_id: string;
  campaign_name: string;
  /** Stav z telefonní půlky. */
  call_status: string;
  /** Poslední výsledek hovoru, pokud nějaký byl. */
  last_call_outcome: string | null;
  /** Poznámka operátora z hovoru - tohle je ten kontext, co klient chce. */
  call_note: string | null;
  /** Domluvený termín schůzky. */
  meeting_at: Date | null;
  meeting_outcome: string | null;
  /** Domluvený callback, pokud místo schůzky padl ten. */
  next_call_at: Date | null;
  /** Odpověděl e-mailem a někdo ji označil za pozitivní? */
  positive_reply: boolean;
  /** Vlákno k otevření, když pozitivní odpověď existuje. */
  conversation_id: string | null;
  /** Kdy se naposledy něco stalo - podle toho se řadí. */
  last_activity_at: Date;
}

export interface OpportunityFilters {
  campaignId?: string | null;
  clientId?: string | null;
}

/**
 * Otevřené příležitosti, nejnovější nahoře.
 *
 * `won` a `meeting_booked` jsou jednoznačné. `callback` sem schválně
 * NEPATŘÍ: to je nedodělaná práce operátora, ne hotové jednání pro
 * klienta - jinak by se seznam zaplnil věcmi, které nemá kdo převzít.
 */
export async function listOpportunities(filters: OpportunityFilters = {}): Promise<Opportunity[]> {
  return sql<Opportunity[]>`
    select cc.id as campaign_contact_id,
           c.id as contact_id,
           nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') as contact_name,
           c.email, c.phone, c.position,
           coalesce(co.name, c.company) as company,
           c.company_id,
           cl.name as client_name,
           cp.id as campaign_id, cp.name as campaign_name,
           cc.call_status, cc.last_call_outcome, cc.call_note,
           cc.meeting_at, cc.meeting_outcome, cc.next_call_at,
           (cv.id is not null) as positive_reply,
           cv.id as conversation_id,
           greatest(
             coalesce(cc.last_call_at, cc.updated_at),
             coalesce(cv.last_message_at, cc.updated_at),
             cc.updated_at
           ) as last_activity_at
      from campaign_contacts cc
      join contacts c on c.id = cc.contact_id
      join campaigns cp on cp.id = cc.campaign_id
      left join clients cl on cl.id = cp.client_id
      left join companies co on co.id = c.company_id
      -- Pozitivně označená konverzace téhož kontaktu v téže kampani.
      left join lateral (
        select cv2.id, cv2.last_message_at
          from conversations cv2
         where cv2.contact_id = cc.contact_id
           and cv2.campaign_id = cc.campaign_id
           and cv2.classification = 'positive'
         order by cv2.last_message_at desc
         limit 1
      ) cv on true
     where (cc.call_status in ('meeting_booked', 'won') or cv.id is not null)
       -- Kdo řekl „nekontaktovat", není příležitost, i kdyby měl v historii
       -- pozitivní vlákno.
       and cc.status <> 'unsubscribed'
       and cc.call_status <> 'do_not_call'
       and (${filters.campaignId ?? null}::uuid is null or cp.id = ${filters.campaignId ?? null}::uuid)
       and (${filters.clientId ?? null}::uuid is null or cp.client_id = ${filters.clientId ?? null}::uuid)
     order by last_activity_at desc
  `;
}

/** Kolik příležitostí čeká. Pro odznak v navigaci a přehled kampaně. */
export async function countOpportunities(filters: OpportunityFilters = {}): Promise<number> {
  return (await listOpportunities(filters)).length;
}
