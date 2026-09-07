import { randomUUID } from "node:crypto";
import { sql } from "../db";
import { env } from "../env";
import { logActivity } from "../activity";
import { getSettings } from "../settings";
import { generateMessageId, sendMail } from "../smtp";
import { renderTemplate, textToHtml } from "../template";
import { followUpDueAt, isWithinWindow, nextSlotAfter, localDayStartUtc, type SendingWindow } from "../schedule";
import { unsubscribeUrl } from "../unsubscribe";
import { withLock } from "./locks";
import { allocateSender, reserveMailboxSlot } from "./allocation";
import { recordOutboundMessage } from "../queries/inbox";
import type { AppSettings, Campaign, Mailbox, SequenceStep } from "../types";

/**
 * The sending engine.
 *
 * The invariant everything here protects: a given (contact, sequence step)
 * pair is delivered at most once, no matter how the worker fails.
 *
 * It is enforced in four layers, in order of authority:
 *
 *   1. UNIQUE (campaign_contact_id, step_id) on email_sends. The database, not
 *      this code, is what makes a duplicate impossible.
 *   2. The claim row is INSERTed and COMMITTED before nodemailer is touched.
 *      A worker that dies during SMTP leaves a committed `sending` row that
 *      blocks every future attempt.
 *   3. A `sending` row older than the claim timeout becomes `unknown`, not
 *      `failed` - we cannot know whether it went out, so it is never retried.
 *   4. Only errors that provably predate transmission are retried at all
 *      (see classifySmtpError).
 *
 * A missed email is recoverable. A prospect receiving the same email twice is
 * not. Every ambiguous case therefore resolves towards not sending.
 */

const DISPATCH_LOCK_TTL_MS = 60_000;

export interface DispatchOutcome {
  campaignId: string;
  campaignName: string;
  action:
    | "sent"
    | "simulated"
    | "failed"
    | "unknown"
    | "outside_window"
    | "paced"
    | "daily_limit_reached"
    | "mailbox_limit_reached"
    | "no_sender_available"
    | "nothing_due"
    | "blocked"
    | "campaign_completed";
  detail?: string;
}

export interface DispatchSummary {
  ranAt: string;
  locked?: boolean;
  reaped: number;
  outcomes: DispatchOutcome[];
}

function windowOf(campaign: Campaign): SendingWindow {
  return {
    sendDays: campaign.send_days,
    sendStartMinute: campaign.send_start_minute,
    sendEndMinute: campaign.send_end_minute,
    timezone: campaign.timezone,
  };
}

/**
 * Marks abandoned claims as indeterminate.
 *
 * A row still in `sending` long after it was claimed means the worker vanished
 * somewhere around the SMTP call. We deliberately do NOT retry these: the
 * message may already be in the prospect's inbox.
 */
export async function reapStuckSends(): Promise<number> {
  const stuck = await sql<{ id: string; campaign_id: string; campaign_contact_id: string; step_number: number }[]>`
    update email_sends
       set status = 'unknown',
           error = coalesce(error, '') ||
                   'Worker did not finish this send. Delivery status is unknown, so it will not be retried.'
     where status = 'sending'
       and claimed_at < now() - ${`${Math.ceil(env.sendClaimTimeoutMs / 1000)} seconds`}::interval
    returning id, campaign_id, campaign_contact_id, step_number
  `;

  for (const row of stuck) {
    // Halt the sequence: continuing would build on an unverified send.
    await sql`
      update campaign_contacts
         set status = 'failed',
             last_error = 'Send status unknown - needs review',
             updated_at = now()
       where id = ${row.campaign_contact_id} and status not in ('replied', 'unsubscribed')
    `;
    await logActivity({
      level: "error",
      action: `Email step ${row.step_number} status unknown`,
      detail: "Worker interrupted mid-send. Not retried to avoid a possible duplicate. Review manually.",
      campaignId: row.campaign_id,
      campaignContactId: row.campaign_contact_id,
    });
  }
  return stuck.length;
}

interface Candidate {
  campaign_contact_id: string;
  contact_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  website: string | null;
  current_step: number;
  thread_message_id: string | null;
  sender_mailbox_id: string | null;
}

interface ClaimedSend {
  id: string;
  attempt_count: number;
}

interface Recipient {
  mode: "live" | "redirect" | "simulate";
  to: string;
  subjectPrefix: string;
}

/**
 * Outcome of the claim transaction. Modelled as an explicit discriminated
 * union because postgres.js types `sql.begin` through `UnwrapPromiseArray`,
 * which erases an inferred union.
 */
type ClaimResult =
  | { kind: "none" }
  | { kind: "mailbox_exhausted"; reason: string }
  | { kind: "no_sender"; reason: string }
  | { kind: "finished"; candidate: Candidate }
  | { kind: "blocked"; reason: string }
  | { kind: "conflict"; status: string; candidate: Candidate; step: SequenceStep }
  | {
      kind: "claimed";
      send: ClaimedSend;
      step: SequenceStep;
      candidate: Candidate;
      recipient: Recipient;
      subject: string;
      text: string;
      /** The mailbox this specific send goes out from. */
      mailbox: Mailbox;
    };

/** Resolves the actual recipient, honouring test mode. */
function resolveRecipient(
  settings: AppSettings,
  intended: string,
): Recipient | { error: string } {
  if (!settings.test_mode) return { mode: "live", to: intended, subjectPrefix: "" };
  if (settings.test_behavior === "simulate") {
    return { mode: "simulate", to: intended, subjectPrefix: "" };
  }
  if (!settings.test_email) {
    // Fail closed: test mode set to redirect with nowhere to redirect to.
    return { error: "Test mode is set to 'redirect' but no test email address is configured." };
  }
  return { mode: "redirect", to: settings.test_email, subjectPrefix: `[TEST -> ${intended}] ` };
}

async function processCampaign(campaign: Campaign, settings: AppSettings): Promise<DispatchOutcome> {
  const base = { campaignId: campaign.id, campaignName: campaign.name };
  const now = new Date();
  const window = windowOf(campaign);

  if (!isWithinWindow(window, now)) {
    return { ...base, action: "outside_window" };
  }
  if (campaign.next_slot_at && campaign.next_slot_at.getTime() > now.getTime()) {
    return { ...base, action: "paced" };
  }

  // Daily limit is counted in the campaign's own timezone.
  //   - `unknown` counts: the message may well have been delivered.
  //   - `skipped` (test-mode simulate) counts too, so a dry run paces exactly
  //     like the real thing. That fidelity is the entire point of test mode.
  const dayStart = localDayStartUtc(now, campaign.timezone);
  const [{ count: sentToday }] = await sql<{ count: number }[]>`
    select count(*)::int as count
      from email_sends
     where campaign_id = ${campaign.id}
       and status in ('sent', 'unknown', 'skipped')
       and coalesce(sent_at, claimed_at) >= ${dayStart}
  `;
  if (sentToday >= campaign.daily_limit) {
    return { ...base, action: "daily_limit_reached", detail: `${sentToday}/${campaign.daily_limit}` };
  }

  // The sender is now resolved per contact, not per campaign: a campaign has a
  // pool, and each contact is pinned to one member of it.
  const [{ count: poolSize }] = await sql<{ count: number }[]>`
    select count(*)::int as count from campaign_mailboxes where campaign_id = ${campaign.id}
  `;
  if (poolSize === 0) {
    return { ...base, action: "blocked", detail: "Campaign has no sender mailboxes" };
  }

  const steps = await sql<SequenceStep[]>`
    select * from sequence_steps where campaign_id = ${campaign.id} order by step_number
  `;
  if (steps.length === 0) return { ...base, action: "blocked", detail: "Campaign has no sequence steps" };

  // ---------------------------------------------------------------
  // Phase 1 (transactional): pick a due contact and claim the send.
  // This commits BEFORE any SMTP work happens.
  // ---------------------------------------------------------------
  const claim: ClaimResult = (await sql.begin(async (tx): Promise<ClaimResult> => {
    // Usage per mailbox, each in its own timezone, so a mailbox shared by
    // campaigns in different zones still has exactly one "today".
    const [candidate] = await tx<Candidate[]>`
      with mailbox_usage as (
        select m.id as mailbox_id, m.enabled, m.daily_limit, m.last_test_ok,
               count(es.id)::int as used_today
          from mailboxes m
          left join email_sends es
            on es.mailbox_id = m.id
           and es.status in ('sent', 'unknown', 'skipped')
           and coalesce(es.sent_at, es.claimed_at)
               >= date_trunc('day', now() at time zone m.timezone) at time zone m.timezone
         group by m.id
      )
      select cc.id   as campaign_contact_id,
             cc.contact_id,
             cc.current_step,
             cc.thread_message_id,
             cc.sender_mailbox_id,
             c.email, c.first_name, c.last_name, c.company, c.website
        from campaign_contacts cc
        join contacts c on c.id = cc.contact_id
        left join mailbox_usage sticky on sticky.mailbox_id = cc.sender_mailbox_id
       where cc.campaign_id = ${campaign.id}
         and cc.status in ('scheduled', 'sent')
         and cc.next_send_at is not null
         and cc.next_send_at <= now()
         and not exists (select 1 from suppression_list s where s.email = c.email)
         and (
           case
             -- Already pinned: that mailbox must be usable and have room.
             -- It is never swapped for another - see the sticky-sender rule.
             when cc.sender_mailbox_id is not null then
               sticky.enabled and sticky.last_test_ok is true
               and sticky.used_today < sticky.daily_limit
             -- Not yet written to: any pool member with room will do.
             else exists (
               select 1 from campaign_mailboxes cm
                 join mailbox_usage mu on mu.mailbox_id = cm.mailbox_id
                where cm.campaign_id = cc.campaign_id
                  and mu.enabled and mu.last_test_ok is true
                  and mu.used_today < mu.daily_limit
             )
           end
         )
       order by cc.next_send_at asc
       limit 1
         for update of cc skip locked
    `;
    if (!candidate) return { kind: "none" };

    const step = steps.find((s) => s.step_number === candidate.current_step);
    if (!step) {
      // Ran off the end of the sequence.
      await tx`
        update campaign_contacts
           set status = 'completed', completed_at = now(), next_send_at = null, updated_at = now()
         where id = ${candidate.campaign_contact_id}
      `;
      return { kind: "finished", candidate };
    }

    const vars = {
      first_name: candidate.first_name,
      last_name: candidate.last_name,
      company: candidate.company,
      website: candidate.website,
      unsubscribe_link: unsubscribeUrl(candidate.contact_id),
    };
    const subjectBody = renderTemplate(step.subject, vars);
    const textBody = renderTemplate(step.body, vars);

    const recipient = resolveRecipient(settings, candidate.email);
    if ("error" in recipient) {
      return { kind: "blocked", reason: recipient.error };
    }

    // --- sender resolution -------------------------------------------
    // Sticky wins outright. A contact that has heard from one address only
    // ever hears from that address again; if it is full, the follow-up waits
    // rather than arriving from a stranger.
    const mailboxId = candidate.sender_mailbox_id ?? (await allocateSender(tx, campaign.id));
    if (!mailboxId) {
      return { kind: "no_sender", reason: "No mailbox in the pool has capacity right now." };
    }

    // Serialises this decision against every other worker; see the function.
    const reservation = await reserveMailboxSlot(tx, mailboxId);
    if (!reservation.ok) {
      return { kind: "mailbox_exhausted", reason: reservation.reason ?? "Mailbox unavailable." };
    }

    const [mailbox] = await tx<Mailbox[]>`select * from mailboxes where id = ${mailboxId}`;
    if (!mailbox) return { kind: "no_sender", reason: "Sender mailbox disappeared." };

    // Soft reservation: pushes this contact out of every other worker's
    // candidate query for the duration of the claim timeout. The real
    // guarantee is the unique constraint below; this only avoids wasted work.
    await tx`
      update campaign_contacts
         set next_send_at = now() + ${`${Math.ceil(env.sendClaimTimeoutMs / 1000)} seconds`}::interval,
             updated_at = now()
       where id = ${candidate.campaign_contact_id}
    `;

    // ***********************************************************
    // THE CLAIM. The unique constraint on (campaign_contact_id,
    // step_id) means this INSERT succeeds at most once, ever. The
    // ON CONFLICT branch reopens the row only when a previous
    // attempt provably failed and retries remain.
    // ***********************************************************
    const claimed = await tx<ClaimedSend[]>`
      insert into email_sends (
        campaign_id, campaign_contact_id, step_id, step_number,
        status, to_email, intended_email, subject, body, claimed_at, mailbox_id
      ) values (
        ${campaign.id}, ${candidate.campaign_contact_id}, ${step.id}, ${step.step_number},
        'sending', ${recipient.to}, ${candidate.email},
        ${recipient.subjectPrefix + subjectBody}, ${textBody}, now(), ${mailboxId}
      )
      on conflict (campaign_contact_id, step_id) do update
         set status        = 'sending',
             attempt_count = email_sends.attempt_count + 1,
             claimed_at    = now(),
             error         = null,
             to_email      = excluded.to_email,
             subject       = excluded.subject,
             body          = excluded.body,
             mailbox_id    = excluded.mailbox_id
       where email_sends.status = 'failed'
         and email_sends.attempt_count < ${env.maxSendAttempts}
         and (email_sends.next_retry_at is null or email_sends.next_retry_at <= now())
      returning id, attempt_count
    `;

    if (claimed.length === 0) {
      // The row exists in a state that forbids sending. Work out which, and
      // move the contact out of the queue so we do not spin on it.
      const [existing] = await tx<{ status: string; attempt_count: number }[]>`
        select status, attempt_count from email_sends
         where campaign_contact_id = ${candidate.campaign_contact_id} and step_id = ${step.id}
      `;
      return { kind: "conflict", status: existing?.status ?? "missing", step, candidate };
    }

    // Pin the sender the first time we write to this contact. From here on the
    // candidate query above will only ever consider this mailbox for them.
    if (!candidate.sender_mailbox_id) {
      await tx`
        update campaign_contacts set sender_mailbox_id = ${mailboxId}, updated_at = now()
         where id = ${candidate.campaign_contact_id}
      `;
      candidate.sender_mailbox_id = mailboxId;
    }

    return {
      kind: "claimed",
      mailbox,
      send: claimed[0],
      step,
      candidate,
      recipient,
      subject: recipient.subjectPrefix + subjectBody,
      text: textBody,
    };
  })) as unknown as ClaimResult;

  if (claim.kind === "none") {
    // Nothing due may mean nothing is left at all - for instance every contact
    // replied, so no send ever reached advanceContact to notice.
    await maybeCompleteCampaign(campaign.id);
    return { ...base, action: "nothing_due" };
  }

  if (claim.kind === "finished") {
    await maybeCompleteCampaign(campaign.id);
    await logActivity({
      action: "Sequence completed",
      campaignId: campaign.id,
      campaignContactId: claim.candidate.campaign_contact_id,
      contactId: claim.candidate.contact_id,
    });
    return { ...base, action: "campaign_completed" };
  }

  if (claim.kind === "blocked") {
    await logActivity({ level: "error", action: "Send blocked", detail: claim.reason, campaignId: campaign.id });
    return { ...base, action: "blocked", detail: claim.reason };
  }

  if (claim.kind === "mailbox_exhausted") {
    // The mailbox this contact is pinned to is full or unusable. The contact
    // waits for it - it is never handed to a different sender.
    return { ...base, action: "mailbox_limit_reached", detail: claim.reason };
  }

  if (claim.kind === "no_sender") {
    return { ...base, action: "no_sender_available", detail: claim.reason };
  }

  if (claim.kind === "conflict") {
    await resolveConflict(campaign, claim.status, claim.candidate, claim.step, steps);
    return { ...base, action: "blocked", detail: `Send already in state '${claim.status}'` };
  }

  // ---------------------------------------------------------------
  // Phase 2 (non-transactional): actually deliver. Everything above
  // is committed, so a crash from here on leaves a `sending` row that
  // the reaper will convert to `unknown` - never a silent duplicate.
  // ---------------------------------------------------------------
  const { send, step, candidate, recipient, subject, text, mailbox } = claim;

  if (recipient.mode === "simulate") {
    await sql`
      update email_sends
         set status = 'skipped', sent_at = now(),
             error = 'TEST MODE (simulate): not delivered to any SMTP server.'
       where id = ${send.id}
    `;
    await advanceContact(campaign, candidate, step, steps, new Date(), null);
    await logActivity({
      action: `Email step ${step.step_number} simulated`,
      detail: `TEST MODE: would have gone to ${candidate.email} - "${subject}"`,
      campaignId: campaign.id,
      contactId: candidate.contact_id,
      campaignContactId: candidate.campaign_contact_id,
    });
    return { ...base, action: "simulated", detail: candidate.email };
  }

  const messageId = generateMessageId(mailbox.from_email);

  // Final gate. Anything that changed since the claim committed stops the send
  // here, and the claim row is retired as `skipped` so it is never retried.
  const abortReason = await finalSendGuard(
    campaign.id,
    candidate.campaign_contact_id,
    candidate.email,
    mailbox.id,
  );
  if (abortReason) {
    await sql`
      update email_sends
         set status = 'skipped', sent_at = now(),
             error = ${`Not sent: ${abortReason}`}
       where id = ${send.id}
    `;
    await logActivity({
      level: "warn",
      action: `Email step ${step.step_number} not sent`,
      detail: `${candidate.email}: ${abortReason}`,
      campaignId: campaign.id,
      contactId: candidate.contact_id,
      campaignContactId: candidate.campaign_contact_id,
    });
    return { ...base, action: "blocked", detail: abortReason };
  }

  const result = await sendMail(mailbox, {
    to: recipient.to,
    subject,
    text,
    html: textToHtml(text),
    messageId,
    // Threading: every follow-up references step 1's Message-ID, so the whole
    // sequence renders as one conversation and replies carry it back to us.
    inReplyTo: candidate.thread_message_id,
    references: candidate.thread_message_id,
    listUnsubscribeUrl: unsubscribeUrl(candidate.contact_id),
  });

  if (result.ok) {
    const sentAt = new Date();
    await sql`
      update email_sends
         set status = 'sent', sent_at = ${sentAt}, message_id = ${result.messageId}, error = null
       where id = ${send.id}
    `;
    await sql`update mailboxes set last_send_at = ${sentAt} where id = ${mailbox.id}`;

    // Mirror the send into the conversation, so the inbox shows the whole
    // exchange rather than only the prospect's half of it.
    await recordOutboundMessage({
      mailboxId: mailbox.id,
      contactId: candidate.contact_id,
      campaignId: campaign.id,
      campaignContactId: candidate.campaign_contact_id,
      kind: "campaign",
      fromEmail: mailbox.from_email,
      toEmail: candidate.email,
      subject,
      bodyText: text,
      messageId: result.messageId,
      inReplyTo: candidate.thread_message_id,
      references: candidate.thread_message_id,
      emailSendId: send.id,
      occurredAt: sentAt,
    });

    await advanceContact(campaign, candidate, step, steps, sentAt, result.messageId);
    await logActivity({
      action: `Email step ${step.step_number} sent`,
      detail:
        recipient.mode === "redirect"
          ? `TEST MODE: redirected to ${recipient.to} (intended ${candidate.email})`
          : `${mailbox.from_email} -> ${candidate.email} - "${subject}"`,
      campaignId: campaign.id,
      contactId: candidate.contact_id,
      campaignContactId: candidate.campaign_contact_id,
    });
    return { ...base, action: "sent", detail: candidate.email };
  }

  // --- delivery did not succeed -----------------------------------
  const attemptsUsed = send.attempt_count;
  const canRetry = result.retryable && attemptsUsed < env.maxSendAttempts;
  // Exponential backoff: 5 min, 20 min, 45 min.
  const retryDelayMs = 5 * 60_000 * attemptsUsed * attemptsUsed;
  const retryAt = new Date(Date.now() + retryDelayMs);

  await sql`
    update email_sends
       set status = ${result.outcome},
           error = ${result.message.slice(0, 2000)},
           next_retry_at = ${canRetry ? retryAt : null}
     where id = ${send.id}
  `;

  if (canRetry) {
    await sql`
      update campaign_contacts
         set next_send_at = ${retryAt}, last_error = ${result.message.slice(0, 500)}, updated_at = now()
       where id = ${candidate.campaign_contact_id}
    `;
  } else {
    await sql`
      update campaign_contacts
         set status = 'failed', next_send_at = null,
             last_error = ${result.message.slice(0, 500)}, updated_at = now()
       where id = ${candidate.campaign_contact_id}
    `;
  }

  await logActivity({
    level: "error",
    action: result.outcome === "unknown" ? `Email step ${step.step_number} status unknown` : "SMTP error",
    detail:
      result.outcome === "unknown"
        ? `Delivery to ${candidate.email} could not be confirmed; not retried. ${result.message}`
        : `${candidate.email}: ${result.message}${canRetry ? ` (retry ${attemptsUsed + 1}/${env.maxSendAttempts} at ${retryAt.toISOString()})` : " (no further retries)"}`,
    campaignId: campaign.id,
    contactId: candidate.contact_id,
    campaignContactId: candidate.campaign_contact_id,
  });

  return { ...base, action: result.outcome === "unknown" ? "unknown" : "failed", detail: result.message };
}

/**
 * Last-moment re-check of every condition that forbids delivery.
 *
 * The guards in the claim transaction are evaluated before that transaction
 * commits, and the commit has to happen before SMTP is touched (layer 2 of the
 * duplicate-send guarantee). That leaves a window in which the world can
 * change, and it is genuinely reachable: the reply poller holds a different
 * lease from the dispatcher, so it can mark a contact `replied` while dispatch
 * sits between commit and send. An operator pressing "Do not contact" or
 * "Pause" lands in the same window.
 *
 * Called immediately before sendMail, so the remaining window is the duration
 * of one round trip to Postgres. It cannot be closed entirely - no database
 * check can be made atomic with an external SMTP call - but this reduces it
 * from "the whole of phase 2" to as close to zero as the design allows.
 *
 * Returns a reason to abort, or null when it is still safe to send.
 */
async function finalSendGuard(
  campaignId: string,
  campaignContactId: string,
  email: string,
  mailboxId: string,
): Promise<string | null> {
  const [row] = await sql<
    { suppressed: boolean; contact_status: string; campaign_status: string; mailbox_enabled: boolean | null }[]
  >`
    select exists (select 1 from suppression_list s where s.email = ${email}) as suppressed,
           cc.status as contact_status,
           cp.status as campaign_status,
           (select m.enabled from mailboxes m where m.id = ${mailboxId}) as mailbox_enabled
      from campaign_contacts cc
      join campaigns cp on cp.id = cc.campaign_id
     where cc.id = ${campaignContactId}
  `;
  if (!row) return "The contact is no longer part of this campaign.";
  if (row.suppressed) return `${email} was added to the do-not-contact list.`;
  if (row.contact_status === "replied") return "The contact replied.";
  if (row.contact_status === "unsubscribed") return "The contact unsubscribed.";
  if (row.campaign_status !== "active") return `The campaign is ${row.campaign_status}.`;
  // The sender can be switched off between the claim and the send, same as
  // everything else above.
  if (row.mailbox_enabled === null) return "The sender mailbox no longer exists.";
  if (!row.mailbox_enabled) return "The sender mailbox was disabled.";
  return null;
}

/**
 * Moves a contact to the next step after a delivered (or simulated) send, and
 * advances the campaign's pacing cursor so the next email is spread out.
 */
async function advanceContact(
  campaign: Campaign,
  candidate: Candidate,
  step: SequenceStep,
  steps: SequenceStep[],
  sentAt: Date,
  messageId: string | null,
): Promise<void> {
  const window = windowOf(campaign);
  const nextStep = steps.find((s) => s.step_number > step.step_number);

  if (nextStep) {
    await sql`
      update campaign_contacts
         set status = 'sent',
             current_step = ${nextStep.step_number},
             next_send_at = ${followUpDueAt(window, sentAt, nextStep.delay_days)},
             last_sent_at = ${sentAt},
             last_error = null,
             thread_message_id = coalesce(thread_message_id, ${messageId}),
             updated_at = now()
       where id = ${candidate.campaign_contact_id}
    `;
  } else {
    await sql`
      update campaign_contacts
         set status = 'completed',
             next_send_at = null,
             completed_at = now(),
             last_sent_at = ${sentAt},
             last_error = null,
             thread_message_id = coalesce(thread_message_id, ${messageId}),
             updated_at = now()
       where id = ${candidate.campaign_contact_id}
    `;
  }

  // Randomised pacing cursor - this is what stops a burst of emails.
  await sql`
    update campaigns
       set next_slot_at = ${nextSlotAfter(window, campaign.daily_limit, sentAt)}, updated_at = now()
     where id = ${campaign.id}
  `;

  await maybeCompleteCampaign(campaign.id);
}

/**
 * The claim was refused because a send row already exists. Reconcile the
 * contact's state so the dispatcher does not pick it again next tick.
 */
async function resolveConflict(
  campaign: Campaign,
  existingStatus: string,
  candidate: Candidate,
  step: SequenceStep,
  steps: SequenceStep[],
): Promise<void> {
  if (existingStatus === "sent" || existingStatus === "skipped") {
    // Already delivered on an earlier tick that failed to record the advance.
    await advanceContact(campaign, candidate, step, steps, new Date(), null);
    return;
  }
  if (existingStatus === "sending") {
    // Another worker holds it, or the reaper will pick it up. Leave it alone.
    return;
  }
  // `unknown`, or `failed` with retries exhausted.
  await sql`
    update campaign_contacts
       set status = 'failed', next_send_at = null,
           last_error = ${`Step ${step.step_number} is in state '${existingStatus}' and will not be retried.`},
           updated_at = now()
     where id = ${candidate.campaign_contact_id} and status not in ('replied', 'unsubscribed')
  `;
}

/** Marks a campaign completed once no contact can receive anything further. */
export async function maybeCompleteCampaign(campaignId: string): Promise<void> {
  const [{ count: remaining }] = await sql<{ count: number }[]>`
    select count(*)::int as count
      from campaign_contacts
     where campaign_id = ${campaignId} and status in ('pending', 'scheduled', 'sent')
  `;
  if (remaining === 0) {
    await sql`
      update campaigns
         set status = 'completed', completed_at = now(), updated_at = now()
       where id = ${campaignId} and status = 'active'
    `;
  }
}

/**
 * One dispatcher pass. Sends at most one email per active campaign, which -
 * combined with a per-minute cron and the randomised pacing cursor - makes it
 * physically impossible for two emails to leave in the same second.
 */
export async function dispatchTick(): Promise<DispatchSummary> {
  const holder = randomUUID();
  const result = await withLock("dispatch", DISPATCH_LOCK_TTL_MS, holder, async () => {
    const reaped = await reapStuckSends();
    const settings = await getSettings();
    const campaigns = await sql<Campaign[]>`
      select * from campaigns where status = 'active' order by coalesce(next_slot_at, to_timestamp(0)) asc
    `;

    const outcomes: DispatchOutcome[] = [];
    for (const campaign of campaigns) {
      try {
        outcomes.push(await processCampaign(campaign, settings));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await logActivity({
          level: "error",
          action: "Dispatcher error",
          detail: message,
          campaignId: campaign.id,
        });
        outcomes.push({
          campaignId: campaign.id,
          campaignName: campaign.name,
          action: "blocked",
          detail: message,
        });
      }
    }
    return { reaped, outcomes };
  });

  if ("skipped" in result) {
    return { ranAt: new Date().toISOString(), locked: true, reaped: 0, outcomes: [] };
  }
  return { ranAt: new Date().toISOString(), ...result };
}
