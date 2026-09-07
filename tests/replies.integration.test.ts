import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, enableSimulateMode, seedCampaign } from "./helpers/fixtures";
import type { InboxMessage } from "@/lib/imap";

/**
 * Exercises the whole reply pipeline against a real database. Only the IMAP
 * network round trip is stubbed - matching, deduplication, sequence removal
 * and cursor bookkeeping all run for real.
 */

const inbox = vi.hoisted(() => ({ messages: [] as InboxMessage[], uidNext: 1, uidValidity: 1 }));

vi.mock("@/lib/imap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/imap")>();
  return {
    ...actual,
    fetchNewMessages: vi.fn(async () => ({
      messages: inbox.messages,
      uidNext: inbox.uidNext,
      uidValidity: inbox.uidValidity,
    })),
  };
});

function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    uid: 10,
    messageId: `<incoming-${Math.random()}@mail.example.com>`,
    inReplyTo: null,
    from: "a@example.com",
    subject: "Re: Hi Ann",
    receivedAt: new Date(),
    ...overrides,
  };
}

async function enableImap(mailboxId: string) {
  const { sql } = await import("@/lib/db");
  const { encryptSecret } = await import("@/lib/crypto");
  await sql`
    update mailboxes
       set imap_host = 'imap.example.com', imap_port = 993, imap_username = 'sender@example.com',
           imap_password_enc = ${encryptSecret("secret")}, imap_secure = true
     where id = ${mailboxId}
  `;
}

let sql: typeof import("@/lib/db").sql;

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  inbox.messages = [];
  inbox.uidNext = 100;
  inbox.uidValidity = 1;
});

afterAll(async () => {
  await closeDatabase();
});

async function sendStepOne(campaignId: string) {
  const { dispatchTick } = await import("@/lib/engine/dispatch");
  await clearPacing(campaignId);
  await dispatchTick();
}

describe("reply detection", () => {
  it("matches a reply by its In-Reply-To header and stops the sequence", async () => {
    const seed = await seedCampaign();
    await enableImap(seed.mailboxId);
    const { startCampaign } = await import("@/lib/queries/campaigns");
    await startCampaign(seed.campaignId);
    await sendStepOne(seed.campaignId);

    // Simulate mode records no message_id, so set one as a real send would.
    await sql`update email_sends set message_id = '<step1@example.com>' where campaign_id = ${seed.campaignId}`;
    inbox.messages = [message({ inReplyTo: "<step1@example.com>", from: "someone-else@elsewhere.com" })];

    const { pollReplies } = await import("@/lib/engine/replies");
    const summary = await pollReplies(true);
    expect(summary.mailboxes[0].matched).toBe(1);

    const [cc] = await sql`select status, next_send_at, replied_at from campaign_contacts where campaign_id = ${seed.campaignId}`;
    expect(cc.status).toBe("replied");
    expect(cc.next_send_at).toBeNull();
    expect(cc.replied_at).not.toBeNull();
  });

  it("matches by sender address when threading headers are missing", async () => {
    const seed = await seedCampaign();
    await enableImap(seed.mailboxId);
    const { startCampaign } = await import("@/lib/queries/campaigns");
    await startCampaign(seed.campaignId);
    await sendStepOne(seed.campaignId);
    await sql`update email_sends set status = 'sent' where campaign_id = ${seed.campaignId}`;

    inbox.messages = [message({ from: "a@example.com", inReplyTo: null })];
    const { pollReplies } = await import("@/lib/engine/replies");
    expect((await pollReplies(true)).mailboxes[0].matched).toBe(1);

    const [cc] = await sql`select status from campaign_contacts where campaign_id = ${seed.campaignId}`;
    expect(cc.status).toBe("replied");
  });

  it("sends no further follow-up after a reply", async () => {
    const seed = await seedCampaign();
    await enableImap(seed.mailboxId);
    const { startCampaign } = await import("@/lib/queries/campaigns");
    const { dispatchTick } = await import("@/lib/engine/dispatch");
    await startCampaign(seed.campaignId);
    await sendStepOne(seed.campaignId);
    await sql`update email_sends set status = 'sent' where campaign_id = ${seed.campaignId}`;

    inbox.messages = [message({ from: "a@example.com" })];
    const { pollReplies } = await import("@/lib/engine/replies");
    await pollReplies(true);

    // Try hard to make a follow-up go out anyway.
    for (let i = 0; i < 5; i++) {
      await sql`update campaigns set next_slot_at = null where id = ${seed.campaignId}`;
      await dispatchTick();
    }
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int as count from email_sends where campaign_id = ${seed.campaignId}
    `;
    expect(count).toBe(1);
  });

  it("processes the same physical message only once", async () => {
    const seed = await seedCampaign();
    await enableImap(seed.mailboxId);
    const { startCampaign } = await import("@/lib/queries/campaigns");
    await startCampaign(seed.campaignId);
    await sendStepOne(seed.campaignId);
    await sql`update email_sends set status = 'sent' where campaign_id = ${seed.campaignId}`;

    const duplicate = message({ from: "a@example.com", messageId: "<same@mail.com>" });
    const { pollReplies } = await import("@/lib/engine/replies");

    inbox.messages = [duplicate];
    await pollReplies(true);
    inbox.messages = [duplicate]; // the server hands it to us again
    await pollReplies(true);

    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from replies`;
    expect(count).toBe(1);
  });

  it("ignores our own outgoing mail", async () => {
    const seed = await seedCampaign();
    await enableImap(seed.mailboxId);
    inbox.messages = [message({ from: "sender@example.com" })];

    const { pollReplies } = await import("@/lib/engine/replies");
    await pollReplies(true);
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int as count from replies`;
    expect(count).toBe(0);
  });

  it("records a reply from an unknown sender without touching any campaign", async () => {
    const seed = await seedCampaign();
    await enableImap(seed.mailboxId);
    inbox.messages = [message({ from: "stranger@nowhere.com" })];

    const { pollReplies } = await import("@/lib/engine/replies");
    const summary = await pollReplies(true);
    expect(summary.mailboxes[0].matched).toBe(0);

    const [reply] = await sql`select contact_id, campaign_contact_id from replies`;
    expect(reply.contact_id).toBeNull();
    expect(reply.campaign_contact_id).toBeNull();
  });

  it("advances the IMAP cursor so messages are not rescanned", async () => {
    const seed = await seedCampaign();
    await enableImap(seed.mailboxId);
    inbox.messages = [message({ uid: 42 })];
    inbox.uidNext = 43;

    const { pollReplies } = await import("@/lib/engine/replies");
    await pollReplies(true);

    const [mailbox] = await sql`select imap_last_uid, imap_uidvalidity, imap_last_error from mailboxes where id = ${seed.mailboxId}`;
    expect(Number(mailbox.imap_last_uid)).toBe(42);
    expect(Number(mailbox.imap_uidvalidity)).toBe(1);
    expect(mailbox.imap_last_error).toBeNull();
  });

  it("records an IMAP failure on the mailbox instead of throwing", async () => {
    const seed = await seedCampaign();
    await enableImap(seed.mailboxId);
    const imap = await import("@/lib/imap");
    vi.mocked(imap.fetchNewMessages).mockRejectedValueOnce(new Error("Invalid credentials"));

    const { pollReplies } = await import("@/lib/engine/replies");
    const summary = await pollReplies(true);
    expect(summary.mailboxes[0].error).toContain("Invalid credentials");

    const [mailbox] = await sql`select imap_last_error from mailboxes where id = ${seed.mailboxId}`;
    expect(mailbox.imap_last_error).toContain("Invalid credentials");
  });

  it("skips mailboxes with no IMAP configuration", async () => {
    await seedCampaign(); // SMTP only
    const { pollReplies } = await import("@/lib/engine/replies");
    expect((await pollReplies(true)).mailboxes).toEqual([]);
  });
});

describe("a reply stops every sequence the contact is in", () => {
  it("removes the contact from other campaigns too", async () => {
    const seed = await seedCampaign();
    await enableImap(seed.mailboxId);
    const { startCampaign } = await import("@/lib/queries/campaigns");
    await startCampaign(seed.campaignId);
    await sendStepOne(seed.campaignId);
    await sql`update email_sends set message_id = '<s1@example.com>', status = 'sent'
               where campaign_id = ${seed.campaignId}`;

    // The same person, enrolled in a second campaign.
    const second = await seedCampaign({ contacts: [] });
    const [contact] = await sql<{ id: string }[]>`select id from contacts where email = 'a@example.com'`;
    await sql`insert into campaign_contacts (campaign_id, contact_id, status, next_send_at)
              values (${second.campaignId}, ${contact.id}, 'scheduled', now())`;

    inbox.messages = [message({ inReplyTo: "<s1@example.com>", from: "a@example.com" })];
    const { pollReplies } = await import("@/lib/engine/replies");
    await pollReplies(true);

    const rows = await sql<{ status: string }[]>`
      select status from campaign_contacts where contact_id = ${contact.id}
    `;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "replied")).toBe(true);
  });
});
