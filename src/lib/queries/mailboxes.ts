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
  /** Global cap across every campaign this mailbox is in. */
  daily_limit: number;
  /** Day boundary for that cap. Per mailbox, so "today" is unambiguous. */
  timezone: string;
  enabled: boolean;
}

export async function listMailboxes(): Promise<Mailbox[]> {
  return sql<Mailbox[]>`select * from mailboxes order by created_at`;
}

export async function getMailbox(id: string): Promise<Mailbox | null> {
  const [row] = await sql<Mailbox[]>`select * from mailboxes where id = ${id}`;
  return row ?? null;
}

export async function createMailbox(input: MailboxInput): Promise<string> {
  if (!input.smtp_password) throw new Error("SMTP heslo je povinné.");
  const [row] = await sql<{ id: string }[]>`
    insert into mailboxes (name, from_name, from_email, smtp_host, smtp_port, smtp_username,
                           smtp_password_enc, smtp_secure, imap_host, imap_port, imap_username,
                           imap_password_enc, imap_secure, daily_limit, timezone, enabled)
    values (${input.name}, ${input.from_name}, ${input.from_email.toLowerCase()},
            ${input.smtp_host}, ${input.smtp_port}, ${input.smtp_username},
            ${encryptSecret(input.smtp_password)}, ${input.smtp_secure},
            ${input.imap_host || null}, ${input.imap_port || null}, ${input.imap_username || null},
            ${input.imap_password ? encryptSecret(input.imap_password) : null}, ${input.imap_secure},
            ${input.daily_limit}, ${input.timezone}, ${input.enabled})
    returning id
  `;
  await logActivity({ action: "Schránka vytvořena", detail: input.from_email });
  return row.id;
}

/**
 * Updates a mailbox. An omitted password leaves the stored one untouched, so
 * the plaintext never has to make a round trip to the browser.
 */
export async function updateMailbox(id: string, input: MailboxInput): Promise<void> {
  // Changing a username while leaving the password blank silently pairs the new
  // account with the previous account's password, which the server then refuses
  // with a bare "Command failed". The form's "leave blank to keep" placeholder
  // actively invites this, so the combination is rejected rather than saved.
  const current = await getMailbox(id);
  if (current) {
    if (input.imap_username && current.imap_username &&
        input.imap_username !== current.imap_username && !input.imap_password) {
      throw new Error(
        `The IMAP username changed from ${current.imap_username} to ${input.imap_username}, but the ` +
          "password field was left blank. The stored password belongs to the old username - enter the " +
          "password for the new one.",
      );
    }
    if (input.smtp_username !== current.smtp_username && !input.smtp_password) {
      throw new Error(
        `The SMTP username changed from ${current.smtp_username} to ${input.smtp_username}, but the ` +
          "password field was left blank. The stored password belongs to the old username - enter the " +
          "password for the new one.",
      );
    }
  }

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
           daily_limit = ${input.daily_limit},
           timezone = ${input.timezone},
           enabled = ${input.enabled},
           updated_at = now()
     where id = ${id}
  `;
  await logActivity({ action: "Schránka upravena", detail: input.from_email });
}

export interface MailboxTestResult {
  smtp: { ok: boolean; error?: string };
  imap: { ok: boolean; error?: string; skipped?: boolean };
}

/**
 * Verifies both protocols and records the outcome. A campaign cannot start
 * until this has succeeded at least once for its sender mailbox.
 */
/**
 * Tests IMAP alone, without touching SMTP state.
 *
 * The result is written to imap_last_error, which is the column the Mailboxes
 * page reads for its IMAP badge. Before this, only the reply poller ever wrote
 * that column, so a stale failure from an earlier misconfiguration stayed on
 * screen no matter how many times the operator fixed the credentials and
 * pressed Test - the badge could not go green until a scheduled poll happened
 * to succeed.
 */
export async function testMailboxImap(id: string): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const mailbox = await getMailbox(id);
  if (!mailbox) throw new Error("Mailbox not found");

  if (!hasImapConfigured(mailbox)) {
    const missing = [
      mailbox.imap_host ? null : "host",
      mailbox.imap_port ? null : "port",
      mailbox.imap_username ? null : "username",
      mailbox.imap_password_enc ? null : "password",
    ].filter(Boolean);
    return { ok: false, skipped: true, error: `IMAP není kompletně nastaveno — chybí ${missing.join(", ")}.` };
  }

  const result = await testImapConnection(mailbox);
  await sql`
    update mailboxes
       set imap_last_error = ${result.ok ? null : (result.error ?? "IMAP test failed")},
           imap_last_checked_at = now(),
           updated_at = now()
     where id = ${id}
  `;
  await logActivity({
    level: result.ok ? "info" : "error",
    action: "Test IMAP připojení",
    detail: `${mailbox.from_email}: ${result.ok ? "connected and opened INBOX" : result.error}`,
  });
  return result;
}

export async function testMailbox(id: string): Promise<MailboxTestResult> {
  const mailbox = await getMailbox(id);
  if (!mailbox) throw new Error("Mailbox not found");

  const smtp = await testSmtpConnection(mailbox);
  const imap: MailboxTestResult["imap"] = hasImapConfigured(mailbox)
    ? await testImapConnection(mailbox)
    : { ok: false, skipped: true, error: "IMAP není nastaveno — detekce odpovědí je vypnutá." };

  const ok = smtp.ok;
  const error = [smtp.ok ? null : `SMTP: ${smtp.error}`, imap.ok || imap.skipped ? null : `IMAP: ${imap.error}`]
    .filter(Boolean)
    .join(" | ");

  await sql`
    update mailboxes
       set last_test_ok = ${ok}, last_test_at = now(), last_test_error = ${error || null},
           -- The IMAP badge reads imap_last_error, so a test must own it too:
           -- otherwise a stale poller failure outlives the fix that cured it.
           imap_last_error = ${imap.skipped ? sql`imap_last_error` : imap.ok ? null : (imap.error ?? "IMAP test failed")},
           imap_last_checked_at = ${imap.skipped ? sql`imap_last_checked_at` : sql`now()`},
           updated_at = now()
     where id = ${id}
  `;
  await logActivity({
    level: ok ? "info" : "error",
    action: "Test připojení schránky",
    detail: `${mailbox.from_email}: ${ok ? "SMTP ok" : "SMTP failed"}${imap.skipped ? ", IMAP not configured" : `, IMAP ${imap.ok ? "ok" : "failed"}`}${error ? ` - ${error}` : ""}`,
  });

  return { smtp, imap };
}

export async function deleteMailbox(id: string): Promise<{ ok: boolean; error?: string }> {
  // Counted through the sender pool and the sticky assignments, not through
  // the deprecated campaigns.mailbox_id: that column is NULL for every campaign
  // created since the multi-mailbox migration, so the old guard saw nothing and
  // let the delete through to a raw foreign-key error.
  const [usage] = await sql<{ campaigns: number; pinned_contacts: number }[]>`
    select (select count(*)::int from campaign_mailboxes where mailbox_id = ${id}) as campaigns,
           (select count(*)::int from campaign_contacts where sender_mailbox_id = ${id}) as pinned_contacts
  `;
  if (usage.campaigns > 0) {
    return {
      ok: false,
      error: `Tato schránka je mezi odesílateli u ${usage.campaigns} kampaní a nelze ji smazat.`,
    };
  }
  if (usage.pinned_contacts > 0) {
    return {
      ok: false,
      error:
        `${usage.pinned_contacts} kontaktů má tuto schránku připnutou jako odesílatele a nelze je ` +
        "přesunout jinam, takže schránku nelze smazat.",
    };
  }
  await sql`delete from mailboxes where id = ${id}`;
  await logActivity({ action: "Schránka smazána", level: "warn" });
  return { ok: true };
}
