import { sql } from "../db";
import { logActivity } from "../activity";
import {
  isFinalLifecycle,
  shouldAdvanceLifecycle,
  toE164,
  type CallAnalysis,
  type CallLifecycle,
} from "../telephony/call-state";

/**
 * Technický záznam telefonátu.
 *
 * Doménu hovoru (výsledek, další krok, počet pokusů) drží dál
 * queries/calling.ts - tohle je jen to, co udělal provider a co z nahrávky
 * vzniklo. Jediné místo, kde se obojí potkává, je `call_activity_id`.
 */

export interface CallRow {
  id: string;
  contact_id: string;
  campaign_contact_id: string | null;
  company_id: string | null;
  caller_id: string | null;
  call_activity_id: string | null;
  provider: string;
  provider_call_sid: string | null;
  direction: string;
  status: CallLifecycle;
  destination: string;
  from_number: string | null;
  started_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  recording_status: string;
  recording_sid: string | null;
  recording_url: string | null;
  recording_duration_seconds: number | null;
  recording_error: string | null;
  transcript_status: string;
  transcript: string | null;
  transcript_language: string | null;
  transcript_error: string | null;
  analysis_status: string;
  analysis: CallAnalysis | null;
  analysis_error: string | null;
  suggested_outcome: string | null;
  error_code: string | null;
  error_message: string | null;
}

export interface CallTarget {
  callId: string;
  destination: string;
  contactId: string;
  contactName: string;
  companyId: string | null;
  companyName: string | null;
  campaignContactId: string | null;
}

export type StartCallResult =
  | { ok: true; call: CallTarget }
  | { ok: false; error: string; code: "not_found" | "no_phone" | "suppressed" | "closed" };

/**
 * Založí hovor a vrátí jeho id.
 *
 * Klíčové bezpečnostní rozhodnutí celé vrstvy: číslo se NEBERE od klienta.
 * Prohlížeč pošle jen id kontaktu, server si dohledá číslo sám a od té
 * chvíle se vytáčí podle databáze. Jinak by kdokoli se session mohl přes
 * náš Twilio účet vytočit libovolné číslo na světě.
 */
export async function startCall(input: {
  contactId?: string | null;
  campaignContactId?: string | null;
  callerId: string | null;
}): Promise<StartCallResult> {
  // Kontakt se dohledá nejdřív, aby zbytek byl jeden jednoduchý dotaz.
  let contactId = input.contactId ?? null;
  if (input.campaignContactId) {
    const [owner] = await sql<{ contact_id: string }[]>`
      select contact_id from campaign_contacts where id = ${input.campaignContactId}
    `;
    if (!owner) return { ok: false, error: "Kontakt nebyl nalezen.", code: "not_found" };
    contactId = owner.contact_id;
  }
  if (!contactId) return { ok: false, error: "Kontakt nebyl nalezen.", code: "not_found" };

  const [row] = await sql<
    {
      contact_id: string;
      campaign_contact_id: string | null;
      company_id: string | null;
      company_name: string | null;
      company_status: string | null;
      phone: string | null;
      first_name: string | null;
      last_name: string | null;
      email: string;
      suppressed: boolean;
    }[]
  >`
    select c.id as contact_id,
           coalesce(${input.campaignContactId ?? null}::uuid, cc.id) as campaign_contact_id,
           c.company_id,
           co.name as company_name,
           co.status as company_status,
           c.phone, c.first_name, c.last_name, c.email,
           exists (select 1 from call_suppression cs where cs.contact_id = c.id) as suppressed
      from contacts c
      left join companies co on co.id = c.company_id
      -- Otevřený záznam v kampani má přednost; bez něj se vezme poslední.
      left join lateral (
        select cc2.id
          from campaign_contacts cc2
         where cc2.contact_id = c.id
         order by (cc2.call_status in ('new','in_progress','callback')) desc, cc2.created_at desc
         limit 1
      ) cc on true
     where c.id = ${contactId}
  `;

  if (!row) return { ok: false, error: "Kontakt nebyl nalezen.", code: "not_found" };

  // Do-not-call je globální a platí i tady. Bez téhle kontroly by stačilo
  // otevřít starou záložku s tlačítkem Zavolat.
  if (row.suppressed) {
    return {
      ok: false,
      error: "Tento člověk je na seznamu „nevolat“. Volat mu nelze.",
      code: "suppressed",
    };
  }

  const destination = toE164(row.phone);
  if (!destination) {
    return {
      ok: false,
      error: row.phone
        ? `Číslo „${row.phone}“ nevypadá jako telefonní číslo, které jde vytočit.`
        : "Kontakt nemá telefonní číslo.",
      code: "no_phone",
    };
  }

  if (row.company_status && ["won", "lost", "excluded"].includes(row.company_status)) {
    return {
      ok: false,
      error: "Firma je uzavřená — pokud jí chcete volat, nejdřív ji znovu otevřete.",
      code: "closed",
    };
  }

  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim() || row.email;

  const [created] = await sql<{ id: string }[]>`
    insert into calls (contact_id, campaign_contact_id, company_id, caller_id, destination)
    values (${row.contact_id}, ${row.campaign_contact_id}, ${row.company_id},
            ${input.callerId}, ${destination})
    returning id
  `;

  return {
    ok: true,
    call: {
      callId: created.id,
      destination,
      contactId: row.contact_id,
      contactName: name,
      companyId: row.company_id,
      companyName: row.company_name,
      campaignContactId: row.campaign_contact_id,
    },
  };
}

/** Hovor, který právě čeká na spojení. Čte ho TwiML endpoint. */
export async function getCallForDial(callId: string): Promise<CallRow | null> {
  const [row] = await sql<CallRow[]>`select * from calls where id = ${callId}`;
  return row ?? null;
}

export async function getCall(callId: string): Promise<CallRow | null> {
  const [row] = await sql<CallRow[]>`select * from calls where id = ${callId}`;
  return row ?? null;
}

/** Spojí náš záznam s hovorem u providera. Idempotentní. */
export async function attachProviderCall(
  callId: string,
  providerCallSid: string,
  fromNumber: string | null,
): Promise<void> {
  await sql`
    update calls
       set provider_call_sid = coalesce(provider_call_sid, ${providerCallSid}),
           from_number = coalesce(from_number, ${fromNumber}),
           updated_at = now()
     where id = ${callId}
  `;
}

/**
 * Zapíše stav z webhooku.
 *
 * Twilio negarantuje pořadí ani doručení právě jednou, takže se tu nesmí
 * nic přepsat "dozadu": jednou ukončený hovor zůstane ukončený, i když
 * pak dorazí opožděné "vyzvání".
 */
export async function recordCallStatus(input: {
  callId?: string | null;
  providerCallSid?: string | null;
  status: CallLifecycle;
  durationSeconds?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  recordingDisabled?: boolean;
}): Promise<CallRow | null> {
  const [existing] = await sql<CallRow[]>`
    select * from calls
     where (${input.callId ?? null}::uuid is not null and id = ${input.callId ?? null}::uuid)
        or (${input.providerCallSid ?? null}::text is not null
            and provider_call_sid = ${input.providerCallSid ?? null})
     limit 1
  `;
  if (!existing) return null;
  if (!shouldAdvanceLifecycle(existing.status, input.status)) return existing;

  // Spojeno = buď to dorazilo jako "answered", nebo přišlo rovnou
  // "completed" s nenulovou délkou. Druhý případ nastane, když se událost
  // o zvednutí ztratí - a bez tohohle by se dovolaný hovor tvářil jako
  // nedovolaný.
  const connected =
    input.status === "in_progress" ||
    (input.status === "completed" && (input.durationSeconds ?? 0) > 0);
  const answeredAt = connected && !existing.answered_at ? new Date() : null;
  const endedAt = isFinalLifecycle(input.status) ? new Date() : null;

  // Nahrávka vznikne jen u hovoru, který se spojil. U nedovolaného nemá
  // smysl na ni čekat - zůstalo by "zpracovává se" navždy.
  const recordingStatus =
    input.recordingDisabled || (isFinalLifecycle(input.status) && input.status !== "completed")
      ? "disabled"
      : null;

  const [row] = await sql<CallRow[]>`
    update calls
       set status = ${input.status},
           answered_at = coalesce(answered_at, ${answeredAt}),
           ended_at = coalesce(ended_at, ${endedAt}),
           duration_seconds = coalesce(${input.durationSeconds ?? null}, duration_seconds),
           error_code = coalesce(${input.errorCode ?? null}, error_code),
           error_message = coalesce(${input.errorMessage ?? null}, error_message),
           recording_status = case
             when ${recordingStatus}::text is not null and recording_status = 'pending'
               then ${recordingStatus}
             else recording_status
           end,
           -- Bez nahrávky není co přepisovat ani analyzovat.
           transcript_status = case
             when ${recordingStatus}::text = 'disabled' and transcript_status = 'pending'
               then 'skipped' else transcript_status end,
           analysis_status = case
             when ${recordingStatus}::text = 'disabled' and analysis_status = 'pending'
               then 'skipped' else analysis_status end,
           updated_at = now()
     where id = ${existing.id}
    returning *
  `;
  return row ?? null;
}

/** Zápis z recording webhooku. */
export async function recordRecording(input: {
  providerCallSid: string;
  recordingSid: string | null;
  recordingUrl: string | null;
  durationSeconds: number | null;
  status: "completed" | "absent" | "failed";
}): Promise<CallRow | null> {
  const available = input.status === "completed" && Boolean(input.recordingUrl);
  const [row] = await sql<CallRow[]>`
    update calls
       set recording_sid = coalesce(${input.recordingSid}, recording_sid),
           recording_url = coalesce(${input.recordingUrl}, recording_url),
           recording_duration_seconds = coalesce(${input.durationSeconds}, recording_duration_seconds),
           recording_status = ${available ? "available" : "failed"},
           recording_error = ${available ? null : `Twilio hlásí nahrávku jako „${input.status}“.`},
           -- Bez nahrávky nemá smysl držet přepis ve frontě.
           transcript_status = case
             when ${available} then transcript_status
             when transcript_status = 'pending' then 'skipped' else transcript_status end,
           analysis_status = case
             when ${available} then analysis_status
             when analysis_status = 'pending' then 'skipped' else analysis_status end,
           updated_at = now()
     where provider_call_sid = ${input.providerCallSid}
    returning *
  `;
  return row ?? null;
}

// ------------------------------------------------------------- pipeline

/**
 * Hovory čekající na přepis nebo analýzu.
 *
 * `processing` se schválně nebere: běžící zpracování se nemá spustit
 * podruhé. Zaseknuté `processing` uvolní resetStalePipeline().
 */
export async function listPipelineWork(limit = 3): Promise<CallRow[]> {
  return sql<CallRow[]>`
    select * from calls
     where (recording_status = 'available' and transcript_status = 'pending')
        or (transcript_status = 'done' and analysis_status = 'pending')
     order by created_at
     limit ${limit}
  `;
}

/**
 * Zpracování, které se někde zaseklo (spadlá funkce uprostřed přepisu),
 * se po čase vrátí do fronty. Bez toho by hovor zůstal "zpracovává se"
 * navždy.
 */
export async function resetStalePipeline(olderThanMs = 10 * 60 * 1000): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    update calls
       set transcript_status = case when transcript_status = 'processing' then 'pending' else transcript_status end,
           analysis_status = case when analysis_status = 'processing' then 'pending' else analysis_status end,
           updated_at = now()
     where (transcript_status = 'processing' or analysis_status = 'processing')
       and updated_at < now() - ${`${Math.round(olderThanMs / 1000)} seconds`}::interval
    returning id
  `;
  return rows.length;
}

/**
 * Hovory, které se nikdy nespojily s providerem.
 *
 * Vzniknou, když prohlížeč založí hovor a pak selže připojení, nebo když
 * caller zavře záložku dřív, než Twilio zavolá TwiML endpoint. Nedorazí
 * k nim žádný webhook, takže by navždy zůstaly "vytáčím" a v historii by
 * hlásily "nahrávka se zpracovává".
 */
export async function reapAbandonedCalls(olderThanMs = 15 * 60 * 1000): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    update calls
       set status = 'failed',
           ended_at = coalesce(ended_at, now()),
           error_message = coalesce(error_message, 'Hovor se nepodařilo navázat.'),
           recording_status = case when recording_status = 'pending' then 'disabled' else recording_status end,
           transcript_status = case when transcript_status = 'pending' then 'skipped' else transcript_status end,
           analysis_status = case when analysis_status = 'pending' then 'skipped' else analysis_status end,
           updated_at = now()
     where status = 'queued'
       and provider_call_sid is null
       and started_at < now() - ${`${Math.round(olderThanMs / 1000)} seconds`}::interval
    returning id
  `;
  return rows.length;
}

export async function markTranscriptProcessing(callId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update calls set transcript_status = 'processing', updated_at = now()
     where id = ${callId} and transcript_status = 'pending'
    returning id
  `;
  return rows.length === 1;
}

export async function saveTranscript(input: {
  callId: string;
  transcript: string;
  language: string | null;
  provider: string;
}): Promise<void> {
  await sql`
    update calls
       set transcript = ${input.transcript},
           transcript_language = ${input.language},
           transcript_provider = ${input.provider},
           transcript_status = 'done',
           transcript_error = null,
           updated_at = now()
     where id = ${input.callId}
  `;
}

export async function failTranscript(callId: string, error: string): Promise<void> {
  await sql`
    update calls
       set transcript_status = 'failed', transcript_error = ${error.slice(0, 500)}, updated_at = now()
     where id = ${callId}
  `;
}

export async function markAnalysisProcessing(callId: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    update calls set analysis_status = 'processing', updated_at = now()
     where id = ${callId} and analysis_status = 'pending'
    returning id
  `;
  return rows.length === 1;
}

export async function saveAnalysis(input: {
  callId: string;
  analysis: CallAnalysis;
  provider: string;
  suggestedOutcome: string | null;
}): Promise<void> {
  await sql`
    update calls
       set analysis = ${sql.json(input.analysis)},
           analysis_provider = ${input.provider},
           analysis_status = 'done',
           analysis_error = null,
           suggested_outcome = ${input.suggestedOutcome},
           updated_at = now()
     where id = ${input.callId}
  `;
}

export async function failAnalysis(callId: string, error: string): Promise<void> {
  await sql`
    update calls
       set analysis_status = 'failed', analysis_error = ${error.slice(0, 500)}, updated_at = now()
     where id = ${callId}
  `;
}

// --------------------------------------------------------------- čtení

/** Spojí zapsaný výsledek s telefonátem, ze kterého vzešel. */
export async function linkCallActivity(callId: string, callActivityId: string): Promise<void> {
  await sql`
    update calls set call_activity_id = ${callActivityId}, updated_at = now()
     where id = ${callId} and call_activity_id is null
  `;
}

/** Poslední hovor daného kontaktu, který ještě nemá zapsaný výsledek. */
export async function getUnloggedCall(campaignContactId: string): Promise<CallRow | null> {
  const [row] = await sql<CallRow[]>`
    select * from calls
     where campaign_contact_id = ${campaignContactId}
       and call_activity_id is null
     order by started_at desc
     limit 1
  `;
  return row ?? null;
}

export async function listCallsForCompany(companyId: string, limit = 50): Promise<CallRow[]> {
  return sql<CallRow[]>`
    select * from calls where company_id = ${companyId}
     order by started_at desc limit ${limit}
  `;
}

export async function listCallsForContact(contactId: string, limit = 50): Promise<CallRow[]> {
  return sql<CallRow[]>`
    select * from calls where contact_id = ${contactId}
     order by started_at desc limit ${limit}
  `;
}

/** Provozní čísla, která jde spočítat jen z telefonátů. */
export async function getCallTelemetry(days = 7): Promise<{
  calls: number;
  connected: number;
  talk_seconds: number;
  avg_duration: number | null;
}> {
  const [row] = await sql<
    { calls: number; connected: number; talk_seconds: number; avg_duration: number | null }[]
  >`
    select count(*)::int as calls,
           count(*) filter (where answered_at is not null)::int as connected,
           coalesce(sum(duration_seconds), 0)::int as talk_seconds,
           avg(duration_seconds) filter (where answered_at is not null)::float8 as avg_duration
      from calls
     where started_at >= now() - ${`${days} days`}::interval
  `;
  return row;
}

export async function logCallStarted(input: {
  callId: string;
  contactId: string;
  destination: string;
}): Promise<void> {
  await logActivity({
    action: "Hovor zahájen",
    detail: input.destination,
    contactId: input.contactId,
  });
}
