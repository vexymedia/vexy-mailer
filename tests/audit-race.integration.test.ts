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

/**
 * Zbytek okna mezi claimem a SMTP.
 *
 * Testuje se PRODUKČNÍ větev: `test_mode` je v tomhle souboru vypnutý
 * (viz beforeEach), takže kód jde stejnou cestou jako v ostrém provozu
 * a nahrazený je jedině samotný `sendMail`. Kdyby eligibility platila
 * jen v testovacím režimu, tyhle testy by o produkci neřekly nic.
 */
describe("celé okno mezi claimem a SMTP", () => {
  /** Spustí tick s daným zásahem do okna a vrátí stav claim řádku. */
  async function raceWith(
    seed: Awaited<ReturnType<typeof activeCampaignWithOneDueContact>>,
    action: () => Promise<unknown>,
  ) {
    raceAction.run = async () => { await action(); };
    await dispatchTick();
    const [row] = await sql<{ status: string; error: string | null }[]>`
      select status, error from email_sends where campaign_id = ${seed.campaignId}
    `;
    return row;
  }

  it("odhlášení v okně zprávu zastaví", async () => {
    const seed = await activeCampaignWithOneDueContact();
    const row = await raceWith(seed, () =>
      sql`update campaign_contacts set status = 'unsubscribed', next_send_at = null
           where campaign_id = ${seed.campaignId}`);
    expect(sendMailSpy).not.toHaveBeenCalled();
    expect(row.status).toBe("skipped");
  });

  it("hard bounce v okně (globální suppression) zprávu zastaví", async () => {
    const seed = await activeCampaignWithOneDueContact();
    const row = await raceWith(seed, () =>
      sql`insert into suppression_list (email, reason, reason_code, source)
          values ('target@prospect.test', 'hard_invalid', 'hard_invalid', 'bounce')`);
    expect(sendMailSpy).not.toHaveBeenCalled();
    expect(row.error).toContain("do-not-contact");
  });

  it("stížnost na spam v okně zprávu zastaví", async () => {
    const seed = await activeCampaignWithOneDueContact();
    const row = await raceWith(seed, () =>
      sql`insert into suppression_list (email, reason, reason_code, source)
          values ('target@prospect.test', 'spam', 'spam_complaint', 'fbl')`);
    expect(sendMailSpy).not.toHaveBeenCalled();
    expect(row.status).toBe("skipped");
  });

  it("uzavření kontaktu v CRM v okně zprávu zastaví", async () => {
    const seed = await activeCampaignWithOneDueContact();
    const row = await raceWith(seed, () =>
      sql`update campaign_contacts set call_status = 'meeting_booked'
           where campaign_id = ${seed.campaignId}`);
    expect(sendMailSpy).not.toHaveBeenCalled();
    expect(row.error).toContain("closed in CRM");
  });

  it("vyloučení firmy pro klienta v okně zprávu zastaví", async () => {
    const seed = await activeCampaignWithOneDueContact();
    const [client] = await sql<{ id: string }[]>`
      insert into clients (name) values ('ASN Plus') returning id`;
    const [company] = await sql<{ id: string }[]>`
      insert into companies (name, status) values ('Cíl s.r.o.', 'ready') returning id`;
    await sql`update contacts set company_id = ${company.id} where email = 'target@prospect.test'`;
    await sql`update campaigns set client_id = ${client.id} where id = ${seed.campaignId}`;

    const row = await raceWith(seed, () =>
      sql`insert into client_company_exclusions (client_id, company_id, reason)
          values (${client.id}, ${company.id}, 'Už je klientem.')`);
    expect(sendMailSpy).not.toHaveBeenCalled();
    expect(row.error).toContain("excluded");
  });

  it("odstranění kontaktu z kampaně v okně zprávu zastaví", async () => {
    const seed = await activeCampaignWithOneDueContact();
    // Claim řádek na kontakt odkazuje, takže se maže i on - kontrolujeme
    // proto jen to, že se nic neodeslalo.
    raceAction.run = async () => {
      await sql`delete from campaign_contacts where campaign_id = ${seed.campaignId}`;
    };
    await dispatchTick();
    expect(sendMailSpy).not.toHaveBeenCalled();
  });

  it("jiný worker mezitím krok odeslal → druhý už neodešle", async () => {
    const seed = await activeCampaignWithOneDueContact();
    raceAction.run = async () => {
      // Druhý, konkurenční záznam téhož kroku ve stavu sent.
      const [cc] = await sql<{ id: string; step_id: string }[]>`
        select campaign_contact_id as id, step_id from email_sends
         where campaign_id = ${seed.campaignId} limit 1`;
      await sql`
        insert into email_sends (campaign_id, campaign_contact_id, step_id, step_number, status,
                                 to_email, intended_email, subject, body, sent_at)
        values (${seed.campaignId}, ${cc.id}, ${cc.step_id}, 99, 'sent',
                'target@prospect.test', 'target@prospect.test', 'S', 'B', now())`;
    };
    await dispatchTick();
    expect(sendMailSpy).not.toHaveBeenCalled();
  });

  it("vyčerpání limitu schránky v okně zprávu zastaví", async () => {
    const seed = await activeCampaignWithOneDueContact();
    // Schránka se v okně srazí na limit, kterého už dosáhla claimem.
    const row = await raceWith(seed, () =>
      sql`update mailboxes set daily_limit = 1, enabled = false where id = ${seed.mailboxId}`);
    expect(sendMailSpy).not.toHaveBeenCalled();
    expect(row.status).toBe("skipped");
  });

  it("ztráta úspěšného testu spojení v okně zprávu zastaví", async () => {
    const seed = await activeCampaignWithOneDueContact();
    const row = await raceWith(seed, () =>
      sql`update mailboxes set last_test_ok = false where id = ${seed.mailboxId}`);
    expect(sendMailSpy).not.toHaveBeenCalled();
    expect(row.error).toContain("connection test");
  });
});
