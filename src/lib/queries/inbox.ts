import type { Sql, TransactionSql } from "postgres";
import { sql } from "../db";
import type { Classification, ConversationRow, MessageRow, ConversationDetail } from "../types";

type Db = Sql | TransactionSql;

/**
 * The unified inbox: one conversation per (mailbox, contact) pair, holding
 * every message in both directions.
 *
 * Keyed on the pair rather than on the campaign because that is what the
 * prospect experiences - one exchange with one person - even when we happen to
 * have them enrolled in more than one campaign.
 */

/** Finds or creates the conversation a message belongs to. */
export async function ensureConversation(
  db: Db,
  input: {
    mailboxId: string;
    contactId: string;
    campaignId?: string | null;
    campaignContactId?: string | null;
    subject?: string | null;
  },
): Promise<string> {
  const [row] = await db<{ id: string }[]>`
    insert into conversations (mailbox_id, contact_id, campaign_id, campaign_contact_id, subject)
    values (${input.mailboxId}, ${input.contactId}, ${input.campaignId ?? null},
            ${input.campaignContactId ?? null}, ${input.subject ?? null})
    on conflict (mailbox_id, contact_id) do update
       set campaign_id = coalesce(conversations.campaign_id, excluded.campaign_id),
           campaign_contact_id = coalesce(conversations.campaign_contact_id, excluded.campaign_contact_id),
           subject = coalesce(conversations.subject, excluded.subject),
           updated_at = now()
    returning id
  `;
  return row.id;
}

export interface OutboundMessageInput {
  mailboxId: string;
  contactId: string;
  campaignId?: string | null;
  campaignContactId?: string | null;
  kind: "campaign" | "manual_reply";
  fromEmail: string;
  toEmail: string;
  subject: string;
  bodyText: string;
  messageId: string | null;
  inReplyTo?: string | null;
  references?: string | null;
  emailSendId?: string | null;
  occurredAt?: Date;
}

/**
 * Mirrors an email we sent into the conversation thread.
 *
 * Never throws: a bookkeeping failure must not be able to unwind a send that
 * already left the building.
 */
export async function recordOutboundMessage(input: OutboundMessageInput): Promise<void> {
  try {
    const conversationId = await ensureConversation(sql, {
      mailboxId: input.mailboxId,
      contactId: input.contactId,
      campaignId: input.campaignId,
      campaignContactId: input.campaignContactId,
      subject: input.subject,
    });
    const occurredAt = input.occurredAt ?? new Date();
    await sql`
      insert into messages (conversation_id, direction, kind, from_email, to_email, subject,
                            body_text, message_id, in_reply_to, message_references,
                            email_send_id, occurred_at, is_read)
      values (${conversationId}, 'outbound', ${input.kind}, ${input.fromEmail}, ${input.toEmail},
              ${input.subject}, ${input.bodyText}, ${input.messageId}, ${input.inReplyTo ?? null},
              ${input.references ?? null}, ${input.emailSendId ?? null}, ${occurredAt}, true)
      on conflict do nothing
    `;
    await sql`
      update conversations
         set last_message_at = greatest(last_message_at, ${occurredAt}), updated_at = now()
       where id = ${conversationId}
    `;
  } catch (error) {
    console.error("[inbox] could not record outbound message", error);
  }
}

export interface InboundMessageInput {
  mailboxId: string;
  contactId: string;
  campaignId?: string | null;
  campaignContactId?: string | null;
  fromEmail: string;
  toEmail: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  messageId: string;
  inReplyTo?: string | null;
  references?: string | null;
  replyId?: string | null;
  receivedAt: Date;
}

/** Stores an incoming reply and marks the conversation unread. */
export async function recordInboundMessage(input: InboundMessageInput): Promise<void> {
  const conversationId = await ensureConversation(sql, {
    mailboxId: input.mailboxId,
    contactId: input.contactId,
    campaignId: input.campaignId,
    campaignContactId: input.campaignContactId,
    subject: input.subject,
  });
  const inserted = await sql<{ id: string }[]>`
    insert into messages (conversation_id, direction, kind, from_email, to_email, subject,
                          body_text, body_html, message_id, in_reply_to, message_references,
                          reply_id, occurred_at, is_read)
    values (${conversationId}, 'inbound', 'incoming', ${input.fromEmail}, ${input.toEmail},
            ${input.subject}, ${input.bodyText}, ${input.bodyHtml}, ${input.messageId},
            ${input.inReplyTo ?? null}, ${input.references ?? null}, ${input.replyId ?? null},
            ${input.receivedAt}, false)
    on conflict (conversation_id, message_id) where message_id is not null do nothing
    returning id
  `;
  if (inserted.length === 0) return; // already stored

  await sql`
    update conversations
       set last_message_at = greatest(last_message_at, ${input.receivedAt}),
           last_inbound_at = greatest(coalesce(last_inbound_at, ${input.receivedAt}), ${input.receivedAt}),
           unread_count = unread_count + 1,
           updated_at = now()
     where id = ${conversationId}
  `;
}

export interface InboxFilters {
  filter?: "all" | "unread" | "positive" | "needs_action";
  campaignId?: string | null;
  mailboxId?: string | null;
  search?: string | null;
}

/** The inbox list. One row per conversation, newest activity first. */
export async function listConversations(filters: InboxFilters = {}): Promise<ConversationRow[]> {
  const search = filters.search?.trim() ? `%${filters.search.trim().toLowerCase()}%` : null;
  const filter = filters.filter ?? "all";
  return sql<ConversationRow[]>`
    select cv.id, cv.unread_count, cv.classification, cv.last_message_at, cv.last_inbound_at,
           cv.subject,
           c.email as contact_email,
           trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) as contact_name,
           c.company,
           cp.name as campaign_name,
           cv.campaign_id,
           mb.from_email as mailbox_email,
           mb.id as mailbox_id,
           (select m.to_email from messages m
             where m.conversation_id = cv.id and m.direction = 'inbound'
             order by m.occurred_at desc limit 1) as replied_to_email,
           (select count(*)::int from messages m where m.conversation_id = cv.id) as message_count
      from conversations cv
      join contacts c on c.id = cv.contact_id
      join mailboxes mb on mb.id = cv.mailbox_id
      left join campaigns cp on cp.id = cv.campaign_id
     -- Visibility is derived from the messages that actually exist, not from
     -- last_inbound_at. Nothing recomputes that column when messages or the
     -- replies behind them are deleted, so trusting it left conversations with
     -- no inbound message at all sitting in the inbox.
     where exists (
             select 1 from messages m
              where m.conversation_id = cv.id and m.direction = 'inbound'
           )
       and (${filter} <> 'unread' or cv.unread_count > 0)
       and (${filter} <> 'positive' or cv.classification = 'positive')
       and (${filter} <> 'needs_action'
            or cv.classification in ('unclassified', 'positive', 'later'))
       and (${filters.campaignId ?? null}::uuid is null or cv.campaign_id = ${filters.campaignId ?? null}::uuid)
       and (${filters.mailboxId ?? null}::uuid is null or cv.mailbox_id = ${filters.mailboxId ?? null}::uuid)
       and (${search}::text is null
            or lower(c.email) like ${search}
            or lower(coalesce(c.company, '')) like ${search}
            or lower(coalesce(c.first_name, '')) like ${search}
            or lower(coalesce(c.last_name, '')) like ${search})
     order by cv.last_message_at desc
     limit 300
  `;
}

export async function getConversation(id: string): Promise<ConversationDetail | null> {
  const [conversation] = await sql<ConversationDetail[]>`
    select cv.id, cv.classification, cv.unread_count, cv.subject, cv.campaign_id,
           cv.campaign_contact_id, cv.contact_id, cv.mailbox_id,
           c.email as contact_email,
           trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')) as contact_name,
           c.company, c.website,
           cp.name as campaign_name,
           mb.from_email as mailbox_email, mb.from_name as mailbox_from_name, mb.enabled as mailbox_enabled,
           cc.status as contact_status
      from conversations cv
      join contacts c on c.id = cv.contact_id
      join mailboxes mb on mb.id = cv.mailbox_id
      left join campaigns cp on cp.id = cv.campaign_id
      left join campaign_contacts cc on cc.id = cv.campaign_contact_id
     where cv.id = ${id}
  `;
  return conversation ?? null;
}

export async function listMessages(conversationId: string): Promise<MessageRow[]> {
  return sql<MessageRow[]>`
    select id, direction, kind, from_email, to_email, subject, body_text,
           message_id, in_reply_to, occurred_at, is_read
      from messages
     where conversation_id = ${conversationId}
     order by occurred_at asc, created_at asc
  `;
}

export async function markConversationRead(id: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`update messages set is_read = true where conversation_id = ${id} and is_read = false`;
    await tx`update conversations set unread_count = 0, updated_at = now() where id = ${id}`;
  });
}

/**
 * Removes a conversation from the inbox, deliberately.
 *
 * Deletes the conversation and its messages and nothing else. Contacts,
 * campaign contacts, email_sends and replies are all left intact: email_sends
 * in particular is the ledger that stops a contact being emailed the same step
 * twice, so tidying the inbox must never touch it.
 *
 * This exists because no other deletion reaches a conversation. Removing a
 * reply detaches the ledger link but keeps the history (by design), and
 * removing a campaign only nulls the campaign columns - so without an explicit
 * action an operator has no safe way to clear a stale thread.
 */
export async function deleteConversation(id: string): Promise<void> {
  const [conversation] = await sql<{ contact_email: string; mailbox_email: string }[]>`
    select c.email as contact_email, m.from_email as mailbox_email
      from conversations cv
      join contacts c on c.id = cv.contact_id
      join mailboxes m on m.id = cv.mailbox_id
     where cv.id = ${id}
  `;
  // messages cascade from conversations.
  await sql`delete from conversations where id = ${id}`;
  if (conversation) {
    const { logActivity } = await import("../activity");
    await logActivity({
      level: "warn",
      action: "Conversation deleted",
      detail:
        `Removed the inbox thread between ${conversation.mailbox_email} and ` +
        `${conversation.contact_email}. Send history and contact records were not affected.`,
    });
  }
}

export async function setClassification(id: string, classification: Classification): Promise<void> {
  await sql`
    update conversations set classification = ${classification}, updated_at = now() where id = ${id}
  `;
}

/**
 * The headers a reply needs to land in the same thread in the recipient's mail
 * client. In-Reply-To points at the message being answered; References carries
 * the whole chain, which is what Gmail and Outlook actually group on.
 */
export interface ThreadHeaders {
  inReplyTo: string | null;
  references: string | null;
  subject: string;
}

export async function buildReplyHeaders(conversationId: string): Promise<ThreadHeaders> {
  const messages = await sql<
    { message_id: string | null; message_references: string | null; subject: string | null; direction: string }[]
  >`
    select message_id, message_references, subject, direction
      from messages where conversation_id = ${conversationId}
     order by occurred_at asc, created_at asc
  `;

  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");
  const target = lastInbound ?? [...messages].reverse()[0];

  // References is the accumulated chain: everything we know, in order, deduped.
  const chain: string[] = [];
  for (const message of messages) {
    for (const id of (message.message_references ?? "").split(/\s+/)) {
      if (id && !chain.includes(id)) chain.push(id);
    }
    if (message.message_id && !chain.includes(message.message_id)) chain.push(message.message_id);
  }

  const baseSubject = (target?.subject ?? "").replace(/^((re|fwd?|odp)\s*:\s*)+/i, "").trim();
  return {
    inReplyTo: target?.message_id ?? null,
    references: chain.length > 0 ? chain.join(" ") : null,
    subject: baseSubject ? `Re: ${baseSubject}` : "Re:",
  };
}

export interface InboxCounts {
  all: number;
  unread: number;
  positive: number;
  needs_action: number;
}

export async function getInboxCounts(): Promise<InboxCounts> {
  const [row] = await sql<InboxCounts[]>`
    select count(*)::int as all,
           count(*) filter (where unread_count > 0)::int as unread,
           count(*) filter (where classification = 'positive')::int as positive,
           count(*) filter (where classification in ('unclassified','positive','later'))::int as needs_action
      from conversations cv
     where exists (
             select 1 from messages m
              where m.conversation_id = cv.id and m.direction = 'inbound'
           )
  `;
  return row;
}

/**
 * Sends a human reply from inside a conversation.
 *
 * Three rules this enforces:
 *
 *   1. It goes out from the conversation's own mailbox, using that mailbox's
 *      stored credentials. Answering from a different address would break the
 *      thread and confuse the prospect about who they are talking to.
 *   2. It carries In-Reply-To and References, so Gmail, Outlook and Seznam all
 *      file it under the existing thread rather than starting a new one.
 *   3. It is NOT written to email_sends. That table is the campaign ledger and
 *      the thing the daily cap counts; a human answering a human must never be
 *      blocked because a cold-email quota ran out.
 *
 * Test mode still applies - a manual reply is a real email, and development
 * must not be able to reach a real prospect.
 */
export async function sendManualReply(
  conversationId: string,
  bodyText: string,
): Promise<{ ok: boolean; error?: string }> {
  const { getSettings } = await import("../settings");
  const { sendMail, generateMessageId } = await import("../smtp");
  const { textToHtml } = await import("../template");
  const { logActivity } = await import("../activity");

  const conversation = await getConversation(conversationId);
  if (!conversation) return { ok: false, error: "Conversation not found." };

  const [mailbox] = await sql<import("../types").Mailbox[]>`
    select * from mailboxes where id = ${conversation.mailbox_id}
  `;
  if (!mailbox) return { ok: false, error: "The sender mailbox no longer exists." };
  if (!mailbox.enabled) return { ok: false, error: "The sender mailbox is disabled." };

  const settings = await getSettings();
  let to = conversation.contact_email;
  let subjectPrefix = "";
  if (settings.test_mode) {
    if (settings.test_behavior === "simulate") {
      return { ok: false, error: "Test mode is set to simulate, so no reply can actually be sent." };
    }
    if (!settings.test_email) {
      return { ok: false, error: "Test mode is on but no test address is configured." };
    }
    to = settings.test_email;
    subjectPrefix = `[TEST -> ${conversation.contact_email}] `;
  }

  const headers = await buildReplyHeaders(conversationId);
  const messageId = generateMessageId(mailbox.from_email);
  const subject = subjectPrefix + headers.subject;

  const result = await sendMail(mailbox, {
    to,
    subject,
    text: bodyText,
    html: textToHtml(bodyText),
    messageId,
    inReplyTo: headers.inReplyTo,
    references: headers.references,
  });

  if (!result.ok) {
    await logActivity({
      level: "error",
      action: "Manual reply failed",
      detail: `${mailbox.from_email} -> ${conversation.contact_email}: ${result.message}`,
      campaignId: conversation.campaign_id,
      contactId: conversation.contact_id,
    });
    return { ok: false, error: result.message };
  }

  await recordOutboundMessage({
    mailboxId: mailbox.id,
    contactId: conversation.contact_id,
    campaignId: conversation.campaign_id,
    campaignContactId: conversation.campaign_contact_id,
    kind: "manual_reply",
    fromEmail: mailbox.from_email,
    toEmail: conversation.contact_email,
    subject,
    bodyText,
    messageId: result.messageId,
    inReplyTo: headers.inReplyTo,
    references: headers.references,
  });

  await sql`update mailboxes set last_send_at = now() where id = ${mailbox.id}`;
  await logActivity({
    action: "Manual reply sent",
    detail: `${mailbox.from_email} -> ${conversation.contact_email} - "${subject}"`,
    campaignId: conversation.campaign_id,
    contactId: conversation.contact_id,
    campaignContactId: conversation.campaign_contact_id,
  });

  return { ok: true };
}
