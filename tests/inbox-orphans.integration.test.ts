import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { createMailbox } from "./helpers/multi-mailbox";

/**
 * Deletion semantics for the unified inbox.
 *
 * The rules this file pins down, and why:
 *
 *   1. `replies` is the IMAP detection ledger. `messages` is the conversation
 *      record. Deleting a reply must NOT erase conversation history - the
 *      outbound emails and the prospect's answer are the thing of value, and
 *      silently destroying them to tidy a ledger row would be data loss.
 *
 *   2. The inbox lists a conversation only while it still HAS an inbound
 *      message. Visibility is derived from the messages themselves, never from
 *      the denormalised last_inbound_at column, which no deletion path
 *      recomputes and which is what left orphans on screen.
 *
 *   3. Losing a campaign does not hide a conversation. The exchange happened;
 *      it is shown with no campaign attached rather than disappearing.
 *
 *   4. Removing a conversation is an explicit operator action. It deletes the
 *      conversation and its messages and nothing else - contacts, campaign
 *      contacts, email_sends and replies are all left alone.
 */

let sql: typeof import("@/lib/db").sql;
let listConversations: typeof import("@/lib/queries/inbox").listConversations;

beforeEach(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  ({ listConversations } = await import("@/lib/queries/inbox"));
});

afterAll(async () => {
  await closeDatabase();
});

/** Rebuilds what the migration's backfill produces for an old QA reply. */
async function historicConversation() {
  const mailboxId = await createMailbox({ email: "karolina@vexy.cz" });
  const [contact] = await sql<{ id: string }[]>`
    insert into contacts (email, first_name) values ('old-lead@prospect.test', 'Old') returning id
  `;
  const [campaign] = await sql<{ id: string }[]>`
    insert into campaigns (name, status, mailbox_id) values ('OLD QA', 'completed', null) returning id
  `;
  await sql`insert into campaign_mailboxes (campaign_id, mailbox_id) values (${campaign.id}, ${mailboxId})`;
  const [cc] = await sql<{ id: string }[]>`
    insert into campaign_contacts (campaign_id, contact_id, status)
    values (${campaign.id}, ${contact.id}, 'replied') returning id
  `;
  const [reply] = await sql<{ id: string }[]>`
    insert into replies (mailbox_id, contact_id, campaign_contact_id, from_email, subject, imap_message_id)
    values (${mailboxId}, ${contact.id}, ${cc.id}, 'old-lead@prospect.test', 'Re: old', '<old@prospect.test>')
    returning id
  `;
  const [conversation] = await sql<{ id: string }[]>`
    insert into conversations (mailbox_id, contact_id, campaign_id, campaign_contact_id,
                               subject, last_inbound_at, unread_count)
    values (${mailboxId}, ${contact.id}, ${campaign.id}, ${cc.id}, 'Re: old', now(), 1)
    returning id
  `;
  await sql`
    insert into messages (conversation_id, direction, kind, from_email, to_email, subject,
                          message_id, reply_id, occurred_at, is_read)
    values (${conversation.id}, 'inbound', 'incoming', 'old-lead@prospect.test', 'karolina@vexy.cz',
            'Re: old', '<old@prospect.test>', ${reply.id}, now(), false)
  `;
  return { mailboxId, contactId: contact.id, campaignId: campaign.id, conversationId: conversation.id, replyId: reply.id };
}

describe("deleting a reply does not destroy conversation history", () => {
  it("keeps the conversation and its message, detaching only the ledger link", async () => {
    const { conversationId } = await historicConversation();
    await sql`delete from replies`;

    const [message] = await sql<{ reply_id: string | null }[]>`
      select reply_id from messages where conversation_id = ${conversationId}
    `;
    expect(message).toBeDefined(); // history survives on purpose
    expect(message.reply_id).toBeNull(); // ON DELETE SET NULL

    // And it is still a real conversation with a real inbound message, so it
    // legitimately stays in the inbox.
    expect((await listConversations()).map((c) => c.id)).toContain(conversationId);
  });
});

describe("a conversation with no inbound message left is not shown", () => {
  it("disappears from the inbox once its inbound messages are gone", async () => {
    const { conversationId } = await historicConversation();
    expect((await listConversations()).map((c) => c.id)).toContain(conversationId);

    await sql`delete from messages where conversation_id = ${conversationId} and direction = 'inbound'`;

    // last_inbound_at is still set - nothing recomputes it - so a query that
    // trusts that column would still list this. Visibility must come from the
    // messages that actually exist.
    const [row] = await sql<{ last_inbound_at: Date | null }[]>`
      select last_inbound_at from conversations where id = ${conversationId}
    `;
    expect(row.last_inbound_at).not.toBeNull();

    expect((await listConversations()).map((c) => c.id)).not.toContain(conversationId);
  });

  it("does not show a conversation that only ever had outbound messages", async () => {
    // Created by a campaign send before the prospect has answered.
    const mailboxId = await createMailbox({ email: "nela@vexy.cz" });
    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email) values ('quiet@prospect.test') returning id
    `;
    const [conversation] = await sql<{ id: string }[]>`
      insert into conversations (mailbox_id, contact_id, subject)
      values (${mailboxId}, ${contact.id}, 'Hello') returning id
    `;
    await sql`
      insert into messages (conversation_id, direction, kind, from_email, to_email, subject, occurred_at)
      values (${conversation.id}, 'outbound', 'campaign', 'nela@vexy.cz', 'quiet@prospect.test', 'Hello', now())
    `;
    expect((await listConversations()).map((c) => c.id)).not.toContain(conversation.id);
  });
});

describe("losing the campaign does not hide the conversation", () => {
  it("keeps it visible with no campaign attached", async () => {
    const { conversationId } = await historicConversation();
    await sql`delete from campaigns`;

    const [row] = await sql<{ campaign_id: string | null; campaign_contact_id: string | null }[]>`
      select campaign_id, campaign_contact_id from conversations where id = ${conversationId}
    `;
    expect(row.campaign_id).toBeNull();
    expect(row.campaign_contact_id).toBeNull();

    const listed = await listConversations();
    expect(listed.map((c) => c.id)).toContain(conversationId);
    expect(listed.find((c) => c.id === conversationId)!.campaign_name).toBeNull();
  });
});

describe("removing a conversation is explicit and narrow", () => {
  it("deletes the conversation and its messages, and nothing else", async () => {
    const { conversationId, contactId, campaignId } = await historicConversation();
    // A campaign send, to prove the sending ledger is left alone.
    const [step] = await sql<{ id: string }[]>`
      insert into sequence_steps (campaign_id, step_number, delay_days, subject, body)
      values (${campaignId}, 1, 0, 'S', 'B') returning id
    `;
    const [cc] = await sql<{ id: string }[]>`
      select id from campaign_contacts where campaign_id = ${campaignId}
    `;
    await sql`
      insert into email_sends (campaign_id, campaign_contact_id, step_id, step_number, status,
                               to_email, intended_email, subject, body, sent_at)
      values (${campaignId}, ${cc.id}, ${step.id}, 1, 'sent',
              'old-lead@prospect.test', 'old-lead@prospect.test', 'S', 'B', now())
    `;

    const { deleteConversation } = await import("@/lib/queries/inbox");
    await deleteConversation(conversationId);

    expect(await listConversations()).toHaveLength(0);
    const [counts] = await sql<
      { conversations: number; messages: number; contacts: number; sends: number; campaign_contacts: number }[]
    >`
      select (select count(*)::int from conversations) as conversations,
             (select count(*)::int from messages) as messages,
             (select count(*)::int from contacts) as contacts,
             (select count(*)::int from email_sends) as sends,
             (select count(*)::int from campaign_contacts) as campaign_contacts
    `;
    expect(counts.conversations).toBe(0);
    expect(counts.messages).toBe(0);
    // Everything else is untouched: the send history is the audit trail that
    // stops a contact being emailed twice, and must survive inbox tidying.
    expect(counts.contacts).toBe(1);
    expect(counts.sends).toBe(1);
    expect(counts.campaign_contacts).toBe(1);
    expect(contactId).toBeTruthy();
  });

  it("does not resurrect the contact into the sequence", async () => {
    const { conversationId, campaignId } = await historicConversation();
    const { deleteConversation } = await import("@/lib/queries/inbox");
    await deleteConversation(conversationId);

    const [cc] = await sql<{ status: string }[]>`
      select status from campaign_contacts where campaign_id = ${campaignId}
    `;
    expect(cc.status).toBe("replied"); // still stopped
  });
});
