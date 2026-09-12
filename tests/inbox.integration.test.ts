import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { createCampaign, createMailbox, makeAllDue, sentToday } from "./helpers/multi-mailbox";
import type { InboxMessage } from "@/lib/imap";

/**
 * The unified inbox: reply persistence, thread matching, conversation history
 * and manual replies.
 *
 * Only the IMAP network round trip and the SMTP send are stubbed; matching,
 * conversation bookkeeping, threading headers and quota accounting all run for
 * real against the database.
 */

const inbox = vi.hoisted(() => ({ messages: [] as InboxMessage[], uidNext: 100, uidValidity: 1 }));
const sentMail = vi.hoisted(() => [] as Record<string, unknown>[]);

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

vi.mock("@/lib/smtp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/smtp")>();
  return {
    ...actual,
    sendMail: vi.fn(async (mailbox: { from_email: string }, request: Record<string, unknown>) => {
      sentMail.push({ from: mailbox.from_email, ...request });
      return { ok: true as const, messageId: request.messageId as string, response: "250 ok" };
    }),
  };
});

let sql: typeof import("@/lib/db").sql;
let dispatchTick: typeof import("@/lib/engine/dispatch").dispatchTick;
let pollReplies: typeof import("@/lib/engine/replies").pollReplies;
let startCampaign: typeof import("@/lib/queries/campaigns").startCampaign;

beforeEach(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  ({ dispatchTick } = await import("@/lib/engine/dispatch"));
  ({ pollReplies } = await import("@/lib/engine/replies"));
  ({ startCampaign } = await import("@/lib/queries/campaigns"));
  inbox.messages = [];
  sentMail.length = 0;
  // Live mode: sendMail is stubbed, so nothing leaves the process.
  await sql`update app_settings set test_mode = false where id = true`;
});

afterAll(async () => {
  await closeDatabase();
});

function incoming(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    uid: 42,
    messageId: `<in-${Math.random()}@prospect.test>`,
    inReplyTo: null,
    references: null,
    from: "lead@prospect.test",
    to: "nela@vexy.cz",
    subject: "Re: Quick question",
    receivedAt: new Date(),
    bodyText: "Sounds interesting, can we talk Thursday?",
    bodyHtml: "<p>Sounds interesting</p>",
    ...overrides,
  };
}

/** An active campaign whose one contact has already been emailed once. */
async function conversationFixture() {
  const mailboxId = await createMailbox({ email: "nela@vexy.cz", dailyLimit: 40 });
  await sql`
    update mailboxes set imap_host = 'imap.example.com', imap_port = 993,
                         imap_username = 'nela@vexy.cz', imap_password_enc = 'v1:x:y:z'
     where id = ${mailboxId}
  `;
  const { campaignId } = await createCampaign({
    name: "Outreach",
    mailboxIds: [mailboxId],
    steps: [
      { delay_days: 0, subject: "Quick question", body: "Hello there" },
      { delay_days: 0, subject: "Following up", body: "Just checking" },
    ],
    contacts: ["lead@prospect.test"],
  });
  await startCampaign(campaignId);
  await makeAllDue(campaignId);
  await dispatchTick();

  const [send] = await sql<{ message_id: string }[]>`
    select message_id from email_sends where status = 'sent'
  `;
  return { mailboxId, campaignId, outboundMessageId: send.message_id };
}

// --- 11. incoming messages are persisted -------------------------------
describe("reply persistence", () => {
  it("stores an incoming reply as a conversation message", async () => {
    const { mailboxId, campaignId, outboundMessageId } = await conversationFixture();
    inbox.messages = [incoming({ inReplyTo: outboundMessageId })];
    await pollReplies(true);

    const [conversation] = await sql<
      { id: string; unread_count: number; classification: string; campaign_id: string }[]
    >`select id, unread_count, classification, campaign_id from conversations`;
    expect(conversation.unread_count).toBe(1);
    expect(conversation.classification).toBe("unclassified");
    expect(conversation.campaign_id).toBe(campaignId);

    const messages = await sql<
      { direction: string; kind: string; body_text: string; from_email: string; to_email: string }[]
    >`select direction, kind, body_text, from_email, to_email from messages order by occurred_at`;
    expect(messages.map((m) => m.direction)).toEqual(["outbound", "inbound"]);
    expect(messages[1].body_text).toContain("Sounds interesting");
    expect(messages[1].from_email).toBe("lead@prospect.test");

    // The whole exchange is attributed to the right mailbox.
    const [cv] = await sql<{ mailbox_id: string }[]>`select mailbox_id from conversations`;
    expect(cv.mailbox_id).toBe(mailboxId);
  });

  it("keeps HTML out of the field the UI renders", async () => {
    const { outboundMessageId } = await conversationFixture();
    inbox.messages = [
      incoming({
        inReplyTo: outboundMessageId,
        bodyText: "plain text version",
        bodyHtml: '<script>alert(1)</script><p>hi</p>',
      }),
    ];
    await pollReplies(true);

    const [message] = await sql<{ body_text: string; body_html: string }[]>`
      select body_text, body_html from messages where direction = 'inbound'
    `;
    // body_text is what the conversation view prints; the HTML is stored but
    // never rendered, so the script tag cannot reach a browser.
    expect(message.body_text).toBe("plain text version");
    expect(message.body_text).not.toContain("<script>");
    expect(message.body_html).toContain("<script>");
  });

  it("does not store the same physical message twice", async () => {
    const { outboundMessageId } = await conversationFixture();
    const message = incoming({ inReplyTo: outboundMessageId, messageId: "<same@prospect.test>" });
    inbox.messages = [message];
    await pollReplies(true);
    inbox.messages = [message];
    await pollReplies(true);

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from messages where direction = 'inbound'
    `;
    expect(count).toBe(1);
  });
});

// --- 9. replies match the right mailbox, campaign, contact and thread ---
describe("thread matching", () => {
  it("matches on In-Reply-To", async () => {
    const { campaignId, outboundMessageId } = await conversationFixture();
    inbox.messages = [incoming({ inReplyTo: outboundMessageId, from: "someone-else@prospect.test" })];
    const summary = await pollReplies(true);
    expect(summary.mailboxes[0].matched).toBe(1);

    const [cv] = await sql<{ campaign_id: string }[]>`select campaign_id from conversations`;
    expect(cv.campaign_id).toBe(campaignId);
  });

  it("matches on the References chain when In-Reply-To is missing", async () => {
    const { outboundMessageId } = await conversationFixture();
    inbox.messages = [
      incoming({
        inReplyTo: null,
        references: `<older@somewhere.test> ${outboundMessageId}`,
        from: "assistant@prospect.test",
      }),
    ];
    expect((await pollReplies(true)).mailboxes[0].matched).toBe(1);
  });

  it("falls back to the sender address for mail with no threading headers", async () => {
    await conversationFixture();
    inbox.messages = [incoming({ inReplyTo: null, references: null })];
    expect((await pollReplies(true)).mailboxes[0].matched).toBe(1);
  });
});

// --- 10. a reply stops the sequence ------------------------------------
describe("replies stop automation", () => {
  it("sends no further follow-up once a reply is detected", async () => {
    const { campaignId, outboundMessageId } = await conversationFixture();
    inbox.messages = [incoming({ inReplyTo: outboundMessageId })];
    await pollReplies(true);

    for (let i = 0; i < 5; i++) {
      await makeAllDue(campaignId);
      await dispatchTick();
    }
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from email_sends`;
    expect(count).toBe(1);

    const [cc] = await sql<{ status: string }[]>`select status from campaign_contacts`;
    expect(cc.status).toBe("replied");
  });

  it("does not put the contact back into the sequence after a manual reply", async () => {
    const { campaignId, outboundMessageId } = await conversationFixture();
    inbox.messages = [incoming({ inReplyTo: outboundMessageId })];
    await pollReplies(true);

    const { sendManualReply } = await import("@/lib/queries/inbox");
    const [cv] = await sql<{ id: string }[]>`select id from conversations`;
    expect((await sendManualReply(cv.id, "Thursday works.")).ok).toBe(true);

    for (let i = 0; i < 5; i++) {
      await makeAllDue(campaignId);
      await dispatchTick();
    }
    const [cc] = await sql<{ status: string }[]>`select status from campaign_contacts`;
    expect(cc.status).toBe("replied");
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from email_sends`;
    expect(count).toBe(1);
  });
});

// --- 12, 13, 14. manual replies ----------------------------------------
describe("manual replies", () => {
  async function replyFixture() {
    const fixture = await conversationFixture();
    inbox.messages = [incoming({ inReplyTo: fixture.outboundMessageId })];
    await pollReplies(true);
    const [cv] = await sql<{ id: string }[]>`select id from conversations`;
    sentMail.length = 0;
    return { ...fixture, conversationId: cv.id };
  }

  it("goes out from the mailbox that owns the conversation", async () => {
    const { conversationId } = await replyFixture();
    const { sendManualReply } = await import("@/lib/queries/inbox");
    expect((await sendManualReply(conversationId, "Thanks!")).ok).toBe(true);

    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].from).toBe("nela@vexy.cz");
    expect(sentMail[0].to).toBe("lead@prospect.test");
  });

  it("carries In-Reply-To and a References chain", async () => {
    const { conversationId, outboundMessageId } = await replyFixture();
    const { sendManualReply } = await import("@/lib/queries/inbox");
    await sendManualReply(conversationId, "Thanks!");

    const sent = sentMail[0];
    const [inboundId] = (
      await sql<{ message_id: string }[]>`
        select message_id from messages where direction = 'inbound'
      `
    ).map((r) => r.message_id);

    // Answers the prospect's message, and the chain includes our original.
    expect(sent.inReplyTo).toBe(inboundId);
    expect(String(sent.references)).toContain(outboundMessageId);
    expect(String(sent.references)).toContain(inboundId);
    expect(String(sent.subject)).toMatch(/^Re: /);
    // No "Re: Re: Re:" pile-up.
    expect(String(sent.subject)).not.toMatch(/Re:\s*Re:/i);
  });

  it("appears in the conversation immediately", async () => {
    const { conversationId } = await replyFixture();
    const { sendManualReply, listMessages } = await import("@/lib/queries/inbox");
    await sendManualReply(conversationId, "Thursday works for me.");

    const messages = await listMessages(conversationId);
    expect(messages.map((m) => m.direction)).toEqual(["outbound", "inbound", "outbound"]);
    expect(messages[2].kind).toBe("manual_reply");
    expect(messages[2].body_text).toBe("Thursday works for me.");
  });

  it("does not consume the mailbox's automated daily quota", async () => {
    const { conversationId, mailboxId } = await replyFixture();
    const before = await sentToday(mailboxId);

    const { sendManualReply } = await import("@/lib/queries/inbox");
    for (let i = 0; i < 5; i++) await sendManualReply(conversationId, `Reply ${i}`);

    expect(await sentToday(mailboxId)).toBe(before);
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from messages where kind = 'manual_reply'
    `;
    expect(count).toBe(5);
  });

  it("is not blocked when the automated quota is exhausted", async () => {
    const { conversationId, mailboxId } = await replyFixture();
    await sql`update mailboxes set daily_limit = 1 where id = ${mailboxId}`;
    expect(await sentToday(mailboxId)).toBeGreaterThanOrEqual(1); // cap already used

    const { sendManualReply } = await import("@/lib/queries/inbox");
    expect((await sendManualReply(conversationId, "Still answering.")).ok).toBe(true);
  });

  it("refuses to send from a disabled mailbox", async () => {
    const { conversationId, mailboxId } = await replyFixture();
    await sql`update mailboxes set enabled = false where id = ${mailboxId}`;
    const { sendManualReply } = await import("@/lib/queries/inbox");
    const result = await sendManualReply(conversationId, "Hello?");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("vypnutá");
    expect(sentMail).toHaveLength(0);
  });

  it("respects test mode instead of reaching the prospect", async () => {
    const { conversationId } = await replyFixture();
    await sql`
      update app_settings set test_mode = true, test_behavior = 'redirect', test_email = 'me@mine.cz'
       where id = true
    `;
    const { sendManualReply } = await import("@/lib/queries/inbox");
    expect((await sendManualReply(conversationId, "Test")).ok).toBe(true);

    expect(sentMail[0].to).toBe("me@mine.cz");
    expect(String(sentMail[0].subject)).toContain("[TEST -> lead@prospect.test]");
  });
});

// --- conversation classification ---------------------------------------
describe("classification", () => {
  it("is set by hand and shows up in the inbox filters", async () => {
    const { outboundMessageId } = await conversationFixture();
    inbox.messages = [incoming({ inReplyTo: outboundMessageId })];
    await pollReplies(true);

    const { setClassification, listConversations, getInboxCounts } = await import("@/lib/queries/inbox");
    const [cv] = await sql<{ id: string }[]>`select id from conversations`;
    await setClassification(cv.id, "positive");

    expect((await listConversations({ filter: "positive" }))).toHaveLength(1);
    expect((await listConversations({ filter: "unread" }))).toHaveLength(1);
    expect((await getInboxCounts()).positive).toBe(1);

    const { markConversationRead } = await import("@/lib/queries/inbox");
    await markConversationRead(cv.id);
    expect((await listConversations({ filter: "unread" }))).toHaveLength(0);
  });
});
