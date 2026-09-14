import { sql } from "../db";

/**
 * Jediný zdroj pravdy pro čísla o volání.
 *
 * Přehled, Tým i denní postup callera čtou výhradně odsud. Když se to
 * rozejde, každá obrazovka tvrdí něco jiného a nikdo neví, které číslo
 * platí - přesně to se stalo, když každá počítala po svém z
 * `call_activities`.
 *
 * ---------------------------------------------------------------------
 * DEFINICE
 *
 * POKUS (attempt)
 *   Jeden hovor, který uživatel spustil z VEXY a u kterého systém
 *   skutečně začal vytáčet destinaci. Technicky: řádek v `calls`
 *   s přiděleným `provider_call_sid`. Hovor, který se k providerovi
 *   nikdy nedostal (klik, který skončil chybou před vytáčením, nebo
 *   pokus nahrazený novým), pokus není.
 *
 *   Twilio z jednoho hovoru udělá dvě větve - z prohlížeče a odchozí do
 *   sítě. Obě nesou stejný `ParentCallSid`, takže obě míří na tentýž
 *   řádek `calls`. Jeden klik = jeden řádek = jeden pokus, ať už Twilio
 *   vyrobí větví kolik chce.
 *
 *   Do pokusů se počítají i hovory zapsané ručně (z mobilu), které
 *   žádný `calls` řádek nemají - jinak by se ztratila práce, která se
 *   reálně odehrála. Aby se nezapočítaly dvakrát, berou se jen ty
 *   aktivity, které na žádný telefonát navázané nejsou.
 *
 * SPOJENO (connected)
 *   Hovor, který druhá strana skutečně zvedla: `calls.answered_at` není
 *   null. Nezávisí to na výsledku, na kampani ani na tom, jestli někdo
 *   výsledek zapsal - 35 sekund hovoru je 35 sekund hovoru.
 *
 * SCHŮZKA (meeting)
 *   Aktivita s výsledkem `meeting_booked`. Jeden hovor má nejvýš jeden
 *   výsledek, takže se schůzka nemůže započítat dvakrát.
 *
 * DOVOLATELNOST  = spojeno / pokusy   (pokusy = 0 -> null)
 * MEETING RATE   = schůzky / spojeno  (spojeno = 0 -> null)
 * ---------------------------------------------------------------------
 */

export interface CallMetrics {
  attempts: number;
  connected: number;
  meetings: number;
  /** Součet délek spojených hovorů. Null se nesčítá. */
  talk_seconds: number;
  /** connected / attempts, nebo null když se ještě nevolalo. */
  reach_rate: number | null;
  /** meetings / connected, nebo null když se nikdo nedovolal. */
  meeting_rate: number | null;
}

export interface MetricsFilter {
  /** Včetně. Null = bez dolní hranice. */
  from?: Date | null;
  /** Včetně. Null = bez horní hranice. */
  to?: Date | null;
  /** Jen hovory konkrétního člověka. Null = celý tým. */
  callerId?: string | null;
}

/** Dovolatelnost a meeting rate z hotových počtů. Nikde jinde se nepočítají. */
export function deriveRates(counts: {
  attempts: number;
  connected: number;
  meetings: number;
}): { reach_rate: number | null; meeting_rate: number | null } {
  return {
    reach_rate: counts.attempts > 0 ? counts.connected / counts.attempts : null,
    meeting_rate: counts.connected > 0 ? counts.meetings / counts.connected : null,
  };
}

/**
 * Čísla za období.
 *
 * Dvě větve sjednocené do jednoho dotazu: telefonáty z VEXY a ručně
 * zapsané hovory bez telefonátu. Průnik je prázdný, takže se nic
 * nepočítá dvakrát.
 */
export async function getCallMetrics(filter: MetricsFilter = {}): Promise<CallMetrics> {
  const from = filter.from ?? null;
  const to = filter.to ?? null;
  const callerId = filter.callerId ?? null;

  const [row] = await sql<
    { attempts: number; connected: number; meetings: number; talk_seconds: number }[]
  >`
    with dialed as (
      -- Telefonát, u kterého se skutečně vytáčelo.
      select c.id,
             (c.answered_at is not null) as connected,
             coalesce(c.duration_seconds, 0) as seconds,
             c.call_activity_id
        from calls c
       where c.provider_call_sid is not null
         and (${from}::timestamptz is null or c.started_at >= ${from}::timestamptz)
         and (${to}::timestamptz is null or c.started_at <= ${to}::timestamptz)
         and (${callerId}::uuid is null or c.caller_id = ${callerId}::uuid)
    ),
    manual as (
      -- Hovor zapsaný ručně, ke kterému žádný telefonát neexistuje.
      select ca.id,
             ca.connected,
             0 as seconds
        from call_activities ca
       where not exists (select 1 from calls c2 where c2.call_activity_id = ca.id)
         and (${from}::timestamptz is null or ca.called_at >= ${from}::timestamptz)
         and (${to}::timestamptz is null or ca.called_at <= ${to}::timestamptz)
         and (${callerId}::uuid is null or ca.caller_id = ${callerId}::uuid)
    ),
    attempts as (
      select connected, seconds from dialed
      union all
      select connected, seconds from manual
    )
    select
      (select count(*)::int from attempts) as attempts,
      (select count(*)::int from attempts where connected) as connected,
      (select coalesce(sum(seconds), 0)::int from attempts where connected) as talk_seconds,
      -- Schůzka se počítá z výsledku, ne z telefonátu: vznikne i u hovoru
      -- zapsaného ručně a u telefonátu je právě jedna.
      (select count(*)::int from call_activities ca
        where ca.outcome = 'meeting_booked'
          and (${from}::timestamptz is null or ca.called_at >= ${from}::timestamptz)
          and (${to}::timestamptz is null or ca.called_at <= ${to}::timestamptz)
          and (${callerId}::uuid is null or ca.caller_id = ${callerId}::uuid)) as meetings
  `;

  const counts = {
    attempts: row?.attempts ?? 0,
    connected: row?.connected ?? 0,
    meetings: row?.meetings ?? 0,
  };
  return { ...counts, talk_seconds: row?.talk_seconds ?? 0, ...deriveRates(counts) };
}

export interface CallerMetrics extends CallMetrics {
  caller_id: string;
}

/**
 * Stejná čísla, rozpadlá po lidech.
 *
 * Jeden dotaz místo N - tým se vykresluje na každé návštěvě /tym.
 * Hovory bez přiřazeného člověka se sem nedostanou (nemají komu patřit),
 * ale v celkových číslech zůstávají: `getCallMetrics` je nefiltruje.
 */
export async function getMetricsByCaller(
  filter: Omit<MetricsFilter, "callerId"> = {},
): Promise<Map<string, CallMetrics>> {
  const from = filter.from ?? null;
  const to = filter.to ?? null;

  const rows = await sql<
    { caller_id: string; attempts: number; connected: number; meetings: number; talk_seconds: number }[]
  >`
    with dialed as (
      select c.caller_id,
             (c.answered_at is not null) as connected,
             coalesce(c.duration_seconds, 0) as seconds
        from calls c
       where c.provider_call_sid is not null
         and c.caller_id is not null
         and (${from}::timestamptz is null or c.started_at >= ${from}::timestamptz)
         and (${to}::timestamptz is null or c.started_at <= ${to}::timestamptz)
    ),
    manual as (
      select ca.caller_id, ca.connected, 0 as seconds
        from call_activities ca
       where ca.caller_id is not null
         and not exists (select 1 from calls c2 where c2.call_activity_id = ca.id)
         and (${from}::timestamptz is null or ca.called_at >= ${from}::timestamptz)
         and (${to}::timestamptz is null or ca.called_at <= ${to}::timestamptz)
    ),
    attempts as (
      select caller_id, connected, seconds from dialed
      union all
      select caller_id, connected, seconds from manual
    ),
    meetings as (
      select ca.caller_id, count(*)::int as meetings
        from call_activities ca
       where ca.outcome = 'meeting_booked'
         and ca.caller_id is not null
         and (${from}::timestamptz is null or ca.called_at >= ${from}::timestamptz)
         and (${to}::timestamptz is null or ca.called_at <= ${to}::timestamptz)
       group by ca.caller_id
    )
    select coalesce(a.caller_id, m.caller_id) as caller_id,
           coalesce(a.attempts, 0) as attempts,
           coalesce(a.connected, 0) as connected,
           coalesce(a.talk_seconds, 0) as talk_seconds,
           coalesce(m.meetings, 0) as meetings
      from (
        select caller_id,
               count(*)::int as attempts,
               count(*) filter (where connected)::int as connected,
               coalesce(sum(seconds) filter (where connected), 0)::int as talk_seconds
          from attempts group by caller_id
      ) a
      full outer join meetings m on m.caller_id = a.caller_id
  `;

  const result = new Map<string, CallMetrics>();
  for (const row of rows) {
    const counts = { attempts: row.attempts, connected: row.connected, meetings: row.meetings };
    result.set(row.caller_id, { ...counts, talk_seconds: row.talk_seconds, ...deriveRates(counts) });
  }
  return result;
}

/** Dnešek jednoho callera. Stejná definice jako všude jinde. */
export async function getCallerToday(callerId: string): Promise<CallMetrics> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return getCallMetrics({ from: start, callerId });
}

export interface CallReportRow {
  id: string;
  started_at: Date;
  caller_name: string | null;
  contact_name: string | null;
  contact_id: string;
  company_name: string | null;
  company_id: string | null;
  destination: string;
  status: string;
  connected: boolean;
  duration_seconds: number | null;
  outcome: string | null;
  has_recording: boolean;
}

/**
 * Jednotlivé hovory pro přehled volání.
 *
 * Jen skutečně vytáčené telefonáty - ručně zapsané aktivity tu nemají co
 * ukazovat (nemají délku, nahrávku ani stav) a v součtech výš jsou.
 */
export async function listCallReport(
  filter: MetricsFilter & { limit?: number; status?: "connected" | "missed" | null } = {},
): Promise<CallReportRow[]> {
  const from = filter.from ?? null;
  const to = filter.to ?? null;
  const callerId = filter.callerId ?? null;
  const status = filter.status ?? null;

  return sql<CallReportRow[]>`
    select c.id, c.started_at, c.destination, c.status,
           (c.answered_at is not null) as connected,
           c.duration_seconds,
           c.contact_id, c.company_id,
           (c.recording_url is not null) as has_recording,
           cl.name as caller_name,
           coalesce(nullif(btrim(coalesce(ct.first_name, '') || ' ' || coalesce(ct.last_name, '')), ''),
                    ct.email) as contact_name,
           co.name as company_name,
           ca.outcome
      from calls c
      join contacts ct on ct.id = c.contact_id
      left join callers cl on cl.id = c.caller_id
      left join companies co on co.id = c.company_id
      left join call_activities ca on ca.id = c.call_activity_id
     where c.provider_call_sid is not null
       and (${from}::timestamptz is null or c.started_at >= ${from}::timestamptz)
       and (${to}::timestamptz is null or c.started_at <= ${to}::timestamptz)
       and (${callerId}::uuid is null or c.caller_id = ${callerId}::uuid)
       and (${status}::text is null
            or (${status} = 'connected' and c.answered_at is not null)
            or (${status} = 'missed' and c.answered_at is null))
     order by c.started_at desc
     limit ${filter.limit ?? 200}
  `;
}
