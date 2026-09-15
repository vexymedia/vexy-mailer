import { sql } from "../db";
import { logActivity } from "../activity";
import {
  applyCallOutcome,
  callOutcome,
  callRates,
  computeEconomics,
  buildFunnel,
  type CallCounts,
  type CallOutcome,
  type CallRates,
  type CallStatus,
  type Economics,
  type FunnelStage,
  type MeetingOutcome,
} from "../calling";
import { isCompanyStatus, nextCompanyStatus } from "../companies";
import { getCallMetrics, getMetricsByCaller } from "./reporting";
import type { Campaign } from "../types";

/**
 * Everything the calling half of a campaign reads and writes.
 *
 * Nothing in this file touches campaign_contacts.status, current_step,
 * next_send_at, sender_mailbox_id or thread_message_id. Those belong to the
 * e-mail engine, and a call must never be able to move an e-mail sequence.
 */

// ------------------------------------------------------------------ queue

export interface CallQueueRow {
  id: string;
  contact_id: string;
  email: string;
  phone: string | null;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  company: string | null;
  website: string | null;
  call_status: CallStatus;
  call_attempts: number;
  last_call_at: Date | null;
  next_call_at: Date | null;
  last_call_outcome: CallOutcome | null;
  call_note: string | null;
  assigned_caller_id: string | null;
  assigned_caller_name: string | null;
  created_at: Date;
  company_id: string | null;
  campaign_id: string;
  campaign_name: string;
}

/**
 * The calling queue, in dialling order:
 *   1. callbacks that are due now
 *   2. prospects already started but still under the attempt limit
 *   3. contacts nobody has called yet
 *
 * Everything closed (meeting, client, lost, do-not-call, attempts spent) is
 * excluded outright, as are prospects with no phone number - a caller cannot
 * do anything with those and they would just have to be skipped by hand.
 *
 * Mirrors orderCallQueue() in lib/calling.ts, which is where the ordering is
 * unit-tested.
 */
/**
 * Pracovní režim bloku v plánu: "první oslovení" jsou firmy, které jsme
 * ještě nevolali, "follow-up" ty, kde už nějaký pokus byl. Bez tohohle
 * rozdělení by tlačítko Začít u follow-up bloku otevřelo úplně jinou práci,
 * než na jakou si člověk vyhradil čas.
 */
export type QueueMode = "first" | "followup";

export async function listCallQueue(
  campaignId: string | null,
  options: {
    limit?: number;
    callerId?: string | null;
    mode?: QueueMode | null;
    /**
     * Omezit frontu na kampaně přidělené callerovi?
     *
     * Zapíná se pro roli caller. Administrátor volá s false, protože smí
     * volat komukoliv - ale pak si obchodní identitu vybírá vědomě.
     */
    scopedToAssignments?: boolean;
  } = {},
): Promise<CallQueueRow[]> {
  const callerId = options.callerId ?? null;
  const mode = options.mode ?? null;
  const scoped = options.scopedToAssignments ?? false;
  return sql<CallQueueRow[]>`
    select cc.id, cc.contact_id, c.email, c.phone, c.first_name, c.last_name,
           c.position, c.company, c.website, cc.call_status, cc.call_attempts, cc.last_call_at,
           cc.next_call_at, cc.last_call_outcome, cc.call_note, cc.assigned_caller_id,
           ca.name as assigned_caller_name, cc.created_at,
           c.company_id, cp.id as campaign_id, cp.name as campaign_name
      from campaign_contacts cc
      join campaigns cp on cp.id = cc.campaign_id
      join contacts c on c.id = cc.contact_id
      left join callers ca on ca.id = cc.assigned_caller_id
     -- null = napříč kampaněmi. Denní fronta se neptá, ze které kampaně
     -- firma pochází; caller potřebuje vědět, komu volat, ne pod co to spadá.
     where (${campaignId}::uuid is null or cc.campaign_id = ${campaignId}::uuid)
       and cp.calling_enabled
       and cc.call_status in ('new', 'in_progress', 'callback')
       and cc.call_attempts < cp.max_call_attempts
       and c.phone is not null and btrim(c.phone) <> ''
       -- Do-not-call is global. Somebody who asked not to be phoned is out of
       -- every campaign's queue, not just the one they said it on.
       and not exists (select 1 from call_suppression cs where cs.contact_id = cc.contact_id)
       -- A caller sees their own assignments plus everything unassigned;
       -- never someone else's named prospect.
       and (${callerId}::uuid is null or cc.assigned_caller_id is null
            or cc.assigned_caller_id = ${callerId}::uuid)
       -- ...nor anyone another caller is on the phone to right now.
       and (${callerId}::uuid is null or cc.call_locked_until is null
            or cc.call_locked_until < now() or cc.call_locked_by = ${callerId}::uuid)
       -- Naplánováno na později = dnes to není práce. Od zavedení kadence
       -- má datum dalšího kroku každý otevřený kontakt, ne jen callback.
       and (cc.next_call_at is null or cc.next_call_at <= now())
       -- Vyloučená firma je rozhodnutí o firmě jako takové ("tyhle nikdy"),
       -- takže platí napříč klienty.
       and not exists (select 1 from companies qco where qco.id = c.company_id
                        and qco.status = 'excluded')
       -- Firma vyloučená pro KLIENTA téhle kampaně. Užší než status
       -- 'excluded' výš: "Acme je už klientem ASN Plus" nesmí Acme
       -- schovat vlastnímu outboundu VEXY.
       and not exists (
         select 1 from client_company_exclusions x
          where x.company_id = c.company_id
            and x.client_id = cp.client_id
       )
       -- "Získaný klient" a "nemá zájem" jsou naopak výsledky konkrétního
       -- obchodu. Zavírají firmu jen v té kampani, kde padly - jinak by
       -- "nemá zájem" u ASN Plus utnulo tutéž firmu i ve vlastním outboundu
       -- VEXY, kde jí nabízíme něco úplně jiného.
       and not exists (
         select 1 from campaign_contacts closed
           join contacts cc2 on cc2.id = closed.contact_id
          where cc2.company_id = c.company_id
            and closed.campaign_id = cc.campaign_id
            and closed.call_status in ('won', 'lost')
       )
       -- Ani kontakt, kterému se už volalo, jen se nestihl zapsat výsledek.
       -- Jinak by ho fronta nabídla znovu a vytočil by se podruhé.
       and not exists (select 1 from calls uc
                        where uc.campaign_contact_id = cc.id
                          and uc.call_activity_id is null
                          and uc.provider_call_sid is not null
                          and uc.status in ('completed', 'no_answer', 'busy')
                          and uc.started_at > now() - interval '12 hours')
       and (${mode}::text is null
            or (${mode} = 'first' and cc.call_attempts = 0)
            or (${mode} = 'followup' and cc.call_attempts > 0))
       -- Oddělení klientů. Caller dostane práci výhradně z kampaní, které
       -- mu někdo přidělil; bez přidělení nedostane nic. Fail-closed je
       -- tu záměr - opačná chyba znamená cizího klienta ve frontě.
       and (${scoped} = false
            or exists (select 1 from caller_campaigns ca
                        where ca.caller_id = ${callerId}::uuid
                          and ca.campaign_id = cc.campaign_id))
     order by
       case cc.call_status when 'callback' then 0 when 'in_progress' then 1 else 2 end,
       cc.call_attempts,
       cc.next_call_at nulls last,
       cc.created_at,
       -- The unique tiebreak. Without it a batch added by one
       -- INSERT ... SELECT shares a created_at and their order is undefined,
       -- so two reads of the same queue could hand out different prospects.
       cc.id
     limit ${options.limit ?? 50}
  `;
}

export interface CallScript {
  opening: string | null;
  value: string | null;
  objections: string | null;
  closing: string | null;
  qualification: string | null;
}

export interface NextCall {
  prospect: CallQueueRow;
  campaign: { id: string; name: string; max_call_attempts: number };
  script: CallScript;
  remaining: number;
}

/**
 * The single next prospect to dial, plus the script. One query result drives
 * the whole caller screen so the workspace is CALL -> LOG -> next with nothing
 * in between.
 */
/**
 * How long a prospect is held for the caller who was handed them. Long enough
 * for a call and writing the outcome, short enough that a closed tab frees
 * them again without anyone having to intervene.
 */
const CALL_LEASE_MINUTES = 5;

/**
 * Atomically hands the head of the queue to one caller.
 *
 * Same mechanism the send worker already uses: pick a row with FOR UPDATE
 * SKIP LOCKED and stamp an expiring lease on it, so two callers working the
 * same campaign cannot both be given the same person to dial. Re-claiming is
 * idempotent for the caller who already holds the lease - it just extends it -
 * so a re-render hands back the same prospect rather than skipping to the next.
 */
export async function claimNextCall(
  campaignId: string | null,
  callerId: string,
  mode: QueueMode | null = null,
  scopedToAssignments = false,
): Promise<string | null> {
  const scoped = scopedToAssignments;
  const [row] = await sql<{ id: string }[]>`
    update campaign_contacts cc
       set call_locked_by = ${callerId}, call_locked_until = now() + interval '${sql.unsafe(String(CALL_LEASE_MINUTES))} minutes'
     where cc.id = (
       select inner_cc.id
         from campaign_contacts inner_cc
         join campaigns cp on cp.id = inner_cc.campaign_id
         join contacts c on c.id = inner_cc.contact_id
        where (${campaignId}::uuid is null or inner_cc.campaign_id = ${campaignId}::uuid)
          and cp.calling_enabled
          and inner_cc.call_status in ('new', 'in_progress', 'callback')
          and inner_cc.call_attempts < cp.max_call_attempts
          and c.phone is not null and btrim(c.phone) <> ''
          and not exists (select 1 from call_suppression cs where cs.contact_id = inner_cc.contact_id)
          and (inner_cc.assigned_caller_id is null or inner_cc.assigned_caller_id = ${callerId})
          and (inner_cc.call_locked_until is null or inner_cc.call_locked_until < now()
               or inner_cc.call_locked_by = ${callerId})
          and (inner_cc.next_call_at is null or inner_cc.next_call_at <= now())
          -- Viz listCallQueue: vyloučení platí globálně, obchodní výsledek
          -- jen v rámci své kampaně.
          and not exists (select 1 from companies qco where qco.id = c.company_id
                           and qco.status = 'excluded')
          -- A totéž pro klientské vyloučení - viz listCallQueue.
          and not exists (
            select 1 from client_company_exclusions x
             where x.company_id = c.company_id
               and x.client_id = (select client_id from campaigns
                                   where id = inner_cc.campaign_id)
          )
          and not exists (
            select 1 from campaign_contacts closed
              join contacts cc2 on cc2.id = closed.contact_id
             where cc2.company_id = c.company_id
               and closed.campaign_id = inner_cc.campaign_id
               and closed.call_status in ('won', 'lost')
          )
          and not exists (select 1 from calls uc
                           where uc.campaign_contact_id = inner_cc.id
                             and uc.call_activity_id is null
                             and uc.provider_call_sid is not null
                             and uc.status in ('completed', 'no_answer', 'busy')
                             and uc.started_at > now() - interval '12 hours')
          and (${mode}::text is null
               or (${mode} = 'first' and inner_cc.call_attempts = 0)
               or (${mode} = 'followup' and inner_cc.call_attempts > 0))
          -- Stejné omezení jako ve frontě. Musí být i tady: rezervace je
          -- vlastní dotaz a bez tohohle by caller dostal cizí kontakt,
          -- i když by ho ve frontě nikdy neviděl.
          and (${scoped} = false
               or exists (select 1 from caller_campaigns ca
                           where ca.caller_id = ${callerId}
                             and ca.campaign_id = inner_cc.campaign_id))
        order by
          case inner_cc.call_status when 'callback' then 0 when 'in_progress' then 1 else 2 end,
          inner_cc.call_attempts,
          inner_cc.next_call_at nulls last,
          inner_cc.created_at,
          inner_cc.id
        limit 1
        for update of inner_cc skip locked
     )
    returning cc.id
  `;
  return row?.id ?? null;
}

/** Frees a leased prospect, so closing the workspace does not park them. */
export async function releaseCall(campaignContactId: string): Promise<void> {
  await sql`
    update campaign_contacts
       set call_locked_until = null, call_locked_by = null
     where id = ${campaignContactId}
  `;
}

/**
 * The campaign's own details and the script, for whichever prospect is being
 * shown. Split out because both the read-only peek and the held-prospect view
 * need it and neither may mutate anything to get it.
 */
async function callContext(
  campaignId: string,
): Promise<Pick<NextCall, "campaign" | "script"> | null> {
  const [campaign] = await sql<
    {
      id: string;
      name: string;
      max_call_attempts: number;
      script_opening: string | null;
      script_value: string | null;
      script_objections: string | null;
      script_closing: string | null;
      qualification_criteria: string | null;
    }[]
  >`
    select id, name, max_call_attempts, script_opening, script_value,
           script_objections, script_closing, qualification_criteria
      from campaigns where id = ${campaignId}
  `;
  if (!campaign) return null;

  return {
    campaign: { id: campaign.id, name: campaign.name, max_call_attempts: campaign.max_call_attempts },
    script: {
      opening: campaign.script_opening,
      value: campaign.script_value,
      objections: campaign.script_objections,
      closing: campaign.script_closing,
      qualification: campaign.qualification_criteria,
    },
  };
}

/**
 * Read-only peek at the head of the queue. Leases nothing.
 *
 * Rendering a page must never reserve a prospect: a Next.js prefetch, a double
 * render or a stray refresh would take somebody out of every other caller's
 * queue for five minutes without a human ever seeing them. Reserving is
 * claimNextCall(), and only an explicit action calls it.
 */
export async function getNextCall(
  campaignId: string | null,
  callerId?: string | null,
): Promise<NextCall | null> {
  const queue = await listCallQueue(campaignId, { limit: 50, callerId });
  if (queue.length === 0) return null;
  // Kontext se bere z kampaně, do které prospekt patří - napříč kampaněmi
  // by jedno zvolené id ukázalo cizí skript i cizí kritéria.
  const context = await callContext(queue[0].campaign_id);
  if (!context) return null;
  return { ...context, prospect: queue[0], remaining: queue.length };
}

/**
 * The prospect this caller is currently holding, if any.
 *
 * This is what the workspace renders, so a refresh shows the same person and
 * costs nothing: the lease already exists and is not touched, extended or
 * replaced by looking at it.
 */
export async function getHeldCall(
  campaignId: string | null,
  callerId: string,
  scopedToAssignments = false,
): Promise<NextCall | null> {
  const scoped = scopedToAssignments;
  const [prospect] = await sql<CallQueueRow[]>`
    select cc.id, cc.contact_id, c.email, c.phone, c.first_name, c.last_name,
           c.position, c.company, c.website, cc.call_status, cc.call_attempts, cc.last_call_at,
           cc.next_call_at, cc.last_call_outcome, cc.call_note, cc.assigned_caller_id,
           ca.name as assigned_caller_name, cc.created_at,
           c.company_id, cp.id as campaign_id, cp.name as campaign_name
      from campaign_contacts cc
      join campaigns cp on cp.id = cc.campaign_id
      join contacts c on c.id = cc.contact_id
      left join callers ca on ca.id = cc.assigned_caller_id
     where (${campaignId}::uuid is null or cc.campaign_id = ${campaignId}::uuid)
       and cc.call_locked_by = ${callerId}
       and cc.call_locked_until > now()
       -- Rezervace vznikla už omezená, ale přidělení se dá mezitím odebrat.
       -- Pak drženou firmu ukazovat nesmíme.
       and (${scoped} = false
            or exists (select 1 from caller_campaigns ca
                        where ca.caller_id = ${callerId} and ca.campaign_id = cc.campaign_id))
       -- A lease is not a reason to show somebody who has since been decided,
       -- run out of attempts or landed on the do-not-call list.
       and cc.call_status in ('new', 'in_progress', 'callback')
       and cc.call_attempts < cp.max_call_attempts
       and not exists (select 1 from call_suppression cs where cs.contact_id = cc.contact_id)
       -- ...ani firmu, kterou mezitím někdo uzavřel.
       and not exists (select 1 from companies qco where qco.id = c.company_id
                        and qco.status in ('won', 'lost', 'excluded'))
       -- ...ani kontakt, kterému se právě volalo a chybí u toho výsledek.
       -- Rezervace přežije zavřený notebook o pár minut, takže bez téhle
       -- podmínky by se po návratu nabídl k vytočení podruhé.
       and not exists (select 1 from calls uc
                        where uc.campaign_contact_id = cc.id
                          and uc.call_activity_id is null
                          and uc.provider_call_sid is not null
                          and uc.status in ('completed', 'no_answer', 'busy')
                          and uc.started_at > now() - interval '12 hours')
     limit 1
  `;
  if (!prospect) return null;
  const context = await callContext(prospect.campaign_id);
  if (!context) return null;

  const queue = await listCallQueue(campaignId, { limit: 50, callerId });
  return { ...context, prospect, remaining: Math.max(queue.length, 1) };
}

/**
 * Kolik firem už caller dnes zpracoval.
 *
 * Počítá se z call_activities, protože to jsou skutečné pokusy o volání -
 * ne "nějaká aktivita". Bez tohohle čísla pracovní režim neumí říct
 * "23 / 76" a člověk netuší, jestli je hotový.
 */
export async function getCallerDayProgress(
  callerId: string,
  campaignId: string | null = null,
  mode: QueueMode | null = null,
  scopedToAssignments = false,
): Promise<{
  processed: number;
  remaining: number;
  total: number;
  attempts: number;
  connected: number;
  meetings: number;
}> {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  // "Zpracováno" je počet firem, které dnes caller odbavil - tedy zapsané
  // výsledky. "Pokusy/spojené/schůzky" jsou provozní čísla a musí souhlasit
  // s Přehledem i s Týmem, takže je počítá reporting service. Dřív tu byl
  // vlastní dotaz nad call_activities, který ad-hoc hovory (bez kampaně)
  // slil do jednoho a skutečné hovory bez výsledku neviděl vůbec.
  const [row] = await sql<{ processed: number }[]>`
    select count(*)::int as processed
      from call_activities ca
     where ca.caller_id = ${callerId}
       and ca.called_at >= ${dayStart}
       and (${campaignId}::uuid is null or ca.campaign_id = ${campaignId}::uuid)
  `;
  const [metrics, queue] = await Promise.all([
    getCallMetrics({ from: dayStart, callerId }),
    listCallQueue(campaignId, { limit: 500, callerId, mode, scopedToAssignments }),
  ]);
  const processed = row?.processed ?? 0;
  return {
    processed,
    remaining: queue.length,
    total: processed + queue.length,
    attempts: metrics.attempts,
    connected: metrics.connected,
    meetings: metrics.meetings,
  };
}

// -------------------------------------------------------------- logging

export interface LogCallInput {
  /** Kontakt v kampani. U ad-hoc hovoru chybí a použije se contactId. */
  campaignContactId?: string | null;
  /** Kontakt mimo kampaň. Calling produkt musí umět zapsat každý hovor. */
  contactId?: string | null;
  outcome: CallOutcome;
  callerId?: string | null;
  note?: string | null;
  callbackAt?: Date | null;
  meetingAt?: Date | null;
  meetingQualified?: boolean | null;
  dealValue?: number | null;
  /**
   * Telefonát, ze kterého výsledek vzešel. Nepovinné: výsledek se dá
   * zapsat i k hovoru z mobilu, který VEXY nikdy neviděla.
   */
  callId?: string | null;
}

export interface LogCallResult {
  ok: boolean;
  error?: string;
  campaignId?: string;
  attempts?: number;
  status?: CallStatus;
}

/**
 * Records one dialling attempt.
 *
 * The activity row and the aggregate columns are written in one transaction,
 * so the attempt counter can never drift from the timeline it is a cache of.
 * The prospect row is locked first, which is what makes the counter correct
 * when two callers happen to submit the same prospect at once.
 */
/**
 * Kolik pokusů má ad-hoc kontakt za sebou.
 *
 * Mimo kampaň není kam počítadlo ukládat, tak se počítá ze skutečných
 * zápisů hovorů - což je stejně poctivější zdroj než denormalizovaný
 * čítač.
 */
const AD_HOC_MAX_ATTEMPTS = 4;

/**
 * Zápis výsledku hovoru u kontaktu, který není v žádné kampani.
 *
 * Dělá přesně tolik, kolik bez kampaně dává smysl: zapíše aktivitu
 * s dalším krokem, posune stav firmy a případně doplní do-not-call.
 * Nedotýká se campaign_contacts, takže NEMŮŽE rozhýbat e-mailovou
 * sekvenci - ta se řídí výhradně sloupci v té tabulce.
 */
async function logAdHocCall(
  input: LogCallInput & { contactId: string },
): Promise<LogCallResult> {
  const definition = callOutcome(input.outcome);
  const callerId = input.callerId ?? null;
  const note = input.note?.trim() || null;

  type AdHocResult = { email: string; attempts: number } | null;
  const result: AdHocResult = await sql.begin(async (tx): Promise<AdHocResult> => {
    const [contact] = await tx<
      { id: string; email: string; company_id: string | null; company_status: string | null }[]
    >`
      select c.id, c.email, c.company_id, co.status as company_status
        from contacts c
        left join companies co on co.id = c.company_id
       where c.id = ${input.contactId}
         for update of c
    `;
    if (!contact) return null;

    const [{ count: attemptsBefore }] = await tx<{ count: number }[]>`
      select count(*)::int as count from call_activities where contact_id = ${contact.id}
    `;

    const applied = applyCallOutcome({
      outcome: input.outcome,
      attemptsBefore,
      maxAttempts: AD_HOC_MAX_ATTEMPTS,
      callbackAt: input.callbackAt ?? null,
      meetingAt: input.meetingAt ?? null,
      meetingQualified: input.meetingQualified ?? null,
    });

    const [activity] = await tx<{ id: string }[]>`
      insert into call_activities (campaign_id, campaign_contact_id, contact_id, caller_id,
                                   outcome, connected, note, attempt_number,
                                   next_action_at, meeting_at, meeting_qualified, deal_value)
      values (null, null, ${contact.id}, ${callerId},
              ${input.outcome}, ${applied.connected}, ${note}, ${applied.attempts},
              ${applied.nextCallAt}, ${applied.meetingAt}, ${applied.meetingQualified},
              ${input.dealValue ?? null})
      returning id
    `;

    if (input.callId) {
      await tx`
        update calls set call_activity_id = ${activity.id}, updated_at = now()
         where id = ${input.callId} and call_activity_id is null
      `;
    }

    if (contact.company_id && contact.company_status) {
      const merged = nextCompanyStatus(
        isCompanyStatus(contact.company_status) ? contact.company_status : "new",
        applied.companyStatus,
      );
      if (merged !== contact.company_status) {
        await tx`
          update companies set status = ${merged}, updated_at = now() where id = ${contact.company_id}
        `;
      }
    }

    if (applied.status === "do_not_call") {
      await tx`
        insert into call_suppression (contact_id, reason)
        values (${contact.id}, 'do_not_call')
        on conflict (contact_id) do nothing
      `;
    }

    return { email: contact.email, attempts: applied.attempts };
  });

  if (!result) return { ok: false, error: "Kontakt nebyl nalezen." };

  await logActivity({
    action: "Hovor zaznamenán",
    detail: `${result.email}: ${definition.label} (pokus ${result.attempts})`,
    contactId: input.contactId,
  });
  return { ok: true };
}

export async function logCall(input: LogCallInput): Promise<LogCallResult> {
  const definition = callOutcome(input.outcome);

  if (definition.requires === "callback_at" && !input.callbackAt) {
    return { ok: false, error: "Zvolte datum a čas dalšího hovoru." };
  }
  if (definition.requires === "meeting_at" && !input.meetingAt) {
    return { ok: false, error: "Zvolte datum a čas schůzky." };
  }

  // Hovor mimo kampaň se zapisuje stejným voláním, jen jinou cestou.
  if (!input.campaignContactId) {
    if (!input.contactId) return { ok: false, error: "Chybí kontakt." };
    return logAdHocCall({ ...input, contactId: input.contactId });
  }

  const outcomeValue = input.outcome;
  const callerId = input.callerId ?? null;
  const note = input.note?.trim() || null;

  const result = await sql.begin(async (tx) => {
    const [row] = await tx<
      {
        id: string;
        campaign_id: string;
        contact_id: string;
        call_attempts: number;
        max_call_attempts: number;
        email: string;
        company_id: string | null;
        company_status: string | null;
      }[]
    >`
      select cc.id, cc.campaign_id, cc.contact_id, cc.call_attempts,
             cp.max_call_attempts, c.email, c.company_id, co.status as company_status
        from campaign_contacts cc
        join campaigns cp on cp.id = cc.campaign_id
        join contacts c on c.id = cc.contact_id
        left join companies co on co.id = c.company_id
       where cc.id = ${input.campaignContactId ?? null}
         for update of cc
    `;
    if (!row) return null;

    // The queue already excludes a prospect at the limit, but the limit has to
    // hold here too: this is the only writer of call_attempts, and anything
    // that reaches it directly - a stale tab, a double submit, a script -
    // would otherwise push a "max 4 attempts" campaign to five.
    if (row.call_attempts >= row.max_call_attempts) {
      return { exhausted: true as const, maxAttempts: row.max_call_attempts };
    }

    const applied = applyCallOutcome({
      outcome: outcomeValue,
      attemptsBefore: row.call_attempts,
      maxAttempts: row.max_call_attempts,
      callbackAt: input.callbackAt ?? null,
      meetingAt: input.meetingAt ?? null,
      meetingQualified: input.meetingQualified ?? null,
    });

    const [activity] = await tx<{ id: string }[]>`
      insert into call_activities (campaign_id, campaign_contact_id, contact_id, caller_id,
                                   outcome, connected, note, attempt_number,
                                   next_action_at, meeting_at, meeting_qualified, deal_value)
      values (${row.campaign_id}, ${row.id}, ${row.contact_id}, ${callerId},
              ${outcomeValue}, ${applied.connected}, ${note}, ${applied.attempts},
              ${applied.nextCallAt}, ${applied.meetingAt}, ${applied.meetingQualified},
              ${input.dealValue ?? null})
      returning id
    `;

    await tx`
      update campaign_contacts
         set call_status        = ${applied.status},
             call_attempts      = ${applied.attempts},
             last_call_at       = now(),
             last_call_outcome  = ${outcomeValue},
             next_call_at       = ${applied.nextCallAt},
             call_note          = coalesce(${note}, call_note),
             assigned_caller_id = coalesce(${callerId}::uuid, assigned_caller_id),
             -- A booked meeting is never un-booked by a later call; only the
             -- date and the qualification judgement are refreshed.
             meeting_booked     = meeting_booked or ${applied.meetingBooked},
             meeting_at         = coalesce(${applied.meetingAt}, meeting_at),
             meeting_qualified  = coalesce(${applied.meetingQualified}, meeting_qualified),
             deal_value         = coalesce(${input.dealValue ?? null}, deal_value),
             updated_at         = now()
       where id = ${row.id}
    `;

    // Výsledek hovoru je to jediné, co firmu posouvá procesem. Bez tohohle
    // zápisu by firma zůstala "Nová" i po deseti hovorech a seznam firem by
    // lhal. nextCompanyStatus hlídá, aby ji slabší signál neposunul zpátky.
    if (row.company_id && row.company_status) {
      const merged = nextCompanyStatus(
        isCompanyStatus(row.company_status) ? row.company_status : "new",
        applied.companyStatus,
      );
      if (merged !== row.company_status) {
        await tx`
          update companies set status = ${merged}, updated_at = now() where id = ${row.company_id}
        `;
      }
    }

    // Telefonát a jeho výsledek patří k sobě. Váže se až tady, uvnitř
    // transakce: kdyby se zápis výsledku nepovedl, nesmí u hovoru zůstat
    // odkaz na aktivitu, která nevznikla.
    if (input.callId) {
      await tx`
        update calls set call_activity_id = ${activity.id}, updated_at = now()
         where id = ${input.callId} and call_activity_id is null
      `;
    }

    // "Nevolat" is a decision about the person, not about this campaign, so it
    // goes on the global list the queue checks. Deliberately not the e-mail
    // suppression list: phone and e-mail are separate consents.
    if (applied.status === "do_not_call") {
      await tx`
        insert into call_suppression (contact_id, reason)
        values (${row.contact_id}, 'do_not_call')
        on conflict (contact_id) do nothing
      `;
    }

    // The call is over, so the prospect is no longer held for this caller.
    await tx`
      update campaign_contacts set call_locked_until = null, call_locked_by = null
       where id = ${row.id}
    `;

    return {
      campaignId: row.campaign_id,
      contactId: row.contact_id,
      email: row.email,
      attempts: applied.attempts,
      status: applied.status,
    };
  });

  if (!result) return { ok: false, error: "Kontakt nebyl nalezen." };
  if ("exhausted" in result) {
    return {
      ok: false,
      error: `Kontakt už vyčerpal všechny pokusy (${result.maxAttempts}). Další hovor se nezapíše.`,
    };
  }

  await logActivity({
    action: "Hovor zaznamenán",
    detail: `${result.email}: ${definition.label} (pokus ${result.attempts})`,
    campaignId: result.campaignId,
    contactId: result.contactId,
    campaignContactId: input.campaignContactId,
  });

  return { ok: true, campaignId: result.campaignId, attempts: result.attempts, status: result.status };
}

/**
 * Updates a booked meeting after the fact: did it happen, and did it meet the
 * campaign's qualification criteria. Kept separate from logCall because it is
 * not a dialling attempt and must never touch the attempt counter.
 */
export async function updateMeeting(
  campaignContactId: string,
  patch: { outcome?: MeetingOutcome; qualified?: boolean | null; meetingAt?: Date | null },
): Promise<{ ok: boolean; campaignId?: string }> {
  const [row] = await sql<{ campaign_id: string; meeting_booked: boolean }[]>`
    select campaign_id, meeting_booked from campaign_contacts where id = ${campaignContactId}
  `;
  if (!row) return { ok: false };
  if (!row.meeting_booked) return { ok: false };

  await sql`
    update campaign_contacts
       set meeting_outcome   = coalesce(${patch.outcome ?? null}, meeting_outcome),
           meeting_qualified = ${patch.qualified === undefined ? sql`meeting_qualified` : patch.qualified},
           meeting_at        = coalesce(${patch.meetingAt ?? null}, meeting_at),
           updated_at        = now()
     where id = ${campaignContactId}
  `;
  return { ok: true, campaignId: row.campaign_id };
}

/**
 * Ruční naplánování dalšího kroku.
 *
 * Existuje kvůli jedinému případu: aktivní firma, která zůstala bez dalšího
 * kroku (typicky "špatný kontakt" na jediném člověku, nebo import bez
 * kampaně). UI to hlásí jako problém a tohle je ta nabízená oprava.
 * Není to zápis hovoru, takže se nesmí dotknout počtu pokusů.
 */
export async function scheduleNextStep(
  campaignContactId: string,
  at: Date,
): Promise<{ ok: boolean; error?: string; companyId?: string | null }> {
  const [row] = await sql<{ id: string; contact_id: string; campaign_id: string; email: string }[]>`
    update campaign_contacts cc
       set next_call_at = ${at},
           call_status  = case when cc.call_status = 'new' then 'new' else cc.call_status end,
           updated_at   = now()
      from contacts c
     where cc.id = ${campaignContactId}
       and c.id = cc.contact_id
       and cc.call_status in ('new', 'in_progress', 'callback')
    returning cc.id, cc.contact_id, cc.campaign_id, c.email
  `;
  if (!row) return { ok: false, error: "Tento kontakt už je uzavřený, další krok mu nelze naplánovat." };

  await logActivity({
    action: "Follow-up naplánován",
    detail: `${row.email}: ${at.toISOString()}`,
    campaignId: row.campaign_id,
    contactId: row.contact_id,
    campaignContactId: row.id,
  });
  const [company] = await sql<{ company_id: string | null }[]>`
    select company_id from contacts where id = ${row.contact_id}
  `;
  return { ok: true, companyId: company?.company_id ?? null };
}

export interface CompanyNextStep {
  kind: "call" | "meeting";
  at: Date;
  contactName: string;
  campaignContactId: string;
}

/**
 * Konkrétní další krok firmy: co, kdy a s kým. "Další krok — 16. 9." je
 * k ničemu, když člověk neví, jestli má volat, nebo jde na schůzku.
 */
export async function getCompanyNextStep(companyId: string): Promise<CompanyNextStep | null> {
  const [row] = await sql<CompanyNextStep[]>`
    select t.kind, t.at, t.contact_name as "contactName", t.id as "campaignContactId"
      from (
        select 'call'::text as kind, cc.next_call_at as at, cc.id,
               coalesce(nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
                        c.email) as contact_name
          from campaign_contacts cc join contacts c on c.id = cc.contact_id
         where c.company_id = ${companyId}
           and cc.call_status in ('new', 'in_progress', 'callback')
           and cc.next_call_at is not null
        union all
        select 'meeting', cc.meeting_at, cc.id,
               coalesce(nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
                        c.email)
          from campaign_contacts cc join contacts c on c.id = cc.contact_id
         where c.company_id = ${companyId} and cc.meeting_booked
           and cc.meeting_at is not null and cc.meeting_outcome = 'scheduled'
      ) t
     order by t.at
     limit 1
  `;
  return row ?? null;
}

// ------------------------------------------------------------------ counts

/**
 * Every calling counter for one campaign, in a single round trip.
 *
 * "Connected calls" counts ATTEMPTS that reached a human - that is the billable
 * unit and the one economics divides by. "Connected contacts" counts distinct
 * prospects, which is what the funnel needs so a prospect called three times
 * cannot convert more than once.
 */
export async function getCallCounts(campaignId: string): Promise<CallCounts> {
  const [row] = await sql<CallCounts[]>`
    select
      (select count(*)::int from campaign_contacts where campaign_id = ${campaignId}) as contacts,
      (select count(*)::int from campaign_contacts
        where campaign_id = ${campaignId} and call_attempts > 0) as called,
      (select count(distinct campaign_contact_id)::int from call_activities
        where campaign_id = ${campaignId} and connected) as connected_contacts,
      (select count(*)::int from call_activities
        where campaign_id = ${campaignId} and connected) as connected_calls,
      (select count(*)::int from campaign_contacts
        where campaign_id = ${campaignId} and meeting_booked) as meetings_booked,
      (select count(*)::int from campaign_contacts
        where campaign_id = ${campaignId} and meeting_booked and meeting_qualified is true)
        as meetings_qualified,
      (select count(*)::int from campaign_contacts
        where campaign_id = ${campaignId} and meeting_held) as meetings_held,
      (select count(*)::int from campaign_contacts
        where campaign_id = ${campaignId} and meeting_outcome = 'no_show') as meetings_no_show,
      (select count(*)::int from campaign_contacts
        where campaign_id = ${campaignId} and call_status = 'won') as clients_won
  `;
  return row;
}

export interface CampaignCallingReport {
  counts: CallCounts;
  funnel: FunnelStage[];
  economics: Economics;
  /** Meetings booked but not yet judged against the criteria. */
  meetings_unjudged: number;
  callbacks_due: number;
  queue_size: number;
  /**
   * Open on the calling side but impossible to call: no phone number. They are
   * not in the queue and never will be, so without this they are simply
   * invisible - an active contact with no next action.
   */
  stranded: number;
  /** Contacts on the global do-not-call list. */
  do_not_call: number;
  /** Skutečné pokusy o volání - jmenovatel dovolatelnosti. */
  attempts: number;
  rates: CallRates;
}

/** The calling dashboard for one campaign: counters, funnel and money. */
export async function getCampaignCallingReport(campaignId: string): Promise<CampaignCallingReport> {
  const [campaign] = await sql<Campaign[]>`select * from campaigns where id = ${campaignId}`;

  const [counts, [extra]] = await Promise.all([
    getCallCounts(campaignId),
    sql<
      {
        revenue_won: number;
        meetings_unjudged: number;
        callbacks_due: number;
        queue_size: number;
        stranded: number;
        do_not_call: number;
        attempts: number;
      }[]
    >`
      select
        coalesce((select sum(deal_value) from campaign_contacts
                   where campaign_id = ${campaignId} and call_status = 'won'), 0)::float8
          as revenue_won,
        (select count(*)::int from campaign_contacts
          where campaign_id = ${campaignId} and meeting_booked and meeting_qualified is null)
          as meetings_unjudged,
        (select count(*)::int from campaign_contacts
          where campaign_id = ${campaignId} and call_status = 'callback'
            and next_call_at is not null and next_call_at <= now()) as callbacks_due,
        (select count(*)::int
           from campaign_contacts cc
           join contacts c on c.id = cc.contact_id
          where cc.campaign_id = ${campaignId}
            and cc.call_status in ('new', 'in_progress', 'callback')
            and cc.call_attempts < ${campaign.max_call_attempts}
            and c.phone is not null and btrim(c.phone) <> ''
            and not exists (select 1 from call_suppression cs where cs.contact_id = cc.contact_id)
            and (cc.next_call_at is null or cc.next_call_at <= now())
            and not exists (select 1 from companies qco where qco.id = c.company_id
                             and qco.status in ('won', 'lost', 'excluded'))) as queue_size,
        (select count(*)::int
           from campaign_contacts cc
           join contacts c on c.id = cc.contact_id
          where cc.campaign_id = ${campaignId}
            and cc.call_status in ('new', 'in_progress', 'callback')
            and (c.phone is null or btrim(c.phone) = '')) as stranded,
        (select count(*)::int
           from campaign_contacts cc
           join call_suppression cs on cs.contact_id = cc.contact_id
          where cc.campaign_id = ${campaignId}) as do_not_call,
        (select count(*)::int from call_activities
          where campaign_id = ${campaignId}) as attempts
    `,
  ]);

  return {
    counts,
    funnel: buildFunnel(counts),
    economics: computeEconomics({
      revenue_model: campaign.revenue_model,
      revenue_amount: campaign.revenue_amount,
      caller_cost_model: campaign.caller_cost_model,
      caller_cost_amount: campaign.caller_cost_amount,
      caller_hours: campaign.caller_hours,
      additional_costs: campaign.additional_costs,
      counts,
      revenue_won: extra.revenue_won,
    }),
    meetings_unjudged: extra.meetings_unjudged,
    callbacks_due: extra.callbacks_due,
    queue_size: extra.queue_size,
    stranded: extra.stranded,
    do_not_call: extra.do_not_call,
    attempts: extra.attempts,
    rates: callRates({
      attempts: extra.attempts,
      connected: counts.connected_calls,
      meetings: counts.meetings_booked,
    }),
  };
}

// ------------------------------------------------------- contact listings

/** Which slice of the campaign a KPI tile drills into. */
export type CallFilter =
  | "all"
  | "queue"
  | "called"
  | "connected"
  | "meetings_booked"
  | "meetings_qualified"
  | "meetings_held"
  | "won"
  | "no_phone";

export const CALL_FILTER_LABELS: Record<CallFilter, string> = {
  all: "Všechny kontakty",
  queue: "Ve frontě k volání",
  called: "Volané",
  connected: "Dovolané",
  meetings_booked: "Domluvené schůzky",
  meetings_qualified: "Kvalifikované schůzky",
  meetings_held: "Uskutečněné schůzky",
  won: "Získaní klienti",
  no_phone: "Bez telefonu",
};

export interface CallContactRow extends CallQueueRow {
  meeting_booked: boolean;
  meeting_at: Date | null;
  meeting_qualified: boolean | null;
  meeting_held: boolean;
  meeting_outcome: MeetingOutcome;
  deal_value: number | null;
  connected_calls: number;
}

export async function listCallContacts(
  campaignId: string,
  filter: CallFilter = "all",
): Promise<CallContactRow[]> {
  return sql<CallContactRow[]>`
    select cc.id, cc.contact_id, c.email, c.phone, c.first_name, c.last_name,
           c.position, c.company, c.website, cc.call_status, cc.call_attempts, cc.last_call_at,
           cc.next_call_at, cc.last_call_outcome, cc.call_note, cc.assigned_caller_id,
           ca.name as assigned_caller_name,
           cc.created_at, cc.meeting_booked, cc.meeting_at, cc.meeting_qualified,
           cc.meeting_held, cc.meeting_outcome, cc.deal_value::float8 as deal_value,
           (select count(*)::int from call_activities a
             where a.campaign_contact_id = cc.id and a.connected) as connected_calls
      from campaign_contacts cc
      join campaigns cp on cp.id = cc.campaign_id
      join contacts c on c.id = cc.contact_id
      left join callers ca on ca.id = cc.assigned_caller_id
     where cc.campaign_id = ${campaignId}
       and case ${filter}::text
             when 'queue' then
               cc.call_status in ('new', 'in_progress', 'callback')
               and cc.call_attempts < cp.max_call_attempts
               and c.phone is not null and btrim(c.phone) <> ''
               and not exists (select 1 from call_suppression cs
                                where cs.contact_id = cc.contact_id)
             when 'called' then cc.call_attempts > 0
             when 'connected' then
               exists (select 1 from call_activities ca
                        where ca.campaign_contact_id = cc.id and ca.connected)
             when 'meetings_booked' then cc.meeting_booked
             when 'meetings_qualified' then cc.meeting_booked and cc.meeting_qualified is true
             when 'meetings_held' then cc.meeting_held
             when 'won' then cc.call_status = 'won'
             when 'no_phone' then c.phone is null or btrim(c.phone) = ''
             else true
           end
     order by
       case cc.call_status when 'callback' then 0 when 'in_progress' then 1 when 'new' then 2 else 3 end,
       cc.next_call_at nulls last,
       cc.last_call_at desc nulls last,
       c.email
  `;
}

// ---------------------------------------------------------------- timeline

export type TimelineKind = "call" | "email" | "reply" | "loom" | "outcome";

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  occurred_at: Date;
  title: string;
  detail: string | null;
  note: string | null;
  /** Kdo to udělal. Null u událostí, které nikdo neinicioval ručně. */
  actor?: string | null;
  /** Kam vede proklik - vlákno, nahrávka, video. Null = nikam. */
  href?: string | null;
  /** Výsledek/stav ve zkratce, když ho událost má. */
  status?: string | null;
}

/**
 * One prospect's whole history in this campaign - calls and e-mails in a
 * single list, newest first, so a caller can see what was already sent before
 * they dial.
 */
export async function getContactTimeline(campaignContactId: string): Promise<TimelineEntry[]> {
  const rows = await sql<
    { id: string; kind: TimelineKind; occurred_at: Date; title: string; detail: string | null; note: string | null }[]
  >`
    select ca.id::text as id, 'call' as kind, ca.called_at as occurred_at,
           ca.outcome as title,
           concat_ws(' · ', 'pokus ' || ca.attempt_number,
                     case when ca.connected then 'dovoláno' else 'nedovoláno' end,
                     cl.name) as detail,
           ca.note
      from call_activities ca
      left join callers cl on cl.id = ca.caller_id
     where ca.campaign_contact_id = ${campaignContactId}

    union all

    -- Stav se ukazuje česky, ne syrovým enumem. Nejde o kosmetiku:
    -- "unknown" znamená, že SMTP zprávu možná přijalo a my to nevíme -
    -- a právě tenhle případ musí administrátor v historii kontaktu
    -- poznat, protože se nikdy neopakuje a čeká na ruční rozhodnutí.
    select es.id::text, 'email', coalesce(es.sent_at, es.claimed_at),
           es.subject,
           concat_ws(' · ', 'krok ' || es.step_number,
                     case es.status
                       when 'sent' then 'odesláno'
                       when 'sending' then 'odesílá se'
                       when 'failed' then 'chyba'
                       when 'skipped' then 'neodesláno'
                       when 'unknown' then 'neznámý výsledek — k ruční kontrole'
                       else es.status
                     end,
                     es.intended_email),
           nullif(btrim(coalesce(es.error, '')), '')
      from email_sends es
     where es.campaign_contact_id = ${campaignContactId}

    union all

    select r.id::text, 'reply', r.received_at,
           coalesce(r.subject, 'Odpověď'),
           r.from_email,
           r.snippet
      from replies r
     where r.campaign_contact_id = ${campaignContactId}

     order by occurred_at desc
  `;
  return rows;
}

export interface CallContactDetail extends CallContactRow {
  campaign_id: string;
  campaign_name: string;
  max_call_attempts: number;
  qualification_criteria: string | null;
  /** The e-mail lifecycle, shown read-only next to the calling one. */
  email_status: string;
}

export async function getCallContact(campaignContactId: string): Promise<CallContactDetail | null> {
  const [row] = await sql<CallContactDetail[]>`
    select cc.id, cc.contact_id, c.email, c.phone, c.first_name, c.last_name,
           c.position, c.company, c.website, cc.call_status, cc.call_attempts, cc.last_call_at,
           cc.next_call_at, cc.last_call_outcome, cc.call_note, cc.assigned_caller_id,
           cl.name as assigned_caller_name,
           cc.created_at, cc.meeting_booked, cc.meeting_at, cc.meeting_qualified,
           cc.meeting_held, cc.meeting_outcome, cc.deal_value::float8 as deal_value,
           cc.status as email_status,
           cp.id as campaign_id, cp.name as campaign_name, cp.max_call_attempts,
           cp.qualification_criteria,
           (select count(*)::int from call_activities a
             where a.campaign_contact_id = cc.id and a.connected) as connected_calls
      from campaign_contacts cc
      join campaigns cp on cp.id = cc.campaign_id
      join contacts c on c.id = cc.contact_id
      left join callers cl on cl.id = cc.assigned_caller_id
     where cc.id = ${campaignContactId}
  `;
  return row ?? null;
}

/** Campaigns with calling switched on, for the caller's campaign picker. */
export async function listCallingCampaigns(): Promise<
  { id: string; name: string; status: string; queue_size: number; callbacks_due: number }[]
> {
  return sql`
    select cp.id, cp.name, cp.status,
           (select count(*)::int
              from campaign_contacts cc
              join contacts c on c.id = cc.contact_id
             where cc.campaign_id = cp.id
               and cc.call_status in ('new', 'in_progress', 'callback')
               and cc.call_attempts < cp.max_call_attempts
               and c.phone is not null and btrim(c.phone) <> ''
               and not exists (select 1 from call_suppression cs
                                where cs.contact_id = cc.contact_id)
               and (cc.next_call_at is null or cc.next_call_at <= now())
               and not exists (select 1 from companies qco where qco.id = c.company_id
                                and qco.status in ('won', 'lost', 'excluded'))) as queue_size,
           (select count(*)::int from campaign_contacts cc
             where cc.campaign_id = cp.id and cc.call_status = 'callback'
               and cc.next_call_at is not null and cc.next_call_at <= now()) as callbacks_due
      from campaigns cp
     where cp.calling_enabled
     order by case cp.status when 'active' then 0 when 'paused' then 1 when 'draft' then 2 else 3 end,
              cp.created_at desc
  `;
}

// ------------------------------------------------------------------ callers

export interface Caller {
  id: string;
  name: string;
  active: boolean;
  email: string | null;
  phone: string | null;
  created_at: Date;
}

export interface CallerRow extends Caller {
  /** Pokusy o volání. Definice viz queries/reporting.ts. */
  attempts: number;
  connected_calls: number;
  meetings_booked: number;
  talk_seconds: number;
  reach_rate: number | null;
}

export async function listCallers(options: { activeOnly?: boolean } = {}): Promise<Caller[]> {
  const activeOnly = options.activeOnly ?? false;
  return sql<Caller[]>`
    select id, name, active, email, phone, created_at
      from callers
     where (${activeOnly} = false or active)
     order by active desc, name
  `;
}

/**
 * Callers with the two numbers that say whether they are working: connected
 * calls and meetings booked. Deliberately not a performance league table -
 * these are the same counters the campaign economics already divide by.
 */
export async function listCallersWithTotals(): Promise<CallerRow[]> {
  // Čísla nepočítá tenhle dotaz, ale reporting service - jinak by Tým
  // tvrdil něco jiného než Přehled. Členové bez jediného hovoru dostanou
  // nuly, ne prázdno.
  const [people, metrics] = await Promise.all([
    sql<Caller[]>`
      select id, name, active, email, phone, created_at
        from callers order by active desc, name
    `,
    getMetricsByCaller(),
  ]);
  return people.map((person) => {
    const stats = metrics.get(person.id);
    return {
      ...person,
      attempts: stats?.attempts ?? 0,
      connected_calls: stats?.connected ?? 0,
      meetings_booked: stats?.meetings ?? 0,
      talk_seconds: stats?.talk_seconds ?? 0,
      reach_rate: stats?.reach_rate ?? null,
    };
  });
}

export async function createCaller(input: {
  name: string;
  email: string | null;
  phone: string | null;
}): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into callers (name, email, phone)
    values (${input.name}, ${input.email}, ${input.phone})
    returning id
  `;
  return row.id;
}

/** Retires or reinstates a caller. Never deletes: the history references them. */
export async function setCallerActive(id: string, active: boolean): Promise<void> {
  await sql`update callers set active = ${active} where id = ${id}`;
}
