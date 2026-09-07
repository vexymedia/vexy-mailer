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

  const [mailbox] = await sql<{ id: string; last_test_ok: boolean | null }[]>`
    select id, last_test_ok from mailboxes where id = ${campaign.mailbox_id}
  `;
  if (!mailbox) problems.push("The campaign has no sender mailbox.");
  else if (mailbox.last_test_ok !== true) {
    problems.push("The sender mailbox connection has not been tested successfully yet.");
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
