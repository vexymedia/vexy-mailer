import { randomUUID } from "node:crypto";
import { sql } from "../db";
import { env } from "../env";
import { logActivity } from "../activity";
import { fetchNewMessages, hasImapConfigured, type InboxMessage } from "../imap";
import { withLock } from "./locks";
import type { Mailbox } from "../types";
import { recordInboundMessage } from "../queries/inbox";

/**
 * Reply detection.
 *
 * Matching is attempted in two passes, strongest signal first:
 *
 *   1. In-Reply-To against the Message-ID we minted for a specific send. This
 *      is exact: it identifies the campaign, the contact and the step.
 *   2. The sender's address against our contacts. Less precise but catches
 *      clients that drop threading headers, forwarded replies and replies sent
 *      from an alias-free "reply all".
 *
 * Either way the effect is the same and immediate: the contact is marked
 * replied and drops out of every remaining follow-up.
 */

const REPLY_LOCK_TTL_MS = 120_000;

export interface ReplyPollSummary {
  ranAt: string;
  locked?: boolean;
  mailboxes: {
    mailboxId: string;
    name: string;
    scanned: number;
    matched: number;
    error?: string;
  }[];
}

interface MatchTarget {
  campaign_contact_id: string;
  contact_id: string;
  campaign_id: string;
  send_id: string | null;
}

/**
 * Pass 1: the reply quotes a Message-ID we generated.
 *
 * Both In-Reply-To and the whole References chain are considered. Some clients
 * drop In-Reply-To but keep References, and a reply several messages deep in a
 * thread points at the most recent message rather than the first.
 */
async function matchByThread(message: InboxMessage): Promise<MatchTarget | null> {
  const raw = [message.inReplyTo, ...(message.references ?? "").split(/\s+/)].filter(Boolean) as string[];
  if (raw.length === 0) return null;

  // Normalise: some clients strip the angle brackets, some keep them.
  const candidates = [...new Set(raw.flatMap((id) => [id, `<${id.replace(/^<|>$/g, "")}>`]))];
  const [row] = await sql<MatchTarget[]>`
    select es.campaign_contact_id, es.campaign_id, es.id as send_id, cc.contact_id
      from email_sends es
      join campaign_contacts cc on cc.id = es.campaign_contact_id
     where es.message_id = any(${candidates})
     order by es.sent_at desc nulls last
     limit 1
  `;
  return row ?? null;
}

/** Pass 2: the sender is a contact with at least one email already sent. */
async function matchBySender(message: InboxMessage, mailboxId: string): Promise<MatchTarget | null> {
  if (!message.from) return null;
  const [row] = await sql<MatchTarget[]>`
    select cc.id as campaign_contact_id, cc.contact_id, cc.campaign_id, null::uuid as send_id
      from campaign_contacts cc
      join contacts c   on c.id = cc.contact_id
      join campaigns cp on cp.id = cc.campaign_id
     where c.email = ${message.from}
       and cp.mailbox_id = ${mailboxId}
       and exists (
         select 1 from email_sends es
          where es.campaign_contact_id = cc.id and es.status in ('sent', 'unknown')
       )
     order by cc.updated_at desc
     limit 1
  `;
  return row ?? null;
}

async function findContactId(email: string | null): Promise<string | null> {
  if (!email) return null;
  const [row] = await sql<{ id: string }[]>`select id from contacts where email = ${email}`;
  return row?.id ?? null;
}

async function processMailbox(mailbox: Mailbox): Promise<ReplyPollSummary["mailboxes"][number]> {
  const base = { mailboxId: mailbox.id, name: mailbox.name };
  try {
    const lastUid = mailbox.imap_last_uid != null ? Number(mailbox.imap_last_uid) : null;
    const { messages, uidNext, uidValidity } = await fetchNewMessages(mailbox, lastUid);

    let matched = 0;
    let highestUid = lastUid ?? 0;

    for (const message of messages) {
      highestUid = Math.max(highestUid, message.uid);

      // Ignore our own mail: sent copies, and any bounce addressed from us.
      if (message.from && message.from === mailbox.from_email) continue;
      if (!message.messageId) continue;

      const target = (await matchByThread(message)) ?? (await matchBySender(message, mailbox.id));
      const contactId = target?.contact_id ?? (await findContactId(message.from));

      // Record the reply first. The unique (mailbox_id, imap_message_id) index
      // makes re-processing the same physical message a no-op.
      const inserted = await sql<{ id: string }[]>`
        insert into replies (mailbox_id, contact_id, campaign_contact_id, matched_send_id,
                             from_email, subject, imap_message_id, in_reply_to, imap_uid, received_at)
        values (${mailbox.id}, ${contactId}, ${target?.campaign_contact_id ?? null},
                ${target?.send_id ?? null}, ${message.from ?? "unknown"}, ${message.subject},
                ${message.messageId}, ${message.inReplyTo}, ${message.uid}, ${message.receivedAt})
        on conflict (mailbox_id, imap_message_id) do nothing
        returning id
      `;
      if (inserted.length === 0) continue; // already seen

      // Persist into the unified inbox. Only possible when we know who wrote:
      // a conversation is keyed on (mailbox, contact).
      if (contactId) {
        await recordInboundMessage({
          mailboxId: mailbox.id,
          contactId,
          campaignId: target?.campaign_id ?? null,
          campaignContactId: target?.campaign_contact_id ?? null,
          fromEmail: message.from ?? "unknown",
          toEmail: message.to ?? mailbox.from_email,
          subject: message.subject,
          bodyText: message.bodyText,
          bodyHtml: message.bodyHtml,
          messageId: message.messageId,
          inReplyTo: message.inReplyTo,
          references: message.references,
          replyId: inserted[0].id,
          receivedAt: message.receivedAt,
        });
      }

      if (!target) continue; // a reply from someone who is not in a campaign

      // Immediate removal from the sequence: next_send_at is cleared, so the
      // dispatcher's candidate query can never pick this contact up again.
      //
      // Every campaign this person is in stops, not only the one the reply was
      // matched to. Somebody who has answered should not then receive a cold
      // email from a different sequence, and the matched campaign is not always
      // the one they care about.
      const updated = await sql<{ id: string }[]>`
        update campaign_contacts
           set status = 'replied', replied_at = now(), next_send_at = null, updated_at = now()
         where contact_id = ${target.contact_id}
           and status in ('pending', 'scheduled', 'sent', 'failed')
        returning id
      `;
      if (updated.length > 0) {
        matched++;
        await logActivity({
          action: "Reply detected",
          detail: `${message.from} replied${message.subject ? `: "${message.subject}"` : ""}. Removed from the sequence.`,
          campaignId: target.campaign_id,
          contactId: target.contact_id,
          campaignContactId: target.campaign_contact_id,
        });
      }
    }

    await sql`
      update mailboxes
         set imap_last_uid = ${Math.max(highestUid, uidNext - 1)},
             imap_uidvalidity = ${uidValidity},
             imap_last_checked_at = now(),
             imap_last_error = null,
             updated_at = now()
       where id = ${mailbox.id}
    `;

    return { ...base, scanned: messages.length, matched };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await sql`
      update mailboxes
         set imap_last_checked_at = now(), imap_last_error = ${detail.slice(0, 1000)}, updated_at = now()
       where id = ${mailbox.id}
    `;
    await logActivity({
      level: "error",
      action: "IMAP error",
      detail: `${mailbox.name}: ${detail}`,
    });
    return { ...base, scanned: 0, matched: 0, error: detail };
  }
}

/**
 * Polls every configured mailbox whose last check is older than the interval.
 * Rate-limiting per mailbox rather than globally means one slow inbox does not
 * starve the others.
 */
export async function pollReplies(force = false): Promise<ReplyPollSummary> {
  const holder = randomUUID();
  const result = await withLock("replies", REPLY_LOCK_TTL_MS, holder, async () => {
    const mailboxes = await sql<Mailbox[]>`
      select * from mailboxes
       where imap_host is not null
         and (${force} or imap_last_checked_at is null
              or imap_last_checked_at < now() - ${`${Math.ceil(env.replyPollIntervalMs / 1000)} seconds`}::interval)
    `;
    const results: ReplyPollSummary["mailboxes"] = [];
    for (const mailbox of mailboxes) {
      if (!hasImapConfigured(mailbox)) continue;
      results.push(await processMailbox(mailbox));
    }
    return results;
  });

  if ("skipped" in result) {
    return { ranAt: new Date().toISOString(), locked: true, mailboxes: [] };
  }
  return { ranAt: new Date().toISOString(), mailboxes: result };
}
