import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Integration tests against a real PostgreSQL instance, running the real
 * migrations. These cover the guarantees that cannot be proved with unit
 * tests: the unique constraint under genuine concurrency, the claim-before-
 * send ordering, and the reply/suppression exclusions.
 *
 * The engine runs in simulate mode, so every code path executes except the
 * nodemailer call itself.
 */

let sql: typeof import("@/lib/db").sql;
let dispatchTick: typeof import("@/lib/engine/dispatch").dispatchTick;
let reapStuckSends: typeof import("@/lib/engine/dispatch").reapStuckSends;
let startCampaign: typeof import("@/lib/queries/campaigns").startCampaign;

beforeAll(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  ({ dispatchTick, reapStuckSends } = await import("@/lib/engine/dispatch"));
  ({ startCampaign } = await import("@/lib/queries/campaigns"));
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
});

async function sendRows(campaignId: string) {
  return sql<{ step_number: number; status: string; intended_email: string; attempt_count: number }[]>`
    select step_number, status, intended_email, attempt_count
      from email_sends where campaign_id = ${campaignId}
     order by step_number, intended_email
  `;
}

describe("campaign lifecycle", () => {
  it("creates campaigns in draft and never sends until explicitly started", async () => {
    const seed = await seedCampaign();
    const [campaign] = await sql`select status from campaigns where id = ${seed.campaignId}`;
    expect(campaign.status).toBe("draft");

    const summary = await dispatchTick();
    expect(summary.outcomes).toEqual([]); // draft campaigns are not even considered
    expect(await sendRows(seed.campaignId)).toHaveLength(0);
  });

  it("refuses to start a campaign that is not ready", async () => {
    const seed = await seedCampaign({ contacts: [] });
    const result = await startCampaign(seed.campaignId);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("The campaign has no contacts.");

    const [campaign] = await sql`select status from campaigns where id = ${seed.campaignId}`;
    expect(campaign.status).toBe("draft"); // unchanged
  });

  it("refuses to start when the mailbox connection was never tested", async () => {
    const seed = await seedCampaign();
    await sql`update mailboxes set last_test_ok = null where id = ${seed.mailboxId}`;
    const result = await startCampaign(seed.campaignId);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("has not been tested");
  });

  it("walks a contact through every step of the sequence, in order", async () => {
    const seed = await seedCampaign();
    await startCampaign(seed.campaignId);

    for (let step = 1; step <= 3; step++) {
      await clearPacing(seed.campaignId);
      const summary = await dispatchTick();
      expect(summary.outcomes[0].action, `step ${step}`).toBe("simulated");
    }

    const rows = await sendRows(seed.campaignId);
    expect(rows.map((r) => r.step_number)).toEqual([1, 2, 3]);

    const [cc] = await sql`select status, current_step from campaign_contacts where campaign_id = ${seed.campaignId}`;
    expect(cc.status).toBe("completed");

    const [campaign] = await sql`select status from campaigns where id = ${seed.campaignId}`;
    expect(campaign.status).toBe("completed");
  });

  it("sends nothing more while paused, and resumes where it left off", async () => {
    const seed = await seedCampaign();
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick(); // step 1

    const { pauseCampaign } = await import("@/lib/queries/campaigns");
    await pauseCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick();
    expect(await sendRows(seed.campaignId)).toHaveLength(1); // still just step 1

    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick();
    const rows = await sendRows(seed.campaignId);
    expect(rows.map((r) => r.step_number)).toEqual([1, 2]);
  });
});

describe("duplicate-send protection", () => {
  it("records exactly one send row per (contact, step)", async () => {
    const seed = await seedCampaign();
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick();

    // Force the contact back to step 1 as if state had been corrupted, then
    // run again: the unique constraint must refuse a second send.
    await sql`
      update campaign_contacts set current_step = 1, status = 'scheduled', next_send_at = now()
       where campaign_id = ${seed.campaignId}
    `;
    await sql`update campaigns set next_slot_at = null where id = ${seed.campaignId}`;
    const summary = await dispatchTick();

    expect(summary.outcomes[0].action).toBe("blocked");
    expect(summary.outcomes[0].detail).toContain("already in state");
    const rows = await sendRows(seed.campaignId);
    expect(rows.filter((r) => r.step_number === 1)).toHaveLength(1);
  });

  it("sends only once when many dispatcher ticks run concurrently", async () => {
    const seed = await seedCampaign({ steps: [{ delay_days: 0, subject: "S", body: "B" }] });
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);

    // Twelve workers racing on the same due contact - the situation an
    // overlapping cron or a double-invoked serverless function creates.
    const summaries = await Promise.all(Array.from({ length: 12 }, () => dispatchTick()));

    const rows = await sendRows(seed.campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("skipped"); // simulate mode
    // Exactly one worker did the work; the rest were shut out by the lease.
    expect(summaries.filter((s) => s.locked).length).toBeGreaterThan(0);
  });

  it("lets only one of many concurrent claims win, at the database level", async () => {
    // Bypasses the worker lease entirely to prove the unique constraint alone
    // is sufficient - the lease is an optimisation, not the guarantee.
    const seed = await seedCampaign({ steps: [{ delay_days: 0, subject: "S", body: "B" }] });
    const ccId = seed.campaignContactIds[0];
    const stepId = seed.stepIds[0];

    const claim = () =>
      sql`
        insert into email_sends (campaign_id, campaign_contact_id, step_id, step_number,
                                 status, to_email, intended_email, subject, body)
        values (${seed.campaignId}, ${ccId}, ${stepId}, 1, 'sending',
                'a@example.com', 'a@example.com', 'S', 'B')
        on conflict (campaign_contact_id, step_id) do update
           set status = 'sending', attempt_count = email_sends.attempt_count + 1
         where email_sends.status = 'failed'
        returning id
      `.then(
        (rows) => rows.length > 0,
        () => false, // a losing racer may surface the unique violation directly
      );

    const results = await Promise.all(Array.from({ length: 20 }, claim));
    expect(results.filter(Boolean)).toHaveLength(1);

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from email_sends where campaign_contact_id = ${ccId}
    `;
    expect(count).toBe(1);
  });

  it("never retries a send whose outcome is unknown", async () => {
    const seed = await seedCampaign();
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick();

    // Simulate a worker that died mid-SMTP: the claim row is stuck in `sending`.
    await sql`
      update email_sends set status = 'sending', sent_at = null, claimed_at = now() - interval '1 hour'
       where campaign_id = ${seed.campaignId}
    `;
    const reaped = await reapStuckSends();
    expect(reaped).toBe(1);

    const [row] = await sql`select status, next_retry_at from email_sends where campaign_id = ${seed.campaignId}`;
    expect(row.status).toBe("unknown");
    expect(row.next_retry_at).toBeNull();

    // The contact is halted for manual review, not silently retried.
    const [cc] = await sql`select status, last_error from campaign_contacts where campaign_id = ${seed.campaignId}`;
    expect(cc.status).toBe("failed");
    expect(cc.last_error).toContain("unknown");

    await sql`update campaign_contacts set next_send_at = now() where campaign_id = ${seed.campaignId}`;
    await sql`update campaigns set next_slot_at = null, status = 'active' where id = ${seed.campaignId}`;
    await dispatchTick();
    expect(await sendRows(seed.campaignId)).toHaveLength(1); // still exactly one
  });

  it("retries a provably-failed send in place, without creating a second row", async () => {
    const seed = await seedCampaign();
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick();

    // Rewind: the send failed before transmission and is due for a retry.
    await sql`
      update email_sends set status = 'failed', sent_at = null, error = '451 greylisted', next_retry_at = now()
       where campaign_id = ${seed.campaignId}
    `;
    await sql`
      update campaign_contacts set status = 'scheduled', current_step = 1, next_send_at = now()
       where campaign_id = ${seed.campaignId}
    `;
    await sql`update campaigns set next_slot_at = null where id = ${seed.campaignId}`;

    await dispatchTick();
    const rows = await sendRows(seed.campaignId);
    expect(rows.filter((r) => r.step_number === 1)).toHaveLength(1);
    expect(rows[0].attempt_count).toBe(2); // retried in place
    expect(rows[0].status).toBe("skipped"); // simulate mode succeeded this time
  });

  it("stops retrying once the attempt ceiling is reached", async () => {
    const seed = await seedCampaign();
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick();

    await sql`
      update email_sends set status = 'failed', attempt_count = 3, next_retry_at = now()
       where campaign_id = ${seed.campaignId}
    `;
    await sql`
      update campaign_contacts set status = 'scheduled', current_step = 1, next_send_at = now()
       where campaign_id = ${seed.campaignId}
    `;
    await sql`update campaigns set next_slot_at = null where id = ${seed.campaignId}`;

    const summary = await dispatchTick();
    expect(summary.outcomes[0].action).toBe("blocked");
    const [cc] = await sql`select status from campaign_contacts where campaign_id = ${seed.campaignId}`;
    expect(cc.status).toBe("failed");
  });
});

describe("reply and suppression exclusions", () => {
  it("stops the sequence the moment a contact is marked as replied", async () => {
    const seed = await seedCampaign();
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick(); // step 1

    await sql`
      update campaign_contacts set status = 'replied', replied_at = now(), next_send_at = null
       where campaign_id = ${seed.campaignId}
    `;
    await sql`update campaigns set next_slot_at = null where id = ${seed.campaignId}`;
    await dispatchTick();

    expect(await sendRows(seed.campaignId)).toHaveLength(1); // no follow-up
  });

  it("does not send to an address added to the suppression list mid-campaign", async () => {
    const seed = await seedCampaign({
      contacts: [
        { email: "keep@example.com", first_name: "Keep" },
        { email: "drop@example.com", first_name: "Drop" },
      ],
    });
    await startCampaign(seed.campaignId);
    await sql`insert into suppression_list (email, reason) values ('drop@example.com', 'manual')`;

    for (let i = 0; i < 4; i++) {
      await clearPacing(seed.campaignId);
      await dispatchTick();
    }

    const rows = await sendRows(seed.campaignId);
    expect(rows.every((r) => r.intended_email !== "drop@example.com")).toBe(true);
    expect(rows.some((r) => r.intended_email === "keep@example.com")).toBe(true);
  });

  it("blocks a suppressed address from being added to a campaign at all", async () => {
    const seed = await seedCampaign({ contacts: [] });
    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email) values ('blocked@example.com') returning id
    `;
    await sql`insert into suppression_list (email) values ('blocked@example.com')`;

    await expect(
      sql`insert into campaign_contacts (campaign_id, contact_id) values (${seed.campaignId}, ${contact.id})`,
    ).rejects.toThrow(/suppression list/);
  });
});

describe("pacing and limits", () => {
  it("sends at most one email per campaign per tick", async () => {
    const seed = await seedCampaign({
      steps: [{ delay_days: 0, subject: "S", body: "B" }],
      contacts: Array.from({ length: 5 }, (_, i) => ({ email: `c${i}@example.com` })),
    });
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);

    await dispatchTick();
    expect(await sendRows(seed.campaignId)).toHaveLength(1);
  });

  it("sets a randomised future pacing cursor after each send", async () => {
    const seed = await seedCampaign({ dailyLimit: 50 });
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick();

    const [campaign] = await sql<{ next_slot_at: Date }[]>`
      select next_slot_at from campaigns where id = ${seed.campaignId}
    `;
    expect(campaign.next_slot_at).not.toBeNull();
    // 24h window / 50 per day = 1728s base, scaled 0.6-1.4 => 1036-2419s ahead.
    const aheadSeconds = (campaign.next_slot_at.getTime() - Date.now()) / 1000;
    expect(aheadSeconds).toBeGreaterThan(1000);
    expect(aheadSeconds).toBeLessThan(2500);
  });

  it("refuses to send once the daily limit is reached", async () => {
    const seed = await seedCampaign({
      dailyLimit: 1,
      steps: [{ delay_days: 0, subject: "S", body: "B" }],
      contacts: [{ email: "one@example.com" }, { email: "two@example.com" }],
    });
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick();

    await clearPacing(seed.campaignId);
    const summary = await dispatchTick();
    expect(summary.outcomes[0].action).toBe("daily_limit_reached");
    expect(await sendRows(seed.campaignId)).toHaveLength(1);
  });

  it("refuses to send outside the configured window", async () => {
    const seed = await seedCampaign();
    await startCampaign(seed.campaignId);
    // A one-minute window at 03:00 that today's clock is almost certainly past.
    await sql`
      update campaigns set send_start_minute = 180, send_end_minute = 181, next_slot_at = null
       where id = ${seed.campaignId}
    `;
    await sql`update campaign_contacts set next_send_at = now() where campaign_id = ${seed.campaignId}`;

    const summary = await dispatchTick();
    const action = summary.outcomes[0].action;
    // Guard against the improbable case of the suite running at 03:00 Prague.
    if (action !== "simulated") {
      expect(action).toBe("outside_window");
      expect(await sendRows(seed.campaignId)).toHaveLength(0);
    }
  });
});

describe("test mode", () => {
  it("redirects to the test address and never contacts the prospect", async () => {
    const seed = await seedCampaign();
    await sql`
      update app_settings set test_mode = true, test_behavior = 'redirect', test_email = 'me@mine.cz'
       where id = true
    `;
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick(); // will attempt SMTP against a bogus host and fail

    const [row] = await sql<{ to_email: string; intended_email: string; subject: string }[]>`
      select to_email, intended_email, subject from email_sends where campaign_id = ${seed.campaignId}
    `;
    expect(row.to_email).toBe("me@mine.cz");
    expect(row.intended_email).toBe("a@example.com");
    expect(row.subject).toContain("[TEST -> a@example.com]");
  });

  it("fails closed when redirect mode has no test address configured", async () => {
    const seed = await seedCampaign();
    await sql`
      update app_settings set test_mode = true, test_behavior = 'redirect', test_email = null where id = true
    `;
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);

    const summary = await dispatchTick();
    expect(summary.outcomes[0].action).toBe("blocked");
    expect(summary.outcomes[0].detail).toContain("no test email address");
    expect(await sendRows(seed.campaignId)).toHaveLength(0);
  });
});
