import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { startFakeImap, type FakeImap } from "./helpers/imap-server";

/**
 * IMAP diagnostics.
 *
 * The bug these cover: imapflow reports every rejected IMAP command as the
 * message "Command failed", so a wrong password and an unopenable INBOX looked
 * identical on screen. And because only the reply poller ever wrote
 * imap_last_error - the column the Mailboxes page reads - a stale failure from
 * an old misconfiguration survived every correction the operator made.
 *
 * Runs against a real (if minimal) IMAP server so the error shapes are the
 * ones imapflow actually produces.
 */

let sql: typeof import("@/lib/db").sql;
let imap: FakeImap;

beforeEach(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  imap = await startFakeImap({ user: "karolina@vexy.cz", pass: "correct-pass" });
});

afterEach(async () => {
  await imap.close();
});

afterAll(async () => {
  await closeDatabase();
});

/** A Seznam-shaped mailbox pointed at the fake server. */
async function mailbox(overrides: { imapUsername?: string; imapPassword?: string } = {}) {
  const { encryptSecret } = await import("@/lib/crypto");
  const [row] = await sql<{ id: string }[]>`
    insert into mailboxes (name, from_name, from_email, smtp_host, smtp_port, smtp_username,
                           smtp_password_enc, smtp_secure, imap_host, imap_port, imap_username,
                           imap_password_enc, imap_secure, last_test_ok)
    values ('Karolina', 'Karolina', 'karolina@vexy.cz', 'smtp.seznam.cz', 465, 'karolina@vexy.cz',
            ${encryptSecret("smtp-pass")}, true,
            '127.0.0.1', ${imap.port}, ${overrides.imapUsername ?? "karolina@vexy.cz"},
            ${encryptSecret(overrides.imapPassword ?? "correct-pass")}, false, true)
    returning id
  `;
  return row.id;
}

describe("the real reason replaces \"Command failed\"", () => {
  it("names an authentication failure instead of a generic message", async () => {
    // Exactly the karolina case: right username, password belonging to someone else.
    const id = await mailbox({ imapPassword: "nelas-old-password" });
    const { testMailboxImap } = await import("@/lib/queries/mailboxes");

    const result = await testMailboxImap(id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/authentication failed/i);
    expect(result.error).not.toBe("Command failed");
    expect(result.error).not.toContain("Command failed");
  });

  it("distinguishes an unopenable INBOX from a bad password", async () => {
    const id = await mailbox();
    imap.refuseSelect = true;
    const { testMailboxImap } = await import("@/lib/queries/mailboxes");

    const result = await testMailboxImap(id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/INBOX could not be opened/i);
    expect(result.error).not.toMatch(/authentication/i);
  });

  it("names an unreachable server", async () => {
    const id = await mailbox();
    await sql`update mailboxes set imap_port = 1 where id = ${id}`;
    const { testMailboxImap } = await import("@/lib/queries/mailboxes");

    const result = await testMailboxImap(id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not reach the imap server/i);
  });

  it("says which settings are missing rather than failing opaquely", async () => {
    const id = await mailbox();
    await sql`update mailboxes set imap_password_enc = null where id = ${id}`;
    const { testMailboxImap } = await import("@/lib/queries/mailboxes");

    const result = await testMailboxImap(id);
    expect(result.skipped).toBe(true);
    expect(result.error).toContain("password");
  });

  it("never puts the password into the reported reason", async () => {
    const secret = "sup3r-secret-imap-pass";
    const id = await mailbox({ imapPassword: secret });
    const { testMailboxImap } = await import("@/lib/queries/mailboxes");

    const result = await testMailboxImap(id);
    expect(result.ok).toBe(false);
    expect(result.error).not.toContain(secret);

    const [row] = await sql<{ imap_last_error: string }[]>`
      select imap_last_error from mailboxes where id = ${id}
    `;
    expect(row.imap_last_error).not.toContain(secret);

    const [log] = await sql<{ detail: string }[]>`
      select coalesce(string_agg(detail, ' '), '') as detail from activity_logs
    `;
    expect(log.detail).not.toContain(secret);
  });
});

describe("a successful test clears the stale error the badge reads", () => {
  it("goes green after the credentials are corrected", async () => {
    // The exact production symptom: a poller failure left behind, then fixed.
    const id = await mailbox({ imapPassword: "nelas-old-password" });
    const { testMailboxImap } = await import("@/lib/queries/mailboxes");

    await testMailboxImap(id);
    const [failed] = await sql<{ imap_last_error: string | null }[]>`
      select imap_last_error from mailboxes where id = ${id}
    `;
    expect(failed.imap_last_error).toMatch(/authentication failed/i); // badge is red

    // Operator re-enters the right password.
    const { encryptSecret } = await import("@/lib/crypto");
    await sql`update mailboxes set imap_password_enc = ${encryptSecret("correct-pass")} where id = ${id}`;

    const result = await testMailboxImap(id);
    expect(result.ok).toBe(true);

    const [fixed] = await sql<{ imap_last_error: string | null; imap_last_checked_at: Date | null }[]>`
      select imap_last_error, imap_last_checked_at from mailboxes where id = ${id}
    `;
    expect(fixed.imap_last_error).toBeNull(); // badge is green again
    expect(fixed.imap_last_checked_at).not.toBeNull();
  });

  it("the combined connection test also clears it", async () => {
    const id = await mailbox({ imapPassword: "wrong" });
    const { testMailboxImap, testMailbox } = await import("@/lib/queries/mailboxes");
    await testMailboxImap(id);

    const { encryptSecret } = await import("@/lib/crypto");
    await sql`update mailboxes set imap_password_enc = ${encryptSecret("correct-pass")} where id = ${id}`;
    await testMailbox(id); // SMTP will fail against seznam here; IMAP is what matters

    const [row] = await sql<{ imap_last_error: string | null }[]>`
      select imap_last_error from mailboxes where id = ${id}
    `;
    expect(row.imap_last_error).toBeNull();
  });

  it("does not wipe the IMAP state when IMAP is not configured at all", async () => {
    const id = await mailbox();
    await sql`update mailboxes set imap_host = null, imap_last_error = 'earlier failure' where id = ${id}`;
    const { testMailbox } = await import("@/lib/queries/mailboxes");
    await testMailbox(id);

    const [row] = await sql<{ imap_last_error: string | null }[]>`
      select imap_last_error from mailboxes where id = ${id}
    `;
    expect(row.imap_last_error).toBe("earlier failure"); // untouched, not falsely cleared
  });
});

describe("changing a username without the matching password is refused", () => {
  it("rejects an IMAP username change that leaves the password blank", async () => {
    // This is how karolina ended up with nela's password in the first place.
    const id = await mailbox({ imapUsername: "nela@vexy.cz" });
    const { updateMailbox, getMailbox } = await import("@/lib/queries/mailboxes");
    const before = (await getMailbox(id))!;

    await expect(
      updateMailbox(id, {
        name: before.name,
        from_name: before.from_name,
        from_email: before.from_email,
        smtp_host: before.smtp_host,
        smtp_port: before.smtp_port,
        smtp_username: before.smtp_username,
        smtp_secure: before.smtp_secure,
        imap_host: before.imap_host,
        imap_port: before.imap_port,
        imap_username: "karolina@vexy.cz", // changed
        imap_password: null, // left blank
        imap_secure: before.imap_secure,
        daily_limit: before.daily_limit,
        timezone: before.timezone,
        enabled: before.enabled,
      }),
    ).rejects.toThrow(/password field was left blank/i);

    // Nothing was written: the old username survives rather than a broken pair.
    const after = (await getMailbox(id))!;
    expect(after.imap_username).toBe("nela@vexy.cz");
  });

  it("allows the change when the new password is supplied", async () => {
    const id = await mailbox({ imapUsername: "nela@vexy.cz" });
    const { updateMailbox, getMailbox, testMailboxImap } = await import("@/lib/queries/mailboxes");
    const before = (await getMailbox(id))!;

    await updateMailbox(id, {
      name: before.name,
      from_name: before.from_name,
      from_email: before.from_email,
      smtp_host: before.smtp_host,
      smtp_port: before.smtp_port,
      smtp_username: before.smtp_username,
      smtp_secure: before.smtp_secure,
      imap_host: before.imap_host,
      imap_port: before.imap_port,
      imap_username: "karolina@vexy.cz",
      imap_password: "correct-pass",
      imap_secure: before.imap_secure,
      daily_limit: before.daily_limit,
      timezone: before.timezone,
      enabled: before.enabled,
    });

    const after = (await getMailbox(id))!;
    expect(after.imap_username).toBe("karolina@vexy.cz");
    // And the newly stored password really is the one that works.
    expect((await testMailboxImap(id)).ok).toBe(true);
  });
});
