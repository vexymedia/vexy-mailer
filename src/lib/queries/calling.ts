import { sql } from "../db";
import { logActivity } from "../activity";
import {
  applyCallOutcome,
  callOutcome,
  computeEconomics,
  buildFunnel,
  type CallCounts,
  type CallOutcome,
  type CallStatus,
  type Economics,
  type FunnelStage,
  type MeetingOutcome,
} from "../calling";
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
export async function listCallQueue(
  campaignId: string,
  options: { limit?: number; callerId?: string | null } = {},
): Promise<CallQueueRow[]> {
  const callerId = options.callerId ?? null;
  return sql<CallQueueRow[]>`
    select cc.id, cc.contact_id, c.email, c.phone, c.first_name, c.last_name,
           c.company, c.website, cc.call_status, cc.call_attempts, cc.last_call_at,
           cc.next_call_at, cc.last_call_outcome, cc.call_note, cc.assigned_caller_id,
           ca.name as assigned_caller_name, cc.created_at
      from campaign_contacts cc
      join campaigns cp on cp.id = cc.campaign_id
      join contacts c on c.id = cc.contact_id
      left join callers ca on ca.id = cc.assigned_caller_id
     where cc.campaign_id = ${campaignId}
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
       -- A callback in the future is not work yet.
       and (cc.call_status <> 'callback' or cc.next_call_at is null or cc.next_call_at <= now())
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
export async function claimNextCall(campaignId: string, callerId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    update campaign_contacts cc
       set call_locked_by = ${callerId}, call_locked_until = now() + interval '${sql.unsafe(String(CALL_LEASE_MINUTES))} minutes'
     where cc.id = (
       select inner_cc.id
         from campaign_contacts inner_cc
         join campaigns cp on cp.id = inner_cc.campaign_id
         join contacts c on c.id = inner_cc.contact_id
        where inner_cc.campaign_id = ${campaignId}
          and inner_cc.call_status in ('new', 'in_progress', 'callback')
          and inner_cc.call_attempts < cp.max_call_attempts
          and c.phone is not null and btrim(c.phone) <> ''
          and not exists (select 1 from call_suppression cs where cs.contact_id = inner_cc.contact_id)
          and (inner_cc.assigned_caller_id is null or inner_cc.assigned_caller_id = ${callerId})
          and (inner_cc.call_locked_until is null or inner_cc.call_locked_until < now()
               or inner_cc.call_locked_by = ${callerId})
          and (inner_cc.call_status <> 'callback' or inner_cc.next_call_at is null
               or inner_cc.next_call_at <= now())
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

export async function getNextCall(
  campaignId: string,
  callerId?: string | null,
): Promise<NextCall | null> {
  // With a known caller the prospect is leased, so nobody else is handed the
  // same person. Without one (a read-only preview) the queue is only read.
  if (callerId) {
    const claimed = await claimNextCall(campaignId, callerId);
    if (!claimed) return null;
  }
  const queue = await listCallQueue(campaignId, { limit: 50, callerId });
  if (queue.length === 0) return null;

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
    prospect: queue[0],
    campaign: { id: campaign.id, name: campaign.name, max_call_attempts: campaign.max_call_attempts },
    script: {
      opening: campaign.script_opening,
      value: campaign.script_value,
      objections: campaign.script_objections,
      closing: campaign.script_closing,
      qualification: campaign.qualification_criteria,
    },
    remaining: queue.length,
  };
}

// -------------------------------------------------------------- logging

export interface LogCallInput {
  campaignContactId: string;
  outcome: CallOutcome;
  callerId?: string | null;
  note?: string | null;
  callbackAt?: Date | null;
  meetingAt?: Date | null;
  meetingQualified?: boolean | null;
  dealValue?: number | null;
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
export async function logCall(input: LogCallInput): Promise<LogCallResult> {
  const definition = callOutcome(input.outcome);

  if (definition.requires === "callback_at" && !input.callbackAt) {
    return { ok: false, error: "Zvolte datum a čas dalšího hovoru." };
  }
  if (definition.requires === "meeting_at" && !input.meetingAt) {
    return { ok: false, error: "Zvolte datum a čas schůzky." };
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
      }[]
    >`
      select cc.id, cc.campaign_id, cc.contact_id, cc.call_attempts,
             cp.max_call_attempts, c.email
        from campaign_contacts cc
        join campaigns cp on cp.id = cc.campaign_id
        join contacts c on c.id = cc.contact_id
       where cc.id = ${input.campaignContactId}
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

    await tx`
      insert into call_activities (campaign_id, campaign_contact_id, contact_id, caller_id,
                                   outcome, connected, note, attempt_number,
                                   next_action_at, meeting_at, meeting_qualified, deal_value)
      values (${row.campaign_id}, ${row.id}, ${row.contact_id}, ${callerId},
              ${outcomeValue}, ${applied.connected}, ${note}, ${applied.attempts},
              ${applied.nextCallAt}, ${applied.meetingAt}, ${applied.meetingQualified},
              ${input.dealValue ?? null})
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
            and (cc.call_status <> 'callback' or cc.next_call_at is null or cc.next_call_at <= now()))
          as queue_size,
        (select count(*)::int
           from campaign_contacts cc
           join contacts c on c.id = cc.contact_id
          where cc.campaign_id = ${campaignId}
            and cc.call_status in ('new', 'in_progress', 'callback')
            and (c.phone is null or btrim(c.phone) = '')) as stranded,
        (select count(*)::int
           from campaign_contacts cc
           join call_suppression cs on cs.contact_id = cc.contact_id
          where cc.campaign_id = ${campaignId}) as do_not_call
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
           c.company, c.website, cc.call_status, cc.call_attempts, cc.last_call_at,
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

export type TimelineKind = "call" | "email" | "reply";

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  occurred_at: Date;
  title: string;
  detail: string | null;
  note: string | null;
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

    select es.id::text, 'email', coalesce(es.sent_at, es.claimed_at),
           es.subject,
           concat_ws(' · ', 'krok ' || es.step_number, es.status, es.intended_email),
           null
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
           c.company, c.website, cc.call_status, cc.call_attempts, cc.last_call_at,
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
               and (cc.call_status <> 'callback' or cc.next_call_at is null
                    or cc.next_call_at <= now())) as queue_size,
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
  connected_calls: number;
  meetings_booked: number;
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
  return sql<CallerRow[]>`
    select c.id, c.name, c.active, c.email, c.phone, c.created_at,
           (select count(*)::int from call_activities ca
             where ca.caller_id = c.id and ca.connected) as connected_calls,
           (select count(*)::int from call_activities ca
             where ca.caller_id = c.id and ca.outcome = 'meeting_booked') as meetings_booked
      from callers c
     order by c.active desc, c.name
  `;
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
