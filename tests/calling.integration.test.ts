import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Calling against the real schema.
 *
 * Two things are under test here. The obvious one is that a logged call does
 * what the rules say: the counter moves, the limit retires a prospect, a
 * callback comes back at the right moment, a meeting is recorded and judged.
 *
 * The one that matters more is the last block: a call must never move an
 * e-mail. campaign_contacts carries both lifecycles on one row, so nothing but
 * a test can prove the calling code keeps its hands off status, current_step,
 * next_send_at and the sticky sender.
 */

let sql: typeof import("@/lib/db").sql;
let calling: typeof import("@/lib/queries/calling");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  calling = await import("@/lib/queries/calling");
});

afterAll(async () => {
  await closeDatabase();
});

interface Fixture {
  campaignId: string;
  callerId: string;
  ids: string[];
}

async function seedCalling(
  options: { contacts?: number; maxAttempts?: number; withoutPhone?: number } = {},
): Promise<Fixture> {
  const count = options.contacts ?? 3;
  const seed = await seedCampaign({
    contacts: Array.from({ length: count }, (_, i) => ({
      email: `p${i}@prospect.test`,
      first_name: `P${i}`,
      company: `Firma ${i}`,
    })),
  });

  await sql`
    update campaigns
       set calling_enabled = true, max_call_attempts = ${options.maxAttempts ?? 4}
     where id = ${seed.campaignId}
  `;
  // Everyone is callable unless the fixture deliberately withholds a number.
  const withoutPhone = options.withoutPhone ?? 0;
  for (const [index, contactId] of seed.contactIds.entries()) {
    if (index < count - withoutPhone) {
      await sql`update contacts set phone = ${`+4207770000${index}`} where id = ${contactId}`;
    }
  }

  const callerId = await calling.createCaller({ name: "Jan Caller", email: null, phone: null });
  return { campaignId: seed.campaignId, callerId, ids: seed.campaignContactIds };
}

async function row(id: string) {
  const [record] = await sql<
    {
      call_status: string;
      call_attempts: number;
      next_call_at: Date | null;
      last_call_outcome: string | null;
      meeting_booked: boolean;
      meeting_at: Date | null;
      meeting_qualified: boolean | null;
      meeting_held: boolean;
      assigned_caller_id: string | null;
      status: string;
      current_step: number;
      next_send_at: Date | null;
      sender_mailbox_id: string | null;
    }[]
  >`select * from campaign_contacts where id = ${id}`;
  return record;
}

describe("logging a call", () => {
  it("increments the attempt counter and writes one activity row", async () => {
    const { ids, callerId } = await seedCalling();

    await calling.logCall({ campaignContactId: ids[0], outcome: "no_answer", callerId });
    expect((await row(ids[0])).call_attempts).toBe(1);

    await calling.logCall({ campaignContactId: ids[0], outcome: "busy", callerId });
    const after = await row(ids[0]);
    expect(after.call_attempts).toBe(2);
    expect(after.call_status).toBe("in_progress");
    expect(after.last_call_outcome).toBe("busy");
    expect(after.assigned_caller_id).toBe(callerId);

    const activities = await sql<{ attempt_number: number; connected: boolean; caller_id: string }[]>`
      select attempt_number, connected, caller_id from call_activities
       where campaign_contact_id = ${ids[0]} order by attempt_number
    `;
    expect(activities.map((a) => a.attempt_number)).toEqual([1, 2]);
    expect(activities.every((a) => a.connected === false)).toBe(true);
    expect(activities.every((a) => a.caller_id === callerId)).toBe(true);
  });

  it("marks an outcome that reached a person as connected", async () => {
    const { ids, callerId } = await seedCalling();
    await calling.logCall({ campaignContactId: ids[0], outcome: "not_interested", callerId });

    const [activity] = await sql<{ connected: boolean }[]>`
      select connected from call_activities where campaign_contact_id = ${ids[0]}
    `;
    expect(activity.connected).toBe(true);
    expect((await row(ids[0])).call_status).toBe("lost");
  });

  it("refuses a callback with no date and a meeting with no date", async () => {
    const { ids, callerId } = await seedCalling();

    const callback = await calling.logCall({ campaignContactId: ids[0], outcome: "callback", callerId });
    expect(callback.ok).toBe(false);
    const meeting = await calling.logCall({ campaignContactId: ids[0], outcome: "meeting_booked", callerId });
    expect(meeting.ok).toBe(false);

    // Nothing was written: a rejected call is not an attempt.
    expect((await row(ids[0])).call_attempts).toBe(0);
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from call_activities`;
    expect(count).toBe(0);
  });
});

describe("the attempt limit", () => {
  it("retires a prospect at the campaign's limit and drops them from the queue", async () => {
    const { campaignId, ids, callerId } = await seedCalling({ contacts: 1, maxAttempts: 4 });

    for (let attempt = 1; attempt <= 4; attempt++) {
      const result = await calling.logCall({ campaignContactId: ids[0], outcome: "no_answer", callerId });
      expect(result.ok, `attempt ${attempt}`).toBe(true);
    }

    const after = await row(ids[0]);
    expect(after.call_attempts).toBe(4);
    expect(after.call_status).toBe("max_attempts");

    expect(await calling.listCallQueue(campaignId)).toHaveLength(0);
    expect(await calling.getNextCall(campaignId)).toBeNull();
  });

  it("honours a campaign limit other than four", async () => {
    const { campaignId, ids, callerId } = await seedCalling({ contacts: 1, maxAttempts: 2 });
    await calling.logCall({ campaignContactId: ids[0], outcome: "no_answer", callerId });
    expect((await row(ids[0])).call_status).toBe("in_progress");
    await calling.logCall({ campaignContactId: ids[0], outcome: "no_answer", callerId });
    expect((await row(ids[0])).call_status).toBe("max_attempts");
    expect(await calling.listCallQueue(campaignId)).toHaveLength(0);
  });
});

describe("callbacks", () => {
  it("holds a future callback back and releases it when it falls due", async () => {
    const { campaignId, ids, callerId } = await seedCalling({ contacts: 1 });
    const later = new Date(Date.now() + 3_600_000);

    await calling.logCall({
      campaignContactId: ids[0],
      outcome: "callback",
      callerId,
      callbackAt: later,
    });

    const after = await row(ids[0]);
    expect(after.call_status).toBe("callback");
    expect(after.next_call_at?.getTime()).toBe(later.getTime());
    expect(await calling.listCallQueue(campaignId)).toHaveLength(0);

    // Time passes.
    await sql`update campaign_contacts set next_call_at = now() - interval '1 minute' where id = ${ids[0]}`;
    const queue = await calling.listCallQueue(campaignId);
    expect(queue.map((q) => q.id)).toEqual([ids[0]]);
  });

  it("dials a due callback before anyone who has never been called", async () => {
    const { campaignId, ids, callerId } = await seedCalling({ contacts: 3 });
    await calling.logCall({
      campaignContactId: ids[2],
      outcome: "callback",
      callerId,
      callbackAt: new Date(Date.now() - 60_000),
    });

    const next = await calling.getNextCall(campaignId);
    expect(next?.prospect.id).toBe(ids[2]);
  });
});

describe("meetings and qualification", () => {
  it("books a meeting, judges it, and then marks it held", async () => {
    const { campaignId, ids, callerId } = await seedCalling({ contacts: 1 });
    const when = new Date(Date.now() + 3 * 86_400_000);

    await calling.logCall({
      campaignContactId: ids[0],
      outcome: "meeting_booked",
      callerId,
      meetingAt: when,
      meetingQualified: true,
    });

    const booked = await row(ids[0]);
    expect(booked.call_status).toBe("meeting_booked");
    expect(booked.meeting_booked).toBe(true);
    expect(booked.meeting_at?.getTime()).toBe(when.getTime());
    expect(booked.meeting_qualified).toBe(true);
    expect(booked.meeting_held).toBe(false);

    // A booked prospect leaves the queue - nobody re-dials a won meeting.
    expect(await calling.listCallQueue(campaignId)).toHaveLength(0);

    await calling.updateMeeting(ids[0], { held: true });
    expect((await row(ids[0])).meeting_held).toBe(true);
    // Marking it held must not disturb the qualification judgement.
    expect((await row(ids[0])).meeting_qualified).toBe(true);

    await calling.updateMeeting(ids[0], { qualified: false });
    const rejudged = await row(ids[0]);
    expect(rejudged.meeting_qualified).toBe(false);
    expect(rejudged.meeting_held).toBe(true);
  });

  it("leaves an unjudged meeting out of the qualified count and flags it", async () => {
    const { campaignId, ids, callerId } = await seedCalling({ contacts: 2 });
    const when = new Date(Date.now() + 86_400_000);

    await calling.logCall({ campaignContactId: ids[0], outcome: "meeting_booked", callerId, meetingAt: when });
    await calling.logCall({
      campaignContactId: ids[1],
      outcome: "meeting_booked",
      callerId,
      meetingAt: when,
      meetingQualified: true,
    });

    const report = await calling.getCampaignCallingReport(campaignId);
    expect(report.counts.meetings_booked).toBe(2);
    expect(report.counts.meetings_qualified).toBe(1);
    expect(report.meetings_unjudged).toBe(1);
  });

  it("refuses to judge a meeting that was never booked", async () => {
    const { ids } = await seedCalling({ contacts: 1 });
    const result = await calling.updateMeeting(ids[0], { qualified: true });
    expect(result.ok).toBe(false);
    expect((await row(ids[0])).meeting_qualified).toBeNull();
  });
});

describe("the queue", () => {
  it("never offers a prospect with no phone number", async () => {
    const { campaignId } = await seedCalling({ contacts: 3, withoutPhone: 1 });
    const queue = await calling.listCallQueue(campaignId);
    expect(queue).toHaveLength(2);
    expect(queue.every((q) => q.phone)).toBe(true);

    const noPhone = await calling.listCallContacts(campaignId, "no_phone");
    expect(noPhone).toHaveLength(1);
  });

  it("shows a caller their own assignments plus everything unassigned", async () => {
    const { campaignId, ids, callerId } = await seedCalling({ contacts: 3 });
    const other = await calling.createCaller({ name: "Jiny Caller", email: null, phone: null });

    // ids[0] becomes the other caller's, by them logging a call on it.
    await calling.logCall({ campaignContactId: ids[0], outcome: "no_answer", callerId: other });

    const mine = await calling.listCallQueue(campaignId, { callerId });
    expect(mine.map((q) => q.id).sort()).toEqual([ids[1], ids[2]].sort());

    const theirs = await calling.listCallQueue(campaignId, { callerId: other });
    expect(theirs.map((q) => q.id)).toContain(ids[0]);
  });
});

describe("campaign counters and economics", () => {
  it("counts connected calls per attempt and connected contacts per person", async () => {
    const { campaignId, ids, callerId } = await seedCalling({ contacts: 2 });

    // One prospect reached twice, one reached once, one dial that missed.
    await calling.logCall({ campaignContactId: ids[0], outcome: "not_decision_maker", callerId });
    await calling.logCall({ campaignContactId: ids[0], outcome: "send_info", callerId });
    await calling.logCall({ campaignContactId: ids[1], outcome: "no_answer", callerId });

    const counts = await calling.getCallCounts(campaignId);
    expect(counts.contacts).toBe(2);
    expect(counts.called).toBe(2);
    expect(counts.connected_calls).toBe(2);
    expect(counts.connected_contacts).toBe(1);
  });

  it("prices a campaign at 40 Kc per connected call end to end", async () => {
    const { campaignId, ids, callerId } = await seedCalling({ contacts: 3 });
    await sql`
      update campaigns
         set caller_cost_model = 'per_connected_call', caller_cost_amount = 40,
             revenue_model = 'per_qualified_meeting', revenue_amount = 2500
       where id = ${campaignId}
    `;

    await calling.logCall({ campaignContactId: ids[0], outcome: "not_interested", callerId });
    await calling.logCall({ campaignContactId: ids[1], outcome: "no_answer", callerId });
    await calling.logCall({
      campaignContactId: ids[2],
      outcome: "meeting_booked",
      callerId,
      meetingAt: new Date(Date.now() + 86_400_000),
      meetingQualified: true,
    });

    const report = await calling.getCampaignCallingReport(campaignId);
    expect(report.counts.connected_calls).toBe(2);
    expect(report.economics.caller_cost).toBe(80);
    expect(report.economics.revenue).toBe(2500);
    expect(report.economics.gross_profit).toBe(2420);
    expect(report.economics.cost_per_qualified_meeting).toBe(80);
  });

  it("sums the deal values of won clients into revenue", async () => {
    const { campaignId, ids, callerId } = await seedCalling({ contacts: 2 });
    await calling.logCall({ campaignContactId: ids[0], outcome: "won", callerId, dealValue: 25_000 });
    await calling.logCall({ campaignContactId: ids[1], outcome: "won", callerId, dealValue: 15_000 });

    const report = await calling.getCampaignCallingReport(campaignId);
    expect(report.counts.clients_won).toBe(2);
    expect(report.economics.revenue).toBe(40_000);
    expect(report.economics.revenue_won).toBe(40_000);
  });
});

describe("the timeline", () => {
  it("shows calls and e-mails for one prospect in one list", async () => {
    const { ids, callerId } = await seedCalling({ contacts: 1 });
    await calling.logCall({ campaignContactId: ids[0], outcome: "gatekeeper", callerId, note: "Asistentka" });

    const timeline = await calling.getContactTimeline(ids[0]);
    expect(timeline).toHaveLength(1);
    expect(timeline[0].kind).toBe("call");
    expect(timeline[0].title).toBe("gatekeeper");
    expect(timeline[0].note).toBe("Asistentka");
    expect(timeline[0].detail).toContain("Jan Caller");
  });
});

describe("calling never moves an e-mail", () => {
  it("leaves every e-mail column on the row untouched", async () => {
    const { campaignId, ids, callerId } = await seedCalling({ contacts: 1 });
    const { startCampaign } = await import("@/lib/queries/campaigns");
    await startCampaign(campaignId);

    const before = await row(ids[0]);

    for (const outcome of ["no_answer", "callback", "do_not_call"] as const) {
      await calling.logCall({
        campaignContactId: ids[0],
        outcome,
        callerId,
        callbackAt: new Date(Date.now() + 3_600_000),
      });
    }

    const after = await row(ids[0]);
    expect(after.status).toBe(before.status);
    expect(after.current_step).toBe(before.current_step);
    expect(after.next_send_at?.getTime()).toBe(before.next_send_at?.getTime());
    expect(after.sender_mailbox_id).toBe(before.sender_mailbox_id);
    // ...while the calling side did move.
    expect(after.call_attempts).toBe(3);
    expect(after.call_status).toBe("do_not_call");
  });

  it("does not put a do-not-call prospect on the e-mail suppression list", async () => {
    const { ids, callerId } = await seedCalling({ contacts: 1 });
    await calling.logCall({ campaignContactId: ids[0], outcome: "do_not_call", callerId });

    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from suppression_list`;
    expect(count).toBe(0);
    expect((await row(ids[0])).status).not.toBe("unsubscribed");
  });

  it("still sends the e-mail sequence to a prospect who was called", async () => {
    const { campaignId, ids, callerId } = await seedCalling({ contacts: 1 });
    const { startCampaign } = await import("@/lib/queries/campaigns");
    const { dispatchTick } = await import("@/lib/engine/dispatch");
    const { clearPacing } = await import("./helpers/fixtures");

    await startCampaign(campaignId);
    await calling.logCall({ campaignContactId: ids[0], outcome: "not_interested", callerId });

    await clearPacing(campaignId);
    await dispatchTick();

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from email_sends where campaign_contact_id = ${ids[0]}
    `;
    expect(count).toBe(1);
  });
});
