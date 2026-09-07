import { sql } from "../db";
import { encryptSecret } from "../crypto";
import { logActivity } from "../activity";
import { testSmtpConnection } from "../smtp";
import { hasImapConfigured, testImapConnection } from "../imap";
import type { Mailbox } from "../types";

export interface MailboxInput {
  name: string;
  from_name: string;
  from_email: string;
  smtp_host: string;
  smtp_port: number;
  smtp_username: string;
  smtp_password?: string;
  smtp_secure: boolean;
  imap_host?: string | null;
  imap_port?: number | null;
  imap_username?: string | null;
  imap_password?: string | null;
  imap_secure: boolean;
}

export async function listMailboxes(): Promise<Mailbox[]> {
  return sql<Mailbox[]>`select * from mailboxes order by created_at`;
}

export async function getMailbox(id: string): Promise<Mailbox | null> {
  const [row] = await sql<Mailbox[]>`select * from mailboxes where id = ${id}`;
  return row ?? null;
}

export async function createMailbox(input: MailboxInput): Promise<string> {
  if (!input.smtp_password) throw new Error("An SMTP password is required.");
  const [row] = await sql<{ id: string }[]>`
    insert into mailboxes (name, from_name, from_email, smtp_host, smtp_port, smtp_username,
                           smtp_password_enc, smtp_secure, imap_host, imap_port, imap_username,
                           imap_password_enc, imap_secure)
    values (${input.name}, ${input.from_name}, ${input.from_email.toLowerCase()},
            ${input.smtp_host}, ${input.smtp_port}, ${input.smtp_username},
            ${encryptSecret(input.smtp_password)}, ${input.smtp_secure},
            ${input.imap_host || null}, ${input.imap_port || null}, ${input.imap_username || null},
            ${input.imap_password ? encryptSecret(input.imap_password) : null}, ${input.imap_secure})
    returning id
  `;
  await logActivity({ action: "Mailbox created", detail: input.from_email });
  return row.id;
}

/**
 * Updates a mailbox. An omitted password leaves the stored one untouched, so
 * the plaintext never has to make a round trip to the browser.
 */
export async function updateMailbox(id: string, input: MailboxInput): Promise<void> {
  await sql`
    update mailboxes
       set name = ${input.name},
           from_name = ${input.from_name},
           from_email = ${input.from_email.toLowerCase()},
           smtp_host = ${input.smtp_host},
           smtp_port = ${input.smtp_port},
           smtp_username = ${input.smtp_username},
           smtp_password_enc = ${input.smtp_password ? encryptSecret(input.smtp_password) : sql`smtp_password_enc`},
           smtp_secure = ${input.smtp_secure},
           imap_host = ${input.imap_host || null},
           imap_port = ${input.imap_port || null},
           imap_username = ${input.imap_username || null},
           imap_password_enc = ${input.imap_password ? encryptSecret(input.imap_password) : sql`imap_password_enc`},
           imap_secure = ${input.imap_secure},
           updated_at = now()
     where id = ${id}
  `;
  await logActivity({ action: "Mailbox updated", detail: input.from_email });
}

export interface MailboxTestResult {
  smtp: { ok: boolean; error?: string };
  imap: { ok: boolean; error?: string; skipped?: boolean };
}

/**
 * Verifies both protocols and records the outcome. A campaign cannot start
 * until this has succeeded at least once for its sender mailbox.
 */
export async function testMailbox(id: string): Promise<MailboxTestResult> {
  const mailbox = await getMailbox(id);
  if (!mailbox) throw new Error("Mailbox not found");

  const smtp = await testSmtpConnection(mailbox);
  const imap: MailboxTestResult["imap"] = hasImapConfigured(mailbox)
    ? await testImapConnection(mailbox)
    : { ok: false, skipped: true, error: "No IMAP configuration - reply detection is off." };

  const ok = smtp.ok;
  const error = [smtp.ok ? null : `SMTP: ${smtp.error}`, imap.ok || imap.skipped ? null : `IMAP: ${imap.error}`]
    .filter(Boolean)
    .join(" | ");

  await sql`
    update mailboxes
       set last_test_ok = ${ok}, last_test_at = now(), last_test_error = ${error || null}, updated_at = now()
     where id = ${id}
  `;
  await logActivity({
    level: ok ? "info" : "error",
    action: "Mailbox connection tested",
    detail: `${mailbox.from_email}: ${ok ? "SMTP ok" : "SMTP failed"}${imap.skipped ? ", IMAP not configured" : `, IMAP ${imap.ok ? "ok" : "failed"}`}${error ? ` - ${error}` : ""}`,
  });

  return { smtp, imap };
}

export async function deleteMailbox(id: string): Promise<{ ok: boolean; error?: string }> {
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from campaigns where mailbox_id = ${id}
  `;
  if (count > 0) {
    return { ok: false, error: `This mailbox is used by ${count} campaign(s) and cannot be deleted.` };
  }
  await sql`delete from mailboxes where id = ${id}`;
  await logActivity({ action: "Mailbox deleted", level: "warn" });
  return { ok: true };
}
