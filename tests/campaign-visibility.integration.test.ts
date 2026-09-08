import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { createMailbox } from "./helpers/multi-mailbox";

/**
 * Regression: a campaign must never disappear from the UI because of how its
 * sender is configured.
 *
 * campaigns.mailbox_id was deprecated by the multi-mailbox migration and is
 * NULL for every campaign created since. Any query that joins through it
 * silently drops those campaigns - which is how a live, actively sending
 * campaign vanished from /campaigns while its contacts and activity log
 * remained perfectly visible.
 */

let sql: typeof import("@/lib/db").sql;
let listCampaignStats: typeof import("@/lib/queries/dashboard").listCampaignStats;

beforeEach(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  ({ listCampaignStats } = await import("@/lib/queries/dashboard"));
});

afterAll(async () => {
  await closeDatabase();
});

/** A campaign in the shape the app creates today: no legacy mailbox_id. */
async function poolCampaign(name: string, mailboxIds: string[], dailyLimit = 3): Promise<string> {
  const [campaign] = await sql<{ id: string }[]>`
    insert into campaigns (name, status, daily_limit, mailbox_id, send_days,
                           send_start_minute, send_end_minute, timezone)
    values (${name}, 'active', ${dailyLimit}, null, '{1,2,3,4,5}', 480, 960, 'Europe/Prague')
    returning id
  `;
  for (const mailboxId of mailboxIds) {
    await sql`insert into campaign_mailboxes (campaign_id, mailbox_id) values (${campaign.id}, ${mailboxId})`;
  }
  return campaign.id;
}

/** A campaign in the pre-migration shape, with the backfilled pool row. */
async function legacyCampaign(name: string, mailboxId: string): Promise<string> {
  const [campaign] = await sql<{ id: string }[]>`
    insert into campaigns (name, status, daily_limit, mailbox_id, send_days,
                           send_start_minute, send_end_minute, timezone)
    values (${name}, 'active', 10, ${mailboxId}, '{1,2,3,4,5}', 480, 960, 'Europe/Prague')
    returning id
  `;
  await sql`insert into campaign_mailboxes (campaign_id, mailbox_id) values (${campaign.id}, ${mailboxId})`;
  return campaign.id;
}

describe("campaigns are listed regardless of how their sender is configured", () => {
  it("lists a multi-mailbox campaign whose legacy mailbox_id is NULL", async () => {
    // The exact production shape: mailbox_id NULL, two rows in the sender pool.
    const nela = await createMailbox({ email: "nela@vexy.cz" });
    const karolina = await createMailbox({ email: "karolina@vexy.cz" });
    const id = await poolCampaign("QA MULTI MAILBOX", [nela, karolina]);

    const rows = await listCampaignStats();
    expect(rows.map((r) => r.name)).toContain("QA MULTI MAILBOX");

    const campaign = rows.find((r) => r.id === id)!;
    expect(campaign.mailbox_names).toEqual(
      expect.arrayContaining(["karolina@vexy.cz", "nela@vexy.cz"]),
    );
    expect(campaign.mailbox_names).toHaveLength(2);
  });

  it("lists a legacy single-mailbox campaign", async () => {
    const nela = await createMailbox({ email: "nela@vexy.cz" });
    await legacyCampaign("LEGACY SINGLE", nela);

    const rows = await listCampaignStats();
    expect(rows.map((r) => r.name)).toContain("LEGACY SINGLE");
    expect(rows[0].mailbox_names).toEqual(["nela@vexy.cz"]);
  });

  it("lists a single-mailbox campaign created the new way", async () => {
    const nela = await createMailbox({ email: "nela@vexy.cz" });
    await poolCampaign("NEW SINGLE", [nela]);

    const rows = await listCampaignStats();
    expect(rows.map((r) => r.name)).toContain("NEW SINGLE");
  });

  it("lists every campaign shape side by side, losing none", async () => {
    const nela = await createMailbox({ email: "nela@vexy.cz" });
    const karolina = await createMailbox({ email: "karolina@vexy.cz" });
    await legacyCampaign("legacy", nela);
    await poolCampaign("new-single", [nela]);
    await poolCampaign("new-multi", [nela, karolina]);

    const rows = await listCampaignStats();
    expect(rows.map((r) => r.name).sort()).toEqual(["legacy", "new-multi", "new-single"]);
  });

  it("still lists a campaign whose sender pool is empty, rather than hiding it", async () => {
    // A campaign nobody can send from is a problem to surface, not to conceal:
    // hiding it is exactly the failure mode this test exists to prevent.
    await poolCampaign("NO SENDERS", []);

    const rows = await listCampaignStats();
    expect(rows.map((r) => r.name)).toContain("NO SENDERS");
    expect(rows[0].mailbox_names).toEqual([]);
  });

  it("reports contact and send counters for a pool campaign", async () => {
    // The counters live behind the same query, so a broken join zeroed these
    // on the campaign detail page too.
    const nela = await createMailbox({ email: "nela@vexy.cz" });
    const id = await poolCampaign("counted", [nela]);
    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email) values ('c@prospect.test') returning id
    `;
    await sql`insert into campaign_contacts (campaign_id, contact_id) values (${id}, ${contact.id})`;

    const [row] = await listCampaignStats();
    expect(row.contacts).toBe(1);
    expect(row.remaining).toBe(1);
  });
});

describe("deleting a mailbox accounts for the sender pool", () => {
  it("refuses to delete a mailbox that is in a campaign's pool", async () => {
    // The old guard counted campaigns.mailbox_id, which is NULL for every
    // campaign created since the migration, so it saw nothing and let the
    // delete through to a raw foreign-key error.
    const karolina = await createMailbox({ email: "karolina@vexy.cz" });
    await poolCampaign("uses karolina", [karolina]);

    const { deleteMailbox } = await import("@/lib/queries/mailboxes");
    const result = await deleteMailbox(karolina);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("campaign");

    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from mailboxes`;
    expect(count).toBe(1); // still there
  });

  it("refuses to delete a mailbox a contact is pinned to", async () => {
    const nela = await createMailbox({ email: "nela@vexy.cz" });
    const other = await createMailbox({ email: "other@vexy.cz" });
    const id = await poolCampaign("pinned", [other]);
    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email) values ('p@prospect.test') returning id
    `;
    await sql`
      insert into campaign_contacts (campaign_id, contact_id, sender_mailbox_id)
      values (${id}, ${contact.id}, ${nela})
    `;

    const { deleteMailbox } = await import("@/lib/queries/mailboxes");
    const result = await deleteMailbox(nela);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/pinned|contact/i);
  });

  it("still deletes a mailbox nothing refers to", async () => {
    const unused = await createMailbox({ email: "unused@vexy.cz" });
    const { deleteMailbox } = await import("@/lib/queries/mailboxes");
    expect((await deleteMailbox(unused)).ok).toBe(true);

    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from mailboxes`;
    expect(count).toBe(0);
  });
});
