import { sql } from "../db";
import { logActivity } from "../activity";
import { nextWindowOpen, type SendingWindow } from "../schedule";
import type { Campaign, SequenceStep } from "../types";

export interface CampaignReadiness {
  ok: boolean;
  problems: string[];
}

/**
 * Everything that must be true before a campaign is allowed to leave draft.
 * Surfaced in the UI as a pre-flight list rather than a single opaque error.
 */
export async function checkCampaignReadiness(campaignId: string): Promise<CampaignReadiness> {
  const problems: string[] = [];

  const [campaign] = await sql<Campaign[]>`select * from campaigns where id = ${campaignId}`;
  if (!campaign) return { ok: false, problems: ["Campaign not found."] };

  const pool = await sql<{ id: string; from_email: string; last_test_ok: boolean | null; enabled: boolean }[]>`
    select m.id, m.from_email, m.last_test_ok, m.enabled
      from campaign_mailboxes cm
      join mailboxes m on m.id = cm.mailbox_id
     where cm.campaign_id = ${campaignId}
     order by m.from_email
  `;
  if (pool.length === 0) {
    problems.push("The campaign has no sender mailboxes.");
  } else {
    const usable = pool.filter((m) => m.enabled && m.last_test_ok === true);
    if (usable.length === 0) {
      problems.push(
        "No sender mailbox is usable: each is either disabled or has no successful connection test.",
      );
    }
    for (const mailbox of pool.filter((m) => m.last_test_ok !== true)) {
      problems.push(`${mailbox.from_email} has not passed a connection test yet.`);
    }
  }

  const steps = await sql<SequenceStep[]>`
    select * from sequence_steps where campaign_id = ${campaignId} order by step_number
  `;
  if (steps.length === 0) problems.push("The sequence has no steps.");
  if (steps.length > 0 && steps[0].delay_days !== 0) {
    problems.push("Step 1 must have a delay of 0 days.");
  }
  for (const step of steps) {
    if (!step.subject.trim()) problems.push(`Step ${step.step_number} has an empty subject.`);
    if (!step.body.trim()) problems.push(`Step ${step.step_number} has an empty body.`);
  }

  const [{ count: contacts }] = await sql<{ count: number }[]>`
    select count(*)::int as count from campaign_contacts where campaign_id = ${campaignId}
  `;
  if (contacts === 0) problems.push("The campaign has no contacts.");

  return { ok: problems.length === 0, problems };
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
 * Moves a campaign from draft/paused to active and schedules every contact
 * that has not been through the sequence yet. Never called automatically.
 */
export async function startCampaign(campaignId: string): Promise<CampaignReadiness> {
  const readiness = await checkCampaignReadiness(campaignId);
  if (!readiness.ok) return readiness;

  const [campaign] = await sql<Campaign[]>`select * from campaigns where id = ${campaignId}`;
  const firstOpening = nextWindowOpen(windowOf(campaign), new Date());

  await sql.begin(async (tx) => {
    await tx`
      update campaign_contacts
         set status = 'scheduled',
             next_send_at = ${firstOpening},
             updated_at = now()
       where campaign_id = ${campaignId} and status = 'pending'
    `;
    await tx`
      update campaigns
         set status = 'active',
             started_at = coalesce(started_at, now()),
             completed_at = null,
             -- Clearing the pacing cursor lets the first email go out as soon
             -- as the window is open, rather than waiting out a stale gap.
             next_slot_at = null,
             updated_at = now()
       where id = ${campaignId}
    `;
  });

  await logActivity({
    action: campaign.started_at ? "Campaign resumed" : "Campaign started",
    campaignId,
    detail: `First send window opens ${firstOpening.toISOString()}`,
  });
  return { ok: true, problems: [] };
}

/**
 * Promotes newly added contacts from `pending` to `scheduled` when the campaign
 * is already running. Without this, anyone imported into an active campaign
 * would sit at `pending` with no next_send_at and never be picked up by the
 * dispatcher, which only looks at `scheduled` and `sent`.
 */
export async function schedulePendingContacts(campaignId: string): Promise<number> {
  const [campaign] = await sql<Campaign[]>`select * from campaigns where id = ${campaignId}`;
  if (!campaign || campaign.status !== "active") return 0;

  const rows = await sql<{ id: string }[]>`
    update campaign_contacts
       set status = 'scheduled',
           next_send_at = ${nextWindowOpen(windowOf(campaign), new Date())},
           updated_at = now()
     where campaign_id = ${campaignId} and status = 'pending'
    returning id
  `;
  return rows.length;
}

export async function pauseCampaign(campaignId: string): Promise<void> {
  await sql`
    update campaigns set status = 'paused', updated_at = now()
     where id = ${campaignId} and status = 'active'
  `;
  await logActivity({ action: "Campaign paused", campaignId });
}

/**
 * Puts a contact whose sequence halted (a failed or indeterminate send) back
 * into the queue at the following step. Used by the "Needs review" screen.
 */
export async function skipStepAndResume(campaignContactId: string): Promise<void> {
  const [row] = await sql<{ campaign_id: string; contact_id: string; current_step: number }[]>`
    select campaign_id, contact_id, current_step from campaign_contacts where id = ${campaignContactId}
  `;
  if (!row) return;

  const [next] = await sql<SequenceStep[]>`
    select * from sequence_steps
     where campaign_id = ${row.campaign_id} and step_number > ${row.current_step}
     order by step_number limit 1
  `;

  if (!next) {
    await sql`
      update campaign_contacts
         set status = 'completed', completed_at = now(), next_send_at = null,
             last_error = null, updated_at = now()
       where id = ${campaignContactId}
    `;
  } else {
    await sql`
      update campaign_contacts
         set status = 'sent', current_step = ${next.step_number},
             next_send_at = now(), last_error = null, updated_at = now()
       where id = ${campaignContactId}
    `;
  }
  await logActivity({
    level: "warn",
    action: "Step skipped manually",
    detail: `Sequence resumed from step ${next?.step_number ?? "end"}.`,
    campaignId: row.campaign_id,
    contactId: row.contact_id,
    campaignContactId,
  });
}

/** The mailboxes a campaign may send from. */
export async function getCampaignMailboxIds(campaignId: string): Promise<string[]> {
  const rows = await sql<{ mailbox_id: string }[]>`
    select mailbox_id from campaign_mailboxes where campaign_id = ${campaignId}
  `;
  return rows.map((r) => r.mailbox_id);
}

/**
 * Replaces a campaign's sender pool.
 *
 * A mailbox that some contact is already pinned to is never removed: doing so
 * would strand that thread with a sender the campaign no longer owns. Those
 * are reported back so the UI can explain why.
 */
export async function setCampaignMailboxes(
  campaignId: string,
  mailboxIds: string[],
): Promise<{ kept: string[] }> {
  const kept: string[] = [];
  await sql.begin(async (tx) => {
    const inUse = await tx<{ mailbox_id: string; from_email: string }[]>`
      select distinct cc.sender_mailbox_id as mailbox_id, m.from_email
        from campaign_contacts cc
        join mailboxes m on m.id = cc.sender_mailbox_id
       where cc.campaign_id = ${campaignId}
         and cc.sender_mailbox_id is not null
         and not (cc.sender_mailbox_id = any(${mailboxIds}::uuid[]))
    `;
    for (const row of inUse) kept.push(row.from_email);

    const finalIds = [...new Set([...mailboxIds, ...inUse.map((r) => r.mailbox_id)])];

    await tx`
      delete from campaign_mailboxes
       where campaign_id = ${campaignId}
         and not (mailbox_id = any(${finalIds}::uuid[]))
    `;
    for (const mailboxId of finalIds) {
      await tx`
        insert into campaign_mailboxes (campaign_id, mailbox_id)
        values (${campaignId}, ${mailboxId})
        on conflict do nothing
      `;
    }
  });

  await logActivity({
    action: "Sender pool updated",
    detail: `${mailboxIds.length} mailbox(es) selected` +
      (kept.length ? `; kept ${kept.join(", ")} because contacts are pinned to them` : ""),
    campaignId,
  });
  return { kept };
}
