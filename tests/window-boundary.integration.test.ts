import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { createCampaign, createMailbox } from "./helpers/multi-mailbox";
import { zonedTimeToUtc } from "@/lib/schedule";

/**
 * Production report: a campaign on Mon-Fri 08:00-16:00 Europe/Prague, at 15:45
 * local with 32 of 100 sends used and 133 contacts left, stopped sending and
 * showed "next send no earlier than tomorrow".
 *
 * At 15:45 the campaign is still inside its window, so it must either send or
 * name the concrete condition stopping it - never silently defer to tomorrow.
 *
 * The JS clock is pinned so the window and pacing decisions are deterministic.
 * Contact rows are made due in real time so the SQL side of the candidate query
 * behaves as it does in production.
 */

const TZ = "Europe/Prague";
/** 2026-09-09 is a Wednesday. September in Prague is CEST (UTC+2). */
const at = (hour: number, minute: number) => zonedTimeToUtc(2026, 9, 9, hour * 60 + minute, TZ);

let sql: typeof import("@/lib/db").sql;
let dispatchTick: typeof import("@/lib/engine/dispatch").dispatchTick;
let startCampaign: typeof import("@/lib/queries/campaigns").startCampaign;

beforeEach(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  ({ dispatchTick } = await import("@/lib/engine/dispatch"));
  ({ startCampaign } = await import("@/lib/queries/campaigns"));
  await sql`update app_settings set test_mode = true, test_behavior = 'simulate' where id = true`;
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await closeDatabase();
});

/** The production campaign: Mon-Fri 08:00-16:00 Prague, limit 100. */
async function productionCampaign(contactCount: number, mailboxLimit = 500) {
  const mailbox = await createMailbox({ email: "sender@vexy.cz", dailyLimit: mailboxLimit });
  const { campaignId } = await createCampaign({
    name: "Production shape",
    mailboxIds: [mailbox],
    dailyLimit: 100,
    contacts: Array.from({ length: contactCount }, (_, i) => `p${i}@prospect.test`),
  });
  await sql`
    update campaigns
       set send_days = '{1,2,3,4,5}', send_start_minute = 480, send_end_minute = 960,
           timezone = ${TZ}
     where id = ${campaignId}
  `;
  await startCampaign(campaignId);
  // Every contact due, campaign not paced: the state after a normal day's run.
  await sql`
    update campaign_contacts set next_send_at = now() - interval '1 hour' where campaign_id = ${campaignId}
  `;
  await sql`update campaigns set next_slot_at = null where id = ${campaignId}`;
  return { campaignId, mailbox };
}

/** Records `count` sends earlier today, so the daily counter reads count/100. */
async function alreadySentToday(campaignId: string, mailbox: string, count: number) {
  const [step] = await sql<{ id: string }[]>`
    select id from sequence_steps where campaign_id = ${campaignId} limit 1
  `;
  for (let i = 0; i < count; i++) {
    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email) values (${`sent${i}@prospect.test`}) returning id
    `;
    const [cc] = await sql<{ id: string }[]>`
      insert into campaign_contacts (campaign_id, contact_id, status, sender_mailbox_id, next_send_at)
      values (${campaignId}, ${contact.id}, 'completed', ${mailbox}, null) returning id
    `;
    await sql`
      insert into email_sends (campaign_id, campaign_contact_id, step_id, step_number, mailbox_id,
                               status, to_email, intended_email, subject, body, sent_at)
      values (${campaignId}, ${cc.id}, ${step.id}, 1, ${mailbox}, 'sent',
              'x@x.test', 'x@x.test', 'S', 'B', now())
    `;
  }
}

describe("inside the window at 15:45 with quota left", () => {
  it("sends rather than deferring to tomorrow", async () => {
    const { campaignId, mailbox } = await productionCampaign(133);
    await alreadySentToday(campaignId, mailbox, 32);

    vi.setSystemTime(at(15, 45));
    const summary = await dispatchTick();
    const outcome = summary.outcomes.find((o) => o.campaignId === campaignId)!;

    expect(outcome.action).not.toBe("outside_window");
    expect(outcome.action).not.toBe("daily_limit_reached");
    expect(outcome.action).toBe("simulated");
  });

  it("leaves the next slot inside today's window, not tomorrow", async () => {
    const { campaignId, mailbox } = await productionCampaign(133);
    await alreadySentToday(campaignId, mailbox, 32);

    vi.setSystemTime(at(15, 45));
    await dispatchTick();

    const [campaign] = await sql<{ next_slot_at: Date }[]>`
      select next_slot_at from campaigns where id = ${campaignId}
    `;
    // 8h window / 100 per day = 288s base, jittered 0.6-1.4 => under 7 minutes.
    // 15:45 + that is still before 16:00, so it must remain today.
    expect(campaign.next_slot_at.getTime()).toBeLessThan(at(16, 0).getTime());
    expect(campaign.next_slot_at.getTime()).toBeGreaterThan(at(15, 45).getTime());
  });

  it("32 of 100 is not treated as exhausted", async () => {
    const { campaignId, mailbox } = await productionCampaign(133);
    await alreadySentToday(campaignId, mailbox, 32);

    vi.setSystemTime(at(15, 45));
    const summary = await dispatchTick();
    expect(summary.outcomes[0].action).not.toBe("daily_limit_reached");
  });
});

describe("tomorrow's window open is converted with real DST rules", () => {
  it("rolls to 08:00 CEST = 06:00 UTC in September, never 05:00", async () => {
    const { campaignId, mailbox } = await productionCampaign(5);
    await alreadySentToday(campaignId, mailbox, 1);

    // One minute before close: any gap pushes the next slot past 16:00.
    vi.setSystemTime(at(15, 59));
    await dispatchTick();

    const [campaign] = await sql<{ next_slot_at: Date }[]>`
      select next_slot_at from campaigns where id = ${campaignId}
    `;
    expect(campaign.next_slot_at.toISOString()).toBe("2026-09-10T06:00:00.000Z");
    // The reported production value. 05:00Z would be 07:00 local - an hour early.
    expect(campaign.next_slot_at.toISOString()).not.toBe("2026-09-10T05:00:00.000Z");
  });
});

describe("the pacing cursor after the schedule is edited", () => {
  it("does not keep a campaign parked on a slot computed from the old settings", async () => {
    const { campaignId, mailbox } = await productionCampaign(133);
    await alreadySentToday(campaignId, mailbox, 32);

    // The campaign originally ran on a narrow morning window, so after its last
    // send the cursor rolled to the NEXT day's opening under those settings.
    await sql`
      update campaigns
         set send_start_minute = 420, send_end_minute = 540, timezone = ${TZ}
       where id = ${campaignId}
    `;
    // 30 seconds before that window closes. The gap for 100/day over a 2h
    // window is 72s base (43-101s jittered), so the next slot always lands
    // past 09:00 and therefore rolls to the following day.
    vi.setSystemTime(new Date(at(8, 59).getTime() + 30_000));
    await dispatchTick();

    const [parked] = await sql<{ next_slot_at: Date }[]>`
      select next_slot_at from campaigns where id = ${campaignId}
    `;
    // Cursor now points at tomorrow 07:00 Prague = 05:00 UTC - the reported value.
    expect(parked.next_slot_at.toISOString()).toBe("2026-09-10T05:00:00.000Z");

    // The operator now widens the window to 08:00-16:00 and saves.
    const { saveCampaignSchedule } = await import("@/lib/queries/campaigns");
    await saveCampaignSchedule(campaignId, {
      daily_limit: 100,
      send_days: [1, 2, 3, 4, 5],
      send_start_minute: 480,
      send_end_minute: 960,
      timezone: TZ,
    });

    // At 15:45 the campaign is inside the NEW window with quota and contacts
    // left, so it must send rather than honouring a cursor computed from
    // settings that no longer exist.
    vi.setSystemTime(at(15, 45));
    const summary = await dispatchTick();
    const outcome = summary.outcomes.find((o) => o.campaignId === campaignId)!;
    expect(outcome.action).not.toBe("paced");
    expect(outcome.action).toBe("simulated");
  });
});

describe("several mailboxes with independent limits, inside the window", () => {
  it("keeps sending from a mailbox with room when another is exhausted", async () => {
    const full = await createMailbox({ email: "full@vexy.cz", dailyLimit: 1 });
    const spare = await createMailbox({ email: "spare@vexy.cz", dailyLimit: 50 });
    const { campaignId } = await createCampaign({
      name: "Two senders",
      mailboxIds: [full, spare],
      dailyLimit: 100,
      contacts: ["one@prospect.test", "two@prospect.test", "three@prospect.test"],
    });
    await sql`
      update campaigns set send_days = '{1,2,3,4,5}', send_start_minute = 480,
                           send_end_minute = 960, timezone = ${TZ}
       where id = ${campaignId}
    `;
    await startCampaign(campaignId);

    vi.setSystemTime(at(15, 40));
    for (let i = 0; i < 3; i++) {
      await sql`update campaigns set next_slot_at = null where id = ${campaignId}`;
      await sql`
        update campaign_contacts set next_send_at = now() - interval '1 hour'
         where campaign_id = ${campaignId} and status in ('scheduled', 'sent')
      `;
      await dispatchTick();
    }

    const [used] = await sql<{ full: number; spare: number }[]>`
      select count(*) filter (where mailbox_id = ${full})::int as full,
             count(*) filter (where mailbox_id = ${spare})::int as spare
        from email_sends where status in ('sent','unknown','skipped')
    `;
    expect(used.full).toBe(1); // its own cap, not the campaign's
    expect(used.spare).toBeGreaterThan(0); // the other keeps going
  });

  it("names the mailbox limit rather than pretending the window is closed", async () => {
    const only = await createMailbox({ email: "only@vexy.cz", dailyLimit: 1 });
    const { campaignId } = await createCampaign({
      name: "One capped sender",
      mailboxIds: [only],
      dailyLimit: 100,
      contacts: ["a@prospect.test", "b@prospect.test"],
    });
    await sql`
      update campaigns set send_days = '{1,2,3,4,5}', send_start_minute = 480,
                           send_end_minute = 960, timezone = ${TZ}
       where id = ${campaignId}
    `;
    await startCampaign(campaignId);

    vi.setSystemTime(at(15, 40));
    await sql`update campaign_contacts set next_send_at = now() - interval '1 hour' where campaign_id = ${campaignId}`;
    await dispatchTick(); // uses the single slot

    await sql`update campaigns set next_slot_at = null where id = ${campaignId}`;
    await sql`
      update campaign_contacts set next_send_at = now() - interval '1 hour'
       where campaign_id = ${campaignId} and status in ('scheduled', 'sent')
    `;
    const summary = await dispatchTick();
    const outcome = summary.outcomes.find((o) => o.campaignId === campaignId)!;

    // The concrete limiting condition, not "outside_window" and not silence.
    expect(outcome.action).toBe("no_sender_available");
    expect(outcome.detail).toMatch(/capacity/i);
  });
});
