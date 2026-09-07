import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, seedCampaign } from "./helpers/fixtures";
import { startFakeSmtp, type FakeSmtp } from "./helpers/smtp-server";

/**
 * End-to-end delivery tests: a real PostgreSQL database and a real SMTP server
 * on localhost. nodemailer performs an actual AUTH/MAIL/RCPT/DATA exchange, so
 * these cover the parts a stub cannot - message headers on the wire, genuine
 * server rejections, and a connection that dies mid-DATA.
 */

let smtp: FakeSmtp;
let sql: typeof import("@/lib/db").sql;

beforeEach(async () => {
  smtp = await startFakeSmtp();
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  // Live sending, against our own local server.
  await sql`update app_settings set test_mode = false where id = true`;
});

afterEach(async () => {
  await smtp.close();
});

afterAll(async () => {
  await closeDatabase();
});

/** Points the seeded mailbox at the local SMTP server (plaintext, no TLS). */
async function useLocalSmtp(mailboxId: string) {
  await sql`
    update mailboxes set smtp_host = '127.0.0.1', smtp_port = ${smtp.port}, smtp_secure = false
     where id = ${mailboxId}
  `;
}

async function tick() {
  const { dispatchTick } = await import("@/lib/engine/dispatch");
  return dispatchTick();
}

describe("real SMTP delivery", () => {
  it("delivers a rendered email and records it as sent", async () => {
    const seed = await seedCampaign({
      steps: [{ delay_days: 0, subject: "Hi {{first_name}}", body: "About {{company}}, right?" }],
      contacts: [{ email: "ann@prospect.com", first_name: "Ann", company: "Acme" }],
    });
    await useLocalSmtp(seed.mailboxId);
    const { startCampaign } = await import("@/lib/queries/campaigns");
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);

    const summary = await tick();
    expect(summary.outcomes[0].action).toBe("sent");

    expect(smtp.received).toHaveLength(1);
    const mail = smtp.received[0];
    expect(mail.to).toEqual(["ann@prospect.com"]);
    expect(mail.subject).toBe("Hi Ann");
    expect(mail.raw).toContain("About Acme, right?");
    expect(mail.messageId).toBeTruthy();

    const [row] = await sql<{ status: string; message_id: string; sent_at: Date }[]>`
      select status, message_id, sent_at from email_sends where campaign_id = ${seed.campaignId}
    `;
    expect(row.status).toBe("sent");
    expect(row.message_id).toBe(mail.messageId);
    expect(row.sent_at).not.toBeNull();
  });

  it("includes a List-Unsubscribe header", async () => {
    const seed = await seedCampaign({ steps: [{ delay_days: 0, subject: "S", body: "B" }] });
    await useLocalSmtp(seed.mailboxId);
    const { startCampaign } = await import("@/lib/queries/campaigns");
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await tick();

    expect(smtp.received[0].raw).toMatch(/List-Unsubscribe:/i);
  });

  it("threads follow-ups onto the first email", async () => {
    const seed = await seedCampaign({
      steps: [
        { delay_days: 0, subject: "First", body: "One" },
        { delay_days: 0, subject: "Second", body: "Two" },
      ],
    });
    await useLocalSmtp(seed.mailboxId);
    const { startCampaign } = await import("@/lib/queries/campaigns");
    await startCampaign(seed.campaignId);

    await clearPacing(seed.campaignId);
    await tick();
    await clearPacing(seed.campaignId);
    await tick();

    expect(smtp.received).toHaveLength(2);
    const [first, second] = smtp.received;
    expect(second.inReplyTo).toBe(first.messageId);
  });

  it("does not mark a send as sent when the server rejects it", async () => {
    const seed = await seedCampaign({ steps: [{ delay_days: 0, subject: "S", body: "B" }] });
    await useLocalSmtp(seed.mailboxId);
    smtp.failNext(1, 550, "Mailbox unavailable");

    const { startCampaign } = await import("@/lib/queries/campaigns");
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);

    const summary = await tick();
    expect(summary.outcomes[0].action).toBe("failed");
    expect(smtp.received).toHaveLength(0);

    const [row] = await sql<{ status: string; error: string; next_retry_at: Date | null }[]>`
      select status, error, next_retry_at from email_sends where campaign_id = ${seed.campaignId}
    `;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("Mailbox unavailable");
    expect(row.next_retry_at).toBeNull(); // 5xx is permanent
  });

  it("retries a 4xx rejection and delivers exactly one email overall", async () => {
    const seed = await seedCampaign({ steps: [{ delay_days: 0, subject: "S", body: "B" }] });
    await useLocalSmtp(seed.mailboxId);
    smtp.failNext(1, 451, "Greylisted, try again later");

    const { startCampaign } = await import("@/lib/queries/campaigns");
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await tick(); // fails, schedules a retry

    const [failed] = await sql<{ status: string; next_retry_at: Date }[]>`
      select status, next_retry_at from email_sends where campaign_id = ${seed.campaignId}
    `;
    expect(failed.status).toBe("failed");
    expect(failed.next_retry_at).not.toBeNull();

    // Bring the retry forward and run again.
    await sql`update email_sends set next_retry_at = now() where campaign_id = ${seed.campaignId}`;
    await clearPacing(seed.campaignId);
    await tick();

    expect(smtp.received).toHaveLength(1); // delivered exactly once
    const rows = await sql<{ status: string; attempt_count: number }[]>`
      select status, attempt_count from email_sends where campaign_id = ${seed.campaignId}
    `;
    expect(rows).toHaveLength(1); // one ledger row, reused
    expect(rows[0].status).toBe("sent");
    expect(rows[0].attempt_count).toBe(2);
  });

  it("authenticates, and records a permanent failure on bad credentials", async () => {
    const seed = await seedCampaign({ steps: [{ delay_days: 0, subject: "S", body: "B" }] });
    await useLocalSmtp(seed.mailboxId);
    const { encryptSecret } = await import("@/lib/crypto");
    await sql`update mailboxes set smtp_password_enc = ${encryptSecret("wrong")} where id = ${seed.mailboxId}`;

    const { startCampaign } = await import("@/lib/queries/campaigns");
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await tick();

    expect(smtp.received).toHaveLength(0);
    const [row] = await sql<{ status: string; next_retry_at: Date | null }[]>`
      select status, next_retry_at from email_sends where campaign_id = ${seed.campaignId}
    `;
    expect(row.status).toBe("failed");
    expect(row.next_retry_at).toBeNull(); // auth failures are never retried
  });

  it("verifies credentials from the connection test without sending anything", async () => {
    const seed = await seedCampaign();
    await useLocalSmtp(seed.mailboxId);
    const { testMailbox } = await import("@/lib/queries/mailboxes");

    const result = await testMailbox(seed.mailboxId);
    expect(result.smtp.ok).toBe(true);
    expect(smtp.received).toHaveLength(0);

    const [mailbox] = await sql`select last_test_ok from mailboxes where id = ${seed.mailboxId}`;
    expect(mailbox.last_test_ok).toBe(true);
  });

  it("reports a failing connection test rather than throwing", async () => {
    const seed = await seedCampaign();
    await sql`update mailboxes set smtp_host = '127.0.0.1', smtp_port = 1, smtp_secure = false where id = ${seed.mailboxId}`;
    const { testMailbox } = await import("@/lib/queries/mailboxes");

    const result = await testMailbox(seed.mailboxId);
    expect(result.smtp.ok).toBe(false);
    const [mailbox] = await sql`select last_test_ok, last_test_error from mailboxes where id = ${seed.mailboxId}`;
    expect(mailbox.last_test_ok).toBe(false);
    expect(mailbox.last_test_error).toBeTruthy();
  });

  it("redirects to the test address when test mode is on, and nothing reaches the prospect", async () => {
    const seed = await seedCampaign({
      steps: [{ delay_days: 0, subject: "Hi {{first_name}}", body: "B" }],
      contacts: [{ email: "real@prospect.com", first_name: "Real" }],
    });
    await useLocalSmtp(seed.mailboxId);
    await sql`
      update app_settings set test_mode = true, test_behavior = 'redirect', test_email = 'me@mine.cz'
       where id = true
    `;

    const { startCampaign } = await import("@/lib/queries/campaigns");
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await tick();

    expect(smtp.received).toHaveLength(1);
    expect(smtp.received[0].to).toEqual(["me@mine.cz"]);
    expect(smtp.received[0].to).not.toContain("real@prospect.com");
    expect(smtp.received[0].subject).toContain("[TEST -> real@prospect.com]");
  });

  it("never delivers the same step twice, however many ticks race", async () => {
    const seed = await seedCampaign({
      steps: [{ delay_days: 0, subject: "S", body: "B" }],
      contacts: [{ email: "one@prospect.com" }],
    });
    await useLocalSmtp(seed.mailboxId);
    const { startCampaign } = await import("@/lib/queries/campaigns");
    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);

    // Ten concurrent workers, then ten sequential ticks with the pacing cursor
    // cleared each time - every path that could plausibly resend.
    await Promise.all(Array.from({ length: 10 }, () => tick()));
    for (let i = 0; i < 10; i++) {
      await sql`update campaigns set next_slot_at = null where id = ${seed.campaignId}`;
      await tick();
    }

    expect(smtp.received).toHaveLength(1);
  });
});

describe("indeterminate delivery", () => {
  it("marks a connection that dies mid-DATA as unknown and never retries it", async () => {
    // The genuinely dangerous case: the server accepted DATA and then went
    // silent. The message may or may not have been queued for delivery, so the
    // only safe response is to stop touching this contact.
    process.env.SMTP_SOCKET_TIMEOUT_MS = "1500";
    try {
      const seed = await seedCampaign({ steps: [{ delay_days: 0, subject: "S", body: "B" }] });
      await useLocalSmtp(seed.mailboxId);
      smtp.dropNext(1);

      const { startCampaign } = await import("@/lib/queries/campaigns");
      await startCampaign(seed.campaignId);
      await clearPacing(seed.campaignId);

      const summary = await tick();
      expect(summary.outcomes[0].action).toBe("unknown");

      const [row] = await sql<{ status: string; next_retry_at: Date | null }[]>`
        select status, next_retry_at from email_sends where campaign_id = ${seed.campaignId}
      `;
      expect(row.status).toBe("unknown");
      expect(row.next_retry_at).toBeNull();

      // The contact is halted for manual review rather than retried.
      const [cc] = await sql<{ status: string }[]>`
        select status from campaign_contacts where campaign_id = ${seed.campaignId}
      `;
      expect(cc.status).toBe("failed");

      // And no amount of further ticking produces a second attempt.
      for (let i = 0; i < 5; i++) {
        await sql`update campaigns set next_slot_at = null where id = ${seed.campaignId}`;
        await tick();
      }
      const rows = await sql`select id from email_sends where campaign_id = ${seed.campaignId}`;
      expect(rows).toHaveLength(1);
      expect(smtp.received).toHaveLength(0);
    } finally {
      delete process.env.SMTP_SOCKET_TIMEOUT_MS;
    }
  });
});
