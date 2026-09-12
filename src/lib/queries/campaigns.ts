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
  if (!campaign) return { ok: false, problems: ["Kampaň nebyla nalezena."] };

  const pool = await sql<{ id: string; from_email: string; last_test_ok: boolean | null; enabled: boolean }[]>`
    select m.id, m.from_email, m.last_test_ok, m.enabled
      from campaign_mailboxes cm
      join mailboxes m on m.id = cm.mailbox_id
     where cm.campaign_id = ${campaignId}
     order by m.from_email
  `;
  if (pool.length === 0) {
    problems.push("Kampaň nemá žádnou odesílací schránku.");
  } else {
    // One unusable mailbox in a pool of five is not a reason to block the
    // campaign - the others can carry it, and allocation skips the bad one.
    // Only a pool with nothing usable at all is a blocker.
    const usable = pool.filter((m) => m.enabled && m.last_test_ok === true);
    if (usable.length === 0) {
      const reasons = pool
        .map((m) =>
          !m.enabled
            ? `${m.from_email} je vypnutá`
            : `${m.from_email} neprošla testem připojení`,
        )
        .join("; ");
      problems.push(`Žádná odesílací schránka není použitelná: ${reasons}.`);
    }
  }

  const steps = await sql<SequenceStep[]>`
    select * from sequence_steps where campaign_id = ${campaignId} order by step_number
  `;
  if (steps.length === 0) problems.push("Sekvence nemá žádné kroky.");
  if (steps.length > 0 && steps[0].delay_days !== 0) {
    problems.push("Krok 1 musí mít prodlevu 0 dnů.");
  }
  for (const step of steps) {
    if (!step.subject.trim()) problems.push(`Krok ${step.step_number} má prázdný předmět.`);
    if (!step.body.trim()) problems.push(`Krok ${step.step_number} má prázdný text.`);
  }

  const [{ count: contacts }] = await sql<{ count: number }[]>`
    select count(*)::int as count from campaign_contacts where campaign_id = ${campaignId}
  `;
  if (contacts === 0) problems.push("Kampaň nemá žádné kontakty.");

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
  await logActivity({ action: "Kampaň pozastavena", campaignId });
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
    action: "Krok ručně přeskočen",
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
    action: "Změna odesílacích schránek",
    detail: `${mailboxIds.length} mailbox(es) selected` +
      (kept.length ? `; kept ${kept.join(", ")} because contacts are pinned to them` : ""),
    campaignId,
  });
  return { kept };
}

export interface CampaignScheduleInput {
  daily_limit: number;
  send_days: number[];
  send_start_minute: number;
  send_end_minute: number;
  timezone: string;
}

/**
 * Updates the settings that govern when a campaign may send.
 *
 * next_slot_at is a pacing cursor derived from the schedule at the moment of
 * the last send: window length divided by the daily limit, snapped into the
 * window. Nothing recomputed it when the schedule changed, so widening a
 * window, moving a timezone or raising the limit left the campaign parked on a
 * cursor computed from settings that no longer existed - inside its new window,
 * with quota and contacts to spare, sending nothing.
 *
 * Any change to those inputs therefore invalidates the cursor. Clearing it
 * makes the campaign eligible immediately, exactly as startCampaign does; the
 * next send recomputes a cursor from the new settings.
 */
export async function saveCampaignSchedule(
  campaignId: string,
  input: CampaignScheduleInput,
): Promise<{ cursorCleared: boolean }> {
  const [current] = await sql<Campaign[]>`select * from campaigns where id = ${campaignId}`;
  if (!current) throw new Error("Campaign not found");

  const scheduleChanged =
    current.daily_limit !== input.daily_limit ||
    current.timezone !== input.timezone ||
    current.send_start_minute !== input.send_start_minute ||
    current.send_end_minute !== input.send_end_minute ||
    [...current.send_days].sort().join(",") !== [...input.send_days].sort().join(",");

  await sql`
    update campaigns
       set daily_limit = ${input.daily_limit},
           send_days = ${input.send_days},
           send_start_minute = ${input.send_start_minute},
           send_end_minute = ${input.send_end_minute},
           timezone = ${input.timezone},
           next_slot_at = ${scheduleChanged ? null : sql`next_slot_at`},
           updated_at = now()
     where id = ${campaignId}
  `;

  if (scheduleChanged && current.next_slot_at) {
    await logActivity({
      action: "Změna rozvrhu odesílání",
      detail:
        "The pacing cursor was cleared because it was computed from the previous schedule. " +
        "The campaign can send again as soon as it is inside the new window.",
      campaignId,
    });
  }
  return { cursorCleared: scheduleChanged && current.next_slot_at !== null };
}
