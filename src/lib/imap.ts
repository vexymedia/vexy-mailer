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


/**
 * Turns an IMAP failure into a specific, safe, human reason.
 *
 * imapflow reports EVERY rejected IMAP command as the message "Command failed"
 * - a wrong password and a missing INBOX are indistinguishable by `.message`
 * alone. The diagnosis lives on other properties of the error:
 *
 *   authenticationFailed  true when the server refused the credentials
 *   serverResponseCode    the bracketed code, e.g. AUTHENTICATIONFAILED
 *   responseText          the server's own words
 *   executedCommand       which command was rejected
 *
 * Reading only `.message` is what left "Command failed" on screen with no way
 * to tell an expired password from a TLS mismatch.
 *
 * The returned text is shown in the UI and stored on the mailbox row, so it
 * must never contain a credential. Only server-provided text and our own
 * wording are used, and the result is scrubbed of anything password-shaped
 * before it is returned.
 */
export interface ImapFailure {
  /** Short machine-ish category, useful for grouping and for tests. */
  kind:
    | "auth_failed"
    | "tls_failed"
    | "connection_failed"
    | "timeout"
    | "select_inbox_failed"
    | "command_rejected"
    | "unknown";
  /** Sanitised, specific, human-readable reason. Safe to display and store. */
  message: string;
}

interface RawImapError {
  message?: string;
  code?: string;
  errno?: number;
  syscall?: string;
  authenticationFailed?: boolean;
  serverResponseCode?: string;
  responseText?: string;
  executedCommand?: string;
  mailboxMissing?: boolean;
}

/** Belt and braces: never let a secret reach a log or the UI. */
function redact(text: string, secrets: (string | null | undefined)[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) safe = safe.split(secret).join("***");
  }
  return safe;
}

const TLS_HINTS = [
  "wrong version number",
  "ssl routines",
  "packet length too long",
  "self-signed certificate",
  "self signed certificate",
  "unable to verify",
  "certificate has expired",
  "altnames",
];

export function classifyImapError(error: unknown, secrets: (string | null | undefined)[] = []): ImapFailure {
  const err = (error ?? {}) as RawImapError;
  const raw = `${err.message ?? ""} ${err.responseText ?? ""}`.toLowerCase();
  const detail = err.responseText ? `: ${err.responseText}` : "";

  // The server explicitly refused the credentials.
  if (err.authenticationFailed || err.serverResponseCode === "AUTHENTICATIONFAILED") {
    return {
      kind: "auth_failed",
      message: redact(
        `Authentication failed - the IMAP username or password was rejected by the server${detail}`,
        secrets,
      ),
    };
  }

  if (err.code === "ETIMEDOUT" || raw.includes("timeout")) {
    return { kind: "timeout", message: "Connection timed out while talking to the IMAP server" };
  }

  if (err.code?.startsWith("ERR_TLS") || err.code === "ERR_SSL_WRONG_VERSION_NUMBER" ||
      TLS_HINTS.some((hint) => raw.includes(hint))) {
    return {
      kind: "tls_failed",
      message: redact(
        `TLS connection failed - check the port and the Require TLS setting (993 uses TLS, 143 does not)${detail}`,
        secrets,
      ),
    };
  }

  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ECONNRESET"].includes(err.code ?? "")) {
    return {
      kind: "connection_failed",
      message: `Could not reach the IMAP server (${err.code}) - check the host and port`,
    };
  }

  // Authentication succeeded but the mailbox could not be opened.
  if (err.mailboxMissing || err.executedCommand?.toUpperCase().startsWith("SELECT") ||
      err.executedCommand?.toUpperCase().startsWith("EXAMINE")) {
    return {
      kind: "select_inbox_failed",
      message: redact(`Signed in, but INBOX could not be opened${detail}`, secrets),
    };
  }

  // Some other command was rejected: name it, and quote the server.
  if (err.serverResponseCode || err.responseText) {
    const command = err.executedCommand ? ` (${err.executedCommand.split(" ")[0]})` : "";
    const code = err.serverResponseCode ? ` [${err.serverResponseCode}]` : "";
    return {
      kind: "command_rejected",
      message: redact(`IMAP command rejected${command}${code}${detail}`, secrets),
    };
  }

  return {
    kind: "unknown",
    message: redact(err.message || String(error) || "Unknown IMAP error", secrets),
  };
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
export async function testImapConnection(
  mailbox: Mailbox,
): Promise<{ ok: boolean; error?: string; kind?: ImapFailure["kind"] }> {
  let client: ImapFlow | null = null;
  // Decrypted only to be redacted out of any error text; never logged.
  let password: string | null = null;
  try {
    password = mailbox.imap_password_enc ? decryptSecret(mailbox.imap_password_enc) : null;
  } catch {
    return {
      ok: false,
      kind: "unknown",
      error: "The stored IMAP password could not be decrypted - re-enter it and save the mailbox",
    };
  }
  try {
    client = buildImapClient(mailbox);
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    lock.release();
    return { ok: true };
  } catch (error) {
    const failure = classifyImapError(error, [password]);
    return { ok: false, error: failure.message, kind: failure.kind };
  } finally {
    await client?.logout().catch(() => client?.close());
  }
}
