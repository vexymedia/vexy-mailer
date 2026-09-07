import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode } from "./helpers/fixtures";
import { createCampaign, createMailbox, drain, makeAllDue, sentToday } from "./helpers/multi-mailbox";

/**
 * Multi-mailbox campaigns: pools, the two independent daily caps, fair
 * allocation and the sticky sender.
 *
 * Runs in simulate mode, so the engine executes end to end without SMTP.
 * Simulated sends consume quota exactly as real ones do, which is what makes
 * these assertions meaningful.
 */

let sql: typeof import("@/lib/db").sql;
let dispatchTick: typeof import("@/lib/engine/dispatch").dispatchTick;
let startCampaign: typeof import("@/lib/queries/campaigns").startCampaign;

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  ({ dispatchTick } = await import("@/lib/engine/dispatch"));
  ({ startCampaign } = await import("@/lib/queries/campaigns"));
});

afterAll(async () => {
  await closeDatabase();
});

function contacts(n: number, prefix = "p"): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}@prospect.test`);
}

async function senderOf(email: string): Promise<string | null> {
  const [row] = await sql<{ sender_mailbox_id: string | null }[]>`
    select cc.sender_mailbox_id from campaign_contacts cc
      join contacts c on c.id = cc.contact_id where c.email = ${email}
  `;
  return row?.sender_mailbox_id ?? null;
}

// --- 1. a campaign can have two or more mailboxes ----------------------
describe("a campaign can send from several mailboxes", () => {
  it("spreads new contacts across the whole pool", async () => {
    const a = await createMailbox({ email: "nela@vexy.cz", dailyLimit: 40 });
    const b = await createMailbox({ email: "karolina@vexy.cz", dailyLimit: 40 });
    const c = await createMailbox({ email: "vojtech@vexy.cz", dailyLimit: 40 });
    const { campaignId } = await createCampaign({
      name: "Pool",
      mailboxIds: [a, b, c],
      contacts: contacts(9),
    });
    await startCampaign(campaignId);
    await drain([campaignId]);

    // Nine contacts, three equal mailboxes, least-utilised-first: 3 each.
    expect([await sentToday(a), await sentToday(b), await sentToday(c)]).toEqual([3, 3, 3]);
  });

  it("refuses to start a campaign whose pool is empty", async () => {
    const { campaignId } = await createCampaign({ name: "Empty", mailboxIds: [], contacts: contacts(1) });
    const result = await startCampaign(campaignId);
    expect(result.ok).toBe(false);
    expect(result.problems.join(" ")).toContain("no sender mailboxes");
  });
});

// --- 2. a migrated single-mailbox campaign still works ------------------
describe("backward compatibility", () => {
  it("keeps a legacy single-mailbox campaign sending after migration", async () => {
    // Recreate the pre-migration shape: campaigns.mailbox_id set, no pool row.
    const mailboxId = await createMailbox({ email: "legacy@vexy.cz", dailyLimit: 40 });
    const [campaign] = await sql<{ id: string }[]>`
      insert into campaigns (name, mailbox_id, daily_limit, send_days,
                             send_start_minute, send_end_minute, timezone)
      values ('Legacy', ${mailboxId}, 100, '{1,2,3,4,5,6,7}', 0, 1440, 'Europe/Prague')
      returning id
    `;
    await sql`
      insert into sequence_steps (campaign_id, step_number, delay_days, subject, body)
      values (${campaign.id}, 1, 0, 'S', 'B')
    `;
    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email) values ('legacy-target@prospect.test') returning id
    `;
    await sql`insert into campaign_contacts (campaign_id, contact_id) values (${campaign.id}, ${contact.id})`;
    await sql`delete from campaign_mailboxes where campaign_id = ${campaign.id}`;

    // The migration's backfill, replayed.
    await sql`
      insert into campaign_mailboxes (campaign_id, mailbox_id)
      select id, mailbox_id from campaigns where id = ${campaign.id} and mailbox_id is not null
      on conflict do nothing
    `;

    expect((await startCampaign(campaign.id)).ok).toBe(true);
    await drain([campaign.id]);
    expect(await sentToday(mailboxId)).toBe(1);
    expect(await senderOf("legacy-target@prospect.test")).toBe(mailboxId);
  });
});

// --- 3. the mailbox cap is global across campaigns ---------------------
describe("global mailbox daily limit", () => {
  it("caps one shared mailbox across two campaigns, never the sum of both", async () => {
    const shared = await createMailbox({ email: "shared@vexy.cz", dailyLimit: 40 });
    const first = await createCampaign({
      name: "A", mailboxIds: [shared], dailyLimit: 40, contacts: contacts(30, "a"),
    });
    const second = await createCampaign({
      name: "B", mailboxIds: [shared], dailyLimit: 40, contacts: contacts(30, "b"),
    });
    await startCampaign(first.campaignId);
    await startCampaign(second.campaignId);

    await drain([first.campaignId, second.campaignId]);

    // Both campaigns would each allow 40. The mailbox allows 40 in total.
    expect(await sentToday(shared)).toBe(40);

    const [split] = await sql<{ a: number; b: number }[]>`
      select count(*) filter (where campaign_id = ${first.campaignId})::int as a,
             count(*) filter (where campaign_id = ${second.campaignId})::int as b
        from email_sends where status in ('sent','unknown','skipped')
    `;
    expect(split.a + split.b).toBe(40);
    expect(split.a).toBeGreaterThan(0);
    expect(split.b).toBeGreaterThan(0);
  });

  it("stops at exactly the limit, never one over", async () => {
    const mailbox = await createMailbox({ email: "tight@vexy.cz", dailyLimit: 3 });
    const { campaignId } = await createCampaign({
      name: "Tight", mailboxIds: [mailbox], contacts: contacts(10),
    });
    await startCampaign(campaignId);
    await drain([campaignId]);
    expect(await sentToday(mailbox)).toBe(3);
  });
});

// --- 4. concurrency cannot exceed the cap ------------------------------
describe("concurrent workers and the mailbox cap", () => {
  it("does not let parallel ticks overshoot the last free slot", async () => {
    const mailbox = await createMailbox({ email: "race@vexy.cz", dailyLimit: 5 });
    // Several campaigns so parallel ticks have independent work to race on.
    const campaigns = [];
    for (let i = 0; i < 4; i++) {
      const c = await createCampaign({
        name: `C${i}`, mailboxIds: [mailbox], contacts: contacts(5, `c${i}-`),
      });
      await startCampaign(c.campaignId);
      campaigns.push(c.campaignId);
    }

    for (let round = 0; round < 8; round++) {
      for (const id of campaigns) await makeAllDue(id);
      await Promise.all(Array.from({ length: 8 }, () => dispatchTick()));
    }

    expect(await sentToday(mailbox)).toBe(5);
  });
});

// --- 5. the campaign cap is independent of mailbox capacity -------------
describe("campaign daily limit", () => {
  it("holds even when the mailboxes have plenty of capacity left", async () => {
    const a = await createMailbox({ email: "big-a@vexy.cz", dailyLimit: 500 });
    const b = await createMailbox({ email: "big-b@vexy.cz", dailyLimit: 500 });
    const { campaignId } = await createCampaign({
      name: "Capped", mailboxIds: [a, b], dailyLimit: 7, contacts: contacts(30),
    });
    await startCampaign(campaignId);
    await drain([campaignId]);

    expect((await sentToday(a)) + (await sentToday(b))).toBe(7);
  });
});

// --- 6. fair allocation ------------------------------------------------
describe("fair allocation of new contacts", () => {
  it("prefers the least-utilised mailbox by ratio, not by raw count", async () => {
    const nela = await createMailbox({ email: "nela@vexy.cz", dailyLimit: 40 });
    const karolina = await createMailbox({ email: "karolina@vexy.cz", dailyLimit: 40 });
    const vojtech = await createMailbox({ email: "vojtech@vexy.cz", dailyLimit: 40 });
    const { campaignId } = await createCampaign({
      name: "Fair", mailboxIds: [nela, karolina, vojtech], contacts: ["fresh@prospect.test"],
    });

    // Pre-load history: Nela 30/40 (75%), Vojtech 20/40 (50%), Karolina 10/40 (25%).
    const other = await createCampaign({ name: "History", mailboxIds: [nela] });
    const [step] = await sql<{ id: string }[]>`
      select id from sequence_steps where campaign_id = ${other.campaignId}
    `;
    for (const [mailboxId, n] of [[nela, 30], [karolina, 10], [vojtech, 20]] as const) {
      for (let i = 0; i < n; i++) {
        const [c] = await sql<{ id: string }[]>`
          insert into contacts (email) values (${`hist-${mailboxId}-${i}@x.test`}) returning id
        `;
        const [cc] = await sql<{ id: string }[]>`
          insert into campaign_contacts (campaign_id, contact_id, sender_mailbox_id)
          values (${other.campaignId}, ${c.id}, ${mailboxId}) returning id
        `;
        await sql`
          insert into email_sends (campaign_id, campaign_contact_id, step_id, step_number, mailbox_id,
                                   status, to_email, intended_email, subject, body, sent_at)
          values (${other.campaignId}, ${cc.id}, ${step.id}, 1, ${mailboxId},
                  'sent', 'x@x.test', 'x@x.test', 'S', 'B', now())
        `;
      }
    }

    await startCampaign(campaignId);
    await makeAllDue(campaignId);
    await dispatchTick();

    // Karolina is least utilised, so the new contact should be hers.
    expect(await senderOf("fresh@prospect.test")).toBe(karolina);
  });

  it("skips mailboxes that are disabled, untested or full", async () => {
    const disabled = await createMailbox({ email: "off@vexy.cz", dailyLimit: 40, enabled: false });
    const untested = await createMailbox({ email: "untested@vexy.cz", dailyLimit: 40, tested: false });
    const usable = await createMailbox({ email: "good@vexy.cz", dailyLimit: 40 });
    const { campaignId } = await createCampaign({
      name: "Filter", mailboxIds: [disabled, untested, usable], contacts: ["pick@prospect.test"],
    });
    await startCampaign(campaignId);
    await makeAllDue(campaignId);
    await dispatchTick();

    expect(await senderOf("pick@prospect.test")).toBe(usable);
  });

  it("breaks ties deterministically, so repeated runs agree", async () => {
    // Two identical, idle mailboxes: the ratio ties, so the tie-break decides.
    // Compared by address rather than id, because ids differ between runs.
    const chosen = new Set<string>();
    for (let run = 0; run < 4; run++) {
      await resetDatabase();
      await enableSimulateMode();
      const a = await createMailbox({ email: "a@vexy.cz", dailyLimit: 40 });
      const b = await createMailbox({ email: "b@vexy.cz", dailyLimit: 40 });
      const { campaignId } = await createCampaign({
        name: "Deterministic", mailboxIds: [a, b], contacts: ["one@prospect.test"],
      });
      await startCampaign(campaignId);
      await makeAllDue(campaignId);
      await dispatchTick();

      const [row] = await sql<{ from_email: string }[]>`
        select m.from_email from campaign_contacts cc
          join contacts c on c.id = cc.contact_id
          join mailboxes m on m.id = cc.sender_mailbox_id
         where c.email = 'one@prospect.test'
      `;
      chosen.add(row?.from_email ?? "none");
    }
    expect(chosen.size).toBe(1);
    expect([...chosen][0]).not.toBe("none");
  });
});

// --- 7 & 8. sticky sender ----------------------------------------------
describe("sticky sender", () => {
  it("sends every follow-up from the mailbox that sent the first email", async () => {
    const a = await createMailbox({ email: "nela@vexy.cz", dailyLimit: 40 });
    const b = await createMailbox({ email: "karolina@vexy.cz", dailyLimit: 40 });
    const { campaignId } = await createCampaign({
      name: "Sticky",
      mailboxIds: [a, b],
      steps: [
        { delay_days: 0, subject: "1", body: "B" },
        { delay_days: 0, subject: "2", body: "B" },
        { delay_days: 0, subject: "3", body: "B" },
      ],
      contacts: ["sticky@prospect.test"],
    });
    await startCampaign(campaignId);
    await drain([campaignId]);

    const sends = await sql<{ mailbox_id: string; step_number: number }[]>`
      select mailbox_id, step_number from email_sends order by step_number
    `;
    expect(sends).toHaveLength(3);
    const senders = new Set(sends.map((s) => s.mailbox_id));
    expect(senders.size).toBe(1); // all three from the same mailbox
    expect(await senderOf("sticky@prospect.test")).toBe([...senders][0]);
  });

  it("makes a follow-up wait rather than moving it to a mailbox with room", async () => {
    const small = await createMailbox({ email: "small@vexy.cz", dailyLimit: 1 });
    const roomy = await createMailbox({ email: "roomy@vexy.cz", dailyLimit: 100 });
    const { campaignId } = await createCampaign({
      name: "Wait",
      // Only `small` is in the pool at first, so the contact is pinned to it.
      mailboxIds: [small],
      steps: [
        { delay_days: 0, subject: "1", body: "B" },
        { delay_days: 0, subject: "2", body: "B" },
      ],
      contacts: ["waiting@prospect.test"],
    });
    await startCampaign(campaignId);
    await makeAllDue(campaignId);
    await dispatchTick(); // step 1 uses up small's single slot

    // Now add a mailbox with plenty of capacity. The follow-up must NOT take it.
    await sql`insert into campaign_mailboxes (campaign_id, mailbox_id) values (${campaignId}, ${roomy})`;
    await drain([campaignId]);

    expect(await sentToday(small)).toBe(1);
    expect(await sentToday(roomy)).toBe(0); // untouched
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from email_sends`;
    expect(count).toBe(1); // the follow-up waited
    expect(await senderOf("waiting@prospect.test")).toBe(small);
  });

  it("holds the thread when the pinned mailbox is disabled, instead of reassigning", async () => {
    const pinned = await createMailbox({ email: "pinned@vexy.cz", dailyLimit: 40 });
    const spare = await createMailbox({ email: "spare@vexy.cz", dailyLimit: 40 });
    const { campaignId } = await createCampaign({
      name: "Disabled",
      mailboxIds: [pinned, spare],
      steps: [
        { delay_days: 0, subject: "1", body: "B" },
        { delay_days: 0, subject: "2", body: "B" },
      ],
      contacts: ["held@prospect.test"],
    });
    await startCampaign(campaignId);
    await makeAllDue(campaignId);
    await dispatchTick();
    const sender = await senderOf("held@prospect.test");

    await sql`update mailboxes set enabled = false where id = ${sender}`;
    await drain([campaignId]);

    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from email_sends`;
    expect(count).toBe(1); // no follow-up went out from anywhere
    expect(await senderOf("held@prospect.test")).toBe(sender); // still pinned

    // Re-enabling resumes it, with no manual intervention.
    await sql`update mailboxes set enabled = true where id = ${sender}`;
    await drain([campaignId]);
    const after = await sql<{ mailbox_id: string }[]>`select mailbox_id from email_sends`;
    expect(after).toHaveLength(2);
    expect(new Set(after.map((r) => r.mailbox_id))).toEqual(new Set([sender]));
  });
});

// --- 15. duplicate protection survives the new sender logic -------------
describe("duplicate protection is unaffected by pools", () => {
  it("still sends each step exactly once under concurrent ticks", async () => {
    const a = await createMailbox({ email: "dup-a@vexy.cz", dailyLimit: 100 });
    const b = await createMailbox({ email: "dup-b@vexy.cz", dailyLimit: 100 });
    const { campaignId } = await createCampaign({
      name: "Dup", mailboxIds: [a, b], contacts: ["dup@prospect.test"],
    });
    await startCampaign(campaignId);
    await makeAllDue(campaignId);

    await Promise.all(Array.from({ length: 12 }, () => dispatchTick()));
    for (let i = 0; i < 5; i++) {
      await makeAllDue(campaignId);
      await dispatchTick();
    }

    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from email_sends`;
    expect(count).toBe(1);
    const [dupes] = await sql<{ n: number }[]>`
      select coalesce(sum(c - 1), 0)::int as n from (
        select count(*) as c from email_sends group by campaign_contact_id, step_id having count(*) > 1
      ) x
    `;
    expect(dupes.n).toBe(0);
  });
});

// --- 16. timezone / quota boundary -------------------------------------
describe("daily quota boundary", () => {
  it("resets in the mailbox's own timezone, not the campaign's", async () => {
    const mailbox = await createMailbox({ email: "tz@vexy.cz", dailyLimit: 2 });
    const { campaignId } = await createCampaign({
      name: "TZ", mailboxIds: [mailbox], contacts: contacts(6),
    });
    await startCampaign(campaignId);
    await drain([campaignId]);
    expect(await sentToday(mailbox)).toBe(2);

    // Push those sends into yesterday, local to the mailbox. The cap frees up.
    await sql`
      update email_sends
         set sent_at = date_trunc('day', now() at time zone 'Europe/Prague') at time zone 'Europe/Prague'
                       - interval '1 hour',
             claimed_at = date_trunc('day', now() at time zone 'Europe/Prague') at time zone 'Europe/Prague'
                       - interval '1 hour'
    `;
    await drain([campaignId]);

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from email_sends
       where coalesce(sent_at, claimed_at)
             >= date_trunc('day', now() at time zone 'Europe/Prague') at time zone 'Europe/Prague'
    `;
    expect(count).toBe(2); // exactly today's allowance again
  });

  it("counts a campaign in a different timezone against the mailbox's own day", async () => {
    const mailbox = await createMailbox({ email: "auckland@vexy.cz", dailyLimit: 2 });
    await sql`update mailboxes set timezone = 'Pacific/Auckland' where id = ${mailbox}`;
    const { campaignId } = await createCampaign({
      name: "Cross-zone", mailboxIds: [mailbox], contacts: contacts(5),
    });
    await sql`update campaigns set timezone = 'America/Los_Angeles' where id = ${campaignId}`;
    await startCampaign(campaignId);
    await drain([campaignId]);

    // The mailbox limit binds regardless of the campaign's zone.
    expect(await sentToday(mailbox)).toBe(2);
  });
});
