import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * The hardening pass, each block naming the hole it closes.
 *
 * These are all reachable states rather than hypotheticals: a batch import
 * that shares a timestamp, two callers on one campaign, a stale tab submitting
 * a fifth attempt, someone who said "nevolat" being imported into the next
 * campaign, and a meeting that is in the diary but has not happened.
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

async function seedCalling(options: { contacts?: number; maxAttempts?: number; prefix?: string } = {}) {
  const count = options.contacts ?? 3;
  const prefix = options.prefix ?? "p";
  const seed = await seedCampaign({
    contacts: Array.from({ length: count }, (_, i) => ({
      email: `${prefix}${i}@prospect.test`,
      first_name: `P${i}`,
      company: `Firma ${i}`,
    })),
  });
  await sql`
    update campaigns set calling_enabled = true, max_call_attempts = ${options.maxAttempts ?? 4}
     where id = ${seed.campaignId}
  `;
  for (const [index, contactId] of seed.contactIds.entries()) {
    await sql`update contacts set phone = ${`+4207770000${index}`} where id = ${contactId}`;
  }
  const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
  return { ...seed, callerId };
}

describe("the queue is deterministic", () => {
  it("orders a batch that shares one created_at identically every time", async () => {
    // addContactsToCampaign inserts the whole list with a single
    // INSERT ... SELECT, so every row carries the same created_at. Before the
    // id tiebreak their relative order was undefined.
    const seed = await seedCampaign({ contacts: [{ email: "seed@prospect.test" }] });
    await sql`update campaigns set calling_enabled = true where id = ${seed.campaignId}`;

    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const [row] = await sql<{ id: string }[]>`
        insert into contacts (email, phone) values (${`b${i}@prospect.test`}, ${`+42060000000${i}`})
        returning id
      `;
      ids.push(row.id);
    }
    const { addContactsToCampaign } = await import("@/lib/queries/contacts");
    await addContactsToCampaign(seed.campaignId, ids);

    const [{ distinct_timestamps }] = await sql<{ distinct_timestamps: number }[]>`
      select count(distinct created_at)::int as distinct_timestamps
        from campaign_contacts where campaign_id = ${seed.campaignId}
    `;
    // The premise of the test: they really do collide.
    expect(distinct_timestamps).toBeLessThan(13);

    const rows = await calling.listCallQueue(seed.campaignId);
    const queueOrder = rows.map((r) => r.id);

    // Stable across reads...
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await calling.listCallQueue(seed.campaignId)).map((r) => r.id)).toEqual(queueOrder);
    }

    // ...and stable by definition, not by luck: the order the database
    // returns is the order the pure ordering function specifies.
    const { orderCallQueue } = await import("@/lib/calling");
    expect(orderCallQueue(rows, new Date()).map((r) => r.id)).toEqual(queueOrder);
  });
});

describe("the attempt limit holds at the writer", () => {
  it("refuses a call once the prospect has spent every attempt", async () => {
    const seed = await seedCalling({ contacts: 1, maxAttempts: 4 });
    const id = seed.campaignContactIds[0];

    for (let i = 0; i < 4; i++) {
      expect((await calling.logCall({ campaignContactId: id, outcome: "no_answer", callerId: seed.callerId })).ok).toBe(true);
    }

    // A stale tab, a double submit, or a script reaching the query layer.
    const fifth = await calling.logCall({ campaignContactId: id, outcome: "no_answer", callerId: seed.callerId });
    expect(fifth.ok).toBe(false);
    expect(fifth.error).toContain("vyčerpal");

    const [row] = await sql<{ call_attempts: number }[]>`
      select call_attempts from campaign_contacts where id = ${id}
    `;
    expect(row.call_attempts).toBe(4);

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from call_activities where campaign_contact_id = ${id}
    `;
    expect(count).toBe(4);
  });
});

describe("do-not-call is global", () => {
  it("removes the person from every campaign's queue, not just the one they said it on", async () => {
    const a = await seedCalling({ contacts: 1, prefix: "shared" });
    const contactId = a.contactIds[0];

    // The same person, in a second campaign.
    const b = await seedCampaign({ contacts: [{ email: "other@prospect.test" }] });
    await sql`update campaigns set calling_enabled = true where id = ${b.campaignId}`;
    const [ccB] = await sql<{ id: string }[]>`
      insert into campaign_contacts (campaign_id, contact_id) values (${b.campaignId}, ${contactId})
      returning id
    `;

    expect((await calling.listCallQueue(b.campaignId)).map((r) => r.id)).toContain(ccB.id);

    await calling.logCall({
      campaignContactId: a.campaignContactIds[0],
      outcome: "do_not_call",
      callerId: a.callerId,
    });

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from call_suppression where contact_id = ${contactId}
    `;
    expect(count).toBe(1);
    expect((await calling.listCallQueue(b.campaignId)).map((r) => r.id)).not.toContain(ccB.id);
    expect(await calling.getNextCall(b.campaignId, a.callerId)).toBeNull();
  });

  it("does not touch the e-mail suppression list", async () => {
    const seed = await seedCalling({ contacts: 1 });
    await calling.logCall({
      campaignContactId: seed.campaignContactIds[0],
      outcome: "do_not_call",
      callerId: seed.callerId,
    });
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from suppression_list`;
    expect(count).toBe(0);
  });
});

describe("two callers are never handed the same prospect", () => {
  it("leases the head of the queue to whoever claimed it", async () => {
    const seed = await seedCalling({ contacts: 3 });
    const other = await calling.createCaller({ name: "Petra", email: null, phone: null });

    const mine = await calling.claimNextCall(seed.campaignId, seed.callerId);
    const theirs = await calling.claimNextCall(seed.campaignId, other);

    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    expect(mine).not.toBe(theirs);
  });

  it("hands the same caller the same prospect back, rather than skipping on", async () => {
    const seed = await seedCalling({ contacts: 3 });
    const first = await calling.claimNextCall(seed.campaignId, seed.callerId);
    const again = await calling.claimNextCall(seed.campaignId, seed.callerId);
    expect(again).toBe(first);
  });

  it("survives concurrent claims: nobody gets a duplicate", async () => {
    const seed = await seedCalling({ contacts: 6 });
    const callers = await Promise.all(
      [1, 2, 3].map((n) => calling.createCaller({ name: `C${n}`, email: null, phone: null })),
    );

    const claimed = await Promise.all(callers.map((c) => calling.claimNextCall(seed.campaignId, c)));
    const ids = claimed.filter((id): id is string => id !== null);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("releases the prospect once the call is logged", async () => {
    const seed = await seedCalling({ contacts: 2 });
    const claimed = await calling.claimNextCall(seed.campaignId, seed.callerId);
    await calling.logCall({ campaignContactId: claimed!, outcome: "no_answer", callerId: seed.callerId });

    const [row] = await sql<{ call_locked_until: Date | null; call_locked_by: string | null }[]>`
      select call_locked_until, call_locked_by from campaign_contacts where id = ${claimed}
    `;
    expect(row.call_locked_until).toBeNull();
    expect(row.call_locked_by).toBeNull();
  });

  it("frees an abandoned lease once it expires", async () => {
    const seed = await seedCalling({ contacts: 1 });
    const other = await calling.createCaller({ name: "Petra", email: null, phone: null });

    const claimed = await calling.claimNextCall(seed.campaignId, seed.callerId);
    expect(await calling.claimNextCall(seed.campaignId, other)).toBeNull();

    // The caller closed the tab; the lease ran out.
    await sql`
      update campaign_contacts set call_locked_until = now() - interval '1 minute' where id = ${claimed}
    `;
    expect(await calling.claimNextCall(seed.campaignId, other)).toBe(claimed);
  });
});

describe("a lease comes from an action, never from a render", () => {
  async function lockedCount(): Promise<number> {
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int from campaign_contacts where call_locked_until is not null
    `;
    return row.count;
  }

  it("renders and prefetches without reserving anybody", async () => {
    const seed = await seedCalling({ contacts: 3 });

    // Everything the workspace touches while it renders, several times over -
    // a router prefetch, the render itself, a stray refresh.
    for (let render = 0; render < 3; render++) {
      await calling.getHeldCall(seed.campaignId, seed.callerId);
      await calling.getNextCall(seed.campaignId, seed.callerId);
      await calling.listCallQueue(seed.campaignId, { callerId: seed.callerId });
      await calling.getCampaignCallingReport(seed.campaignId);
    }

    expect(await lockedCount()).toBe(0);

    // Another caller is still offered everyone, because nobody was taken out
    // of the queue by the first caller merely looking at the page.
    const other = await calling.createCaller({ name: "Petra", email: null, phone: null });
    expect(await calling.listCallQueue(seed.campaignId, { callerId: other })).toHaveLength(3);
  });

  it("reserves exactly one prospect when the caller actually asks", async () => {
    const seed = await seedCalling({ contacts: 3 });
    expect(await lockedCount()).toBe(0);

    const claimed = await calling.claimNextCall(seed.campaignId, seed.callerId);
    expect(claimed).not.toBeNull();
    expect(await lockedCount()).toBe(1);

    const held = await calling.getHeldCall(seed.campaignId, seed.callerId);
    expect(held?.prospect.id).toBe(claimed);
  });

  it("shows the same prospect on refresh without taking a second lease", async () => {
    const seed = await seedCalling({ contacts: 3 });
    const claimed = await calling.claimNextCall(seed.campaignId, seed.callerId);

    const [before] = await sql<{ call_locked_until: Date }[]>`
      select call_locked_until from campaign_contacts where id = ${claimed}
    `;

    for (let refresh = 0; refresh < 4; refresh++) {
      expect((await calling.getHeldCall(seed.campaignId, seed.callerId))?.prospect.id).toBe(claimed);
    }

    expect(await lockedCount()).toBe(1);
    const [after] = await sql<{ call_locked_until: Date }[]>`
      select call_locked_until from campaign_contacts where id = ${claimed}
    `;
    // Reading does not extend the lease either, so an abandoned tab still
    // frees the prospect on schedule.
    expect(after.call_locked_until.getTime()).toBe(before.call_locked_until.getTime());
  });

  it("holds nothing for a caller who has not asked yet", async () => {
    const seed = await seedCalling({ contacts: 2 });
    const other = await calling.createCaller({ name: "Petra", email: null, phone: null });

    await calling.claimNextCall(seed.campaignId, seed.callerId);

    // The second caller's workspace renders; it must show them nothing held,
    // not somebody else's prospect.
    expect(await calling.getHeldCall(seed.campaignId, other)).toBeNull();
  });

  it("stops showing a held prospect once they are decided", async () => {
    const seed = await seedCalling({ contacts: 2 });
    const claimed = await calling.claimNextCall(seed.campaignId, seed.callerId);
    await calling.logCall({ campaignContactId: claimed!, outcome: "not_interested", callerId: seed.callerId });

    // Logging released the lease, so the workspace falls back to asking.
    expect(await calling.getHeldCall(seed.campaignId, seed.callerId)).toBeNull();
    expect(await lockedCount()).toBe(0);
  });
});

describe("the meeting lifecycle", () => {
  async function bookOne() {
    const seed = await seedCalling({ contacts: 1 });
    await calling.logCall({
      campaignContactId: seed.campaignContactIds[0],
      outcome: "meeting_booked",
      callerId: seed.callerId,
      meetingAt: new Date(Date.now() + 86_400_000),
      meetingQualified: true,
    });
    return seed;
  }

  it("tells a meeting that has not happened yet from one nobody turned up to", async () => {
    const seed = await bookOne();
    const id = seed.campaignContactIds[0];

    const scheduled = await calling.getCallCounts(seed.campaignId);
    expect(scheduled.meetings_booked).toBe(1);
    expect(scheduled.meetings_held).toBe(0);
    expect(scheduled.meetings_no_show).toBe(0);

    await calling.updateMeeting(id, { outcome: "no_show" });
    const missed = await calling.getCallCounts(seed.campaignId);
    expect(missed.meetings_held).toBe(0);
    expect(missed.meetings_no_show).toBe(1);
    // A no-show is still a booked, qualified meeting - it was really booked.
    expect(missed.meetings_booked).toBe(1);
    expect(missed.meetings_qualified).toBe(1);

    await calling.updateMeeting(id, { outcome: "held" });
    const held = await calling.getCallCounts(seed.campaignId);
    expect(held.meetings_held).toBe(1);
    expect(held.meetings_no_show).toBe(0);
  });

  it("never lets meeting_held disagree with the outcome", async () => {
    const seed = await bookOne();
    const id = seed.campaignContactIds[0];
    await calling.updateMeeting(id, { outcome: "held" });

    // meeting_held is generated, so it cannot be written out of step with it.
    await expect(
      sql`update campaign_contacts set meeting_held = false where id = ${id}`,
    ).rejects.toThrow();

    const [row] = await sql<{ meeting_held: boolean }[]>`
      select meeting_held from campaign_contacts where id = ${id}
    `;
    expect(row.meeting_held).toBe(true);
  });

  it("bills a campaign on held meetings without counting the no-shows", async () => {
    const seed = await seedCalling({ contacts: 2 });
    await sql`
      update campaigns set revenue_model = 'per_meeting_held', revenue_amount = 3000,
                           caller_cost_model = 'none'
       where id = ${seed.campaignId}
    `;
    for (const id of seed.campaignContactIds) {
      await calling.logCall({
        campaignContactId: id,
        outcome: "meeting_booked",
        callerId: seed.callerId,
        meetingAt: new Date(Date.now() + 86_400_000),
        meetingQualified: true,
      });
    }
    await calling.updateMeeting(seed.campaignContactIds[0], { outcome: "held" });
    await calling.updateMeeting(seed.campaignContactIds[1], { outcome: "no_show" });

    const report = await calling.getCampaignCallingReport(seed.campaignId);
    expect(report.counts.meetings_booked).toBe(2);
    expect(report.counts.meetings_held).toBe(1);
    expect(report.economics.revenue).toBe(3000);
  });
});

describe("no active contact without a next action", () => {
  it("refuses to park a prospect in callback with no time to call back", async () => {
    const seed = await seedCalling({ contacts: 1 });
    await expect(
      sql`
        update campaign_contacts set call_status = 'callback', next_call_at = null
         where id = ${seed.campaignContactIds[0]}
      `,
    ).rejects.toThrow();
  });

  it("counts an open contact with no phone number as stranded", async () => {
    const seed = await seedCalling({ contacts: 2 });
    await sql`
      update contacts set phone = null
       where id = (select contact_id from campaign_contacts where id = ${seed.campaignContactIds[0]})
    `;

    const report = await calling.getCampaignCallingReport(seed.campaignId);
    expect(report.stranded).toBe(1);
    // ...and they are genuinely not in the queue, which is why it has to show.
    expect(report.queue_size).toBe(1);
  });
});

describe("data integrity the application cannot break", () => {
  it("rejects a booked meeting with no date", async () => {
    const seed = await seedCalling({ contacts: 1 });
    await expect(
      sql`update campaign_contacts set meeting_booked = true where id = ${seed.campaignContactIds[0]}`,
    ).rejects.toThrow();
  });

  it("rejects a qualification judgement on a meeting that was never booked", async () => {
    const seed = await seedCalling({ contacts: 1 });
    await expect(
      sql`update campaign_contacts set meeting_qualified = true where id = ${seed.campaignContactIds[0]}`,
    ).rejects.toThrow();
  });

  it("rejects a negative attempt count", async () => {
    const seed = await seedCalling({ contacts: 1 });
    await expect(
      sql`update campaign_contacts set call_attempts = -1 where id = ${seed.campaignContactIds[0]}`,
    ).rejects.toThrow();
  });

  it("rejects a meeting outcome on a prospect with no meeting", async () => {
    const seed = await seedCalling({ contacts: 1 });
    await expect(
      sql`update campaign_contacts set meeting_outcome = 'held' where id = ${seed.campaignContactIds[0]}`,
    ).rejects.toThrow();
  });
});

describe("hardening leaves the e-mail engine alone", () => {
  it("still sends the sequence to a prospect who is on the do-not-call list", async () => {
    const seed = await seedCalling({ contacts: 1 });
    const { startCampaign } = await import("@/lib/queries/campaigns");
    const { dispatchTick } = await import("@/lib/engine/dispatch");
    const { clearPacing } = await import("./helpers/fixtures");

    await startCampaign(seed.campaignId);
    await calling.logCall({
      campaignContactId: seed.campaignContactIds[0],
      outcome: "do_not_call",
      callerId: seed.callerId,
    });

    await clearPacing(seed.campaignId);
    await dispatchTick();

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from email_sends where campaign_contact_id = ${seed.campaignContactIds[0]}
    `;
    // Phone consent and e-mail consent are different things.
    expect(count).toBe(1);
  });
});
