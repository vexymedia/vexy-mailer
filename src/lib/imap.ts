import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { decryptSecret } from "./crypto";
import type { Mailbox } from "./types";

export interface InboxMessage {
  uid: number;
  messageId: string | null;
  inReplyTo: string | null;
  /** The full References chain, space separated, as it arrived. */
  references: string | null;
  from: string | null;
  /** The address the prospect actually wrote to - which of our aliases they used. */
  to: string | null;
  subject: string | null;
  receivedAt: Date;
  /** Plain-text body. The UI renders this and never the HTML. */
  bodyText: string | null;
  /** Kept for completeness; deliberately never rendered without sanitisation. */
  bodyHtml: string | null;
}

/** Bodies are capped so one enormous message cannot blow up a worker tick. */
const MAX_BODY_BYTES = 256 * 1024;
const MAX_STORED_CHARS = 64 * 1024;

/** Envelope dates arrive as either a Date or an RFC 2822 string. */
function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function hasImapConfigured(mailbox: Mailbox): boolean {
  return Boolean(mailbox.imap_host && mailbox.imap_port && mailbox.imap_username && mailbox.imap_password_enc);
}

export function buildImapClient(mailbox: Mailbox): ImapFlow {
  if (!hasImapConfigured(mailbox)) {
    throw new Error(`Mailbox "${mailbox.name}" has no IMAP configuration.`);
  }
  return new ImapFlow({
    host: mailbox.imap_host!,
    port: mailbox.imap_port!,
    secure: mailbox.imap_secure,
    auth: { user: mailbox.imap_username!, pass: decryptSecret(mailbox.imap_password_enc!) },
    logger: false,
    // Keep the worker's wall-clock cost bounded; a slow inbox is retried next tick.
    socketTimeout: 60_000,
    greetingTimeout: 20_000,
  });
}

export interface FetchResult {
  messages: InboxMessage[];
  uidNext: number;
  uidValidity: number;
}

/**
 * Reads new INBOX messages after `lastUid`.
 *
 * On the first run for a mailbox (`lastUid` null) it looks back over the most
 * recent messages rather than the entire history: enough to catch replies that
 * arrived while the mailbox was being set up, without a multi-thousand message
 * scan on a long-lived inbox.
 */
export async function fetchNewMessages(
  mailbox: Mailbox,
  lastUid: number | null,
  lookbackOnFirstRun = 200,
): Promise<FetchResult> {
  const client = buildImapClient(mailbox);
  await client.connect();
  const lock = await client.getMailboxLock("INBOX");
  try {
    const box = client.mailbox;
    if (!box || typeof box === "boolean") throw new Error("Could not open INBOX");

    const uidNext = Number(box.uidNext ?? 1);
    const uidValidity = Number(box.uidValidity ?? 0);

    // A UIDVALIDITY change means the server renumbered everything; the stored
    // cursor is meaningless and must not be trusted.
    const validityChanged =
      mailbox.imap_uidvalidity != null && Number(mailbox.imap_uidvalidity) !== uidValidity;

    const startUid = validityChanged
      ? Math.max(1, uidNext - lookbackOnFirstRun)
      : lastUid != null
        ? lastUid + 1
        : Math.max(1, uidNext - lookbackOnFirstRun);

    const messages: InboxMessage[] = [];
    if (startUid < uidNext) {
      for await (const message of client.fetch(
        `${startUid}:*`,
        { uid: true, envelope: true, internalDate: true, source: { maxLength: MAX_BODY_BYTES } },
        { uid: true },
      )) {
        // IMAP's "N:*" always returns at least the final message even when N
        // is past the end, so the range has to be re-checked here.
        if (message.uid < startUid) continue;
        const envelope = message.envelope;

        // MIME is genuinely hard - multipart, transfer encodings, charsets -
        // so the parsing is delegated rather than hand-rolled. A parse failure
        // must not lose the message: the envelope alone is still useful.
        let bodyText: string | null = null;
        let bodyHtml: string | null = null;
        let references: string | null = null;
        if (message.source) {
          try {
            const parsed = await simpleParser(message.source);
            bodyText = parsed.text ? parsed.text.slice(0, MAX_STORED_CHARS) : null;
            bodyHtml = typeof parsed.html === "string" ? parsed.html.slice(0, MAX_STORED_CHARS) : null;
            references = Array.isArray(parsed.references)
              ? parsed.references.join(" ")
              : (parsed.references ?? null);
          } catch (error) {
            bodyText = null;
            console.error("[imap] could not parse message body", message.uid, error);
          }
        }

        messages.push({
          uid: Number(message.uid),
          messageId: envelope?.messageId ?? null,
          inReplyTo: envelope?.inReplyTo ?? null,
          references,
          from: envelope?.from?.[0]?.address?.toLowerCase() ?? null,
          to: envelope?.to?.[0]?.address?.toLowerCase() ?? null,
          subject: envelope?.subject ?? null,
          receivedAt: toDate(message.internalDate) ?? toDate(envelope?.date) ?? new Date(),
          bodyText,
          bodyHtml,
        });
      }
    }

    return { messages, uidNext, uidValidity };
  } finally {
    lock.release();
    await client.logout().catch(() => client.close());
  }
}

/** Opens INBOX and closes again, to validate credentials from the UI. */
export async function testImapConnection(mailbox: Mailbox): Promise<{ ok: boolean; error?: string }> {
  let client: ImapFlow | null = null;
  try {
    client = buildImapClient(mailbox);
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    lock.release();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client?.logout().catch(() => client?.close());
  }
}
