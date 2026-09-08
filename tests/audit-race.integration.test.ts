import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
// A single pooled connection makes the injected write strictly ordered before
// the guard's read, instead of racing it. Must be set before @/lib/db loads.
process.env.DB_POOL_MAX = "1";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, seedCampaign } from "./helpers/fixtures";

/**
 * Security audit: the window between committing the send claim and calling
 * SMTP.
 *
 * The guard conditions (suppression, replied, campaign still active) are all
 * evaluated inside the claim transaction. That transaction must commit before
 * SMTP is touched, otherwise a dying worker could not be detected - which
 * leaves a real gap: anything that changes in that window is not seen.
 *
 * The gap is reachable in production. The reply poller takes a different lease
 * from the dispatcher, so pollReplies can mark a contact `replied` while
 * dispatch is between commit and send. An operator pressing "Do not contact"
 * or "Pause" hits the same window.
 *
 * These tests open the window deterministically by mocking generateMessageId,
 * which dispatch calls after the commit and immediately before sendMail.
 */

const sendMailSpy = vi.hoisted(() => vi.fn());
// What to do inside the race window, set per test.
const raceAction = vi.hoisted(() => ({ run: async () => {} }));

vi.mock("@/lib/smtp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/smtp")>();
  return {
    ...actual,
    generateMessageId: (from: string) => {
      // Runs after the claim commits and before the final guard. The write it
      // issues takes the pool's only connection, so the guard's own query is
      // queued behind it and observes the change - which is exactly the
      // production ordering this test is about.
      raceActionPromise = raceAction.run();
      return actual.generateMessageId(from);
    },
    sendMail: async (...args: unknown[]) => {
      await raceActionPromise;
      sendMailSpy(...args);
      return { ok: true as const, messageId: "<mocked@example.com>", response: "250 ok" };
    },
  };
});

let raceActionPromise: Promise<void> = Promise.resolve();
let sql: typeof import("@/lib/db").sql;
// Resolved up front: a dynamic import inside the race action would delay the
// query past the guard's read and make the test meaningless.
let suppressEmail: typeof import("@/lib/queries/contacts").suppressEmail;
let pauseCampaign: typeof import("@/lib/queries/campaigns").pauseCampaign;
let dispatchTick: typeof import("@/lib/engine/dispatch").dispatchTick;
let startCampaign: typeof import("@/lib/queries/campaigns").startCampaign;

beforeEach(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  ({ suppressEmail } = await import("@/lib/queries/contacts"));
  ({ pauseCampaign, startCampaign } = await import("@/lib/queries/campaigns"));
  ({ dispatchTick } = await import("@/lib/engine/dispatch"));
  await sql`update app_settings set test_mode = false where id = true`;
  sendMailSpy.mockClear();
  raceAction.run = async () => {};
  raceActionPromise = Promise.resolve();
});

afterAll(async () => {
  await closeDatabase();
});

async function activeCampaignWithOneDueContact() {
  const seed = await seedCampaign({
    steps: [{ delay_days: 0, subject: "S", body: "B" }],
    contacts: [{ email: "target@prospect.test", first_name: "Target" }],
  });
  await startCampaign(seed.campaignId);
  await clearPacing(seed.campaignId);
  return seed;
}

describe("guards are re-checked immediately before the SMTP call", () => {
  it("does not send when the contact is suppressed inside the race window", async () => {
    const seed = await activeCampaignWithOneDueContact();
    raceAction.run = () => suppressEmail("target@prospect.test", "manual");

    await dispatchTick();

    expect(sendMailSpy).not.toHaveBeenCalled();
    const [row] = await sql<{ status: string }[]>`
      select status from email_sends where campaign_id = ${seed.campaignId}
    `;
    expect(row.status).toBe("skipped");
  });

  it("does not send when a reply lands inside the race window", async () => {
    const seed = await activeCampaignWithOneDueContact();
    raceAction.run = async () => {
      await sql`
        update campaign_contacts set status = 'replied', replied_at = now(), next_send_at = null
         where campaign_id = ${seed.campaignId}
      `;
    };

    await dispatchTick();

    expect(sendMailSpy).not.toHaveBeenCalled();
  });

  it("does not send when the campaign is paused inside the race window", async () => {
    const seed = await activeCampaignWithOneDueContact();
    raceAction.run = () => pauseCampaign(seed.campaignId);

    await dispatchTick();

    expect(sendMailSpy).not.toHaveBeenCalled();
  });

  it("still sends normally when nothing changes in the window", async () => {
    // Guards against a fix that simply refuses to send anything.
    const seed = await activeCampaignWithOneDueContact();
    await dispatchTick();

    expect(sendMailSpy).toHaveBeenCalledTimes(1);
    const [row] = await sql<{ status: string }[]>`
      select status from email_sends where campaign_id = ${seed.campaignId}
    `;
    expect(row.status).toBe("sent");
  });
});

describe("the sender mailbox is re-checked too", () => {
  it("does not send when the sender mailbox is disabled inside the race window", async () => {
    const seed = await activeCampaignWithOneDueContact();
    raceAction.run = async () => {
      await sql`update mailboxes set enabled = false`;
    };

    await dispatchTick();

    expect(sendMailSpy).not.toHaveBeenCalled();
    const [row] = await sql<{ status: string; error: string }[]>`
      select status, error from email_sends where campaign_id = ${seed.campaignId}
    `;
    expect(row.status).toBe("skipped");
    expect(row.error).toContain("disabled");
  });
});
