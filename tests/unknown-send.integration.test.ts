import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, seedCampaign } from "./helpers/fixtures";

/**
 * „SMTP zprávu přijalo, zápis výsledku neprošel."
 *
 * SMTP protokol exactly-once negarantuje a aplikace to nepředstírá.
 * Zvolené zbytkové riziko je JEDEN možná nedoručený follow-up, ne
 * duplicitní e-mail u prospekta - proto se takový krok nikdy neopakuje.
 *
 * Aby to nebylo tiché selhání, musí platit všechno tohle najednou:
 * záznam zůstane, kontakt je viditelně označený, další automatické kroky
 * stojí a případ jde dohledat u kontaktu i v aktivitě.
 */

const sendMail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/smtp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/smtp")>();
  return { ...actual, sendMail: (...args: unknown[]) => sendMail(...args) };
});

let sql: typeof import("@/lib/db").sql;
let dispatchTick: typeof import("@/lib/engine/dispatch").dispatchTick;
let reapStuckSends: typeof import("@/lib/engine/dispatch").reapStuckSends;
let startCampaign: typeof import("@/lib/queries/campaigns").startCampaign;

beforeEach(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  ({ dispatchTick, reapStuckSends } = await import("@/lib/engine/dispatch"));
  ({ startCampaign } = await import("@/lib/queries/campaigns"));
  await sql`update app_settings set test_mode = false where id = true`;
  sendMail.mockReset();
  sendMail.mockResolvedValue({ ok: true, messageId: "<doslo@example.com>", response: "250 ok" });
});

afterAll(async () => {
  await closeDatabase();
});

/**
 * Odešle krok 1 a pak přepíše výsledek zpátky na claimnutý stav - přesně
 * to, co by v databázi zůstalo, kdyby proces umřel mezi SMTP a zápisem.
 */
async function acceptedButUnwritten() {
  const seed = await seedCampaign({
    steps: [
      { delay_days: 0, subject: "S1", body: "B1" },
      { delay_days: 1, subject: "S2", body: "B2" },
      { delay_days: 2, subject: "S3", body: "B3" },
    ],
    contacts: [{ email: "cil@prospect.test" }],
  });
  await startCampaign(seed.campaignId);
  await clearPacing(seed.campaignId);
  await dispatchTick();

  await sql`
    update email_sends
       set status = 'sending', sent_at = null, message_id = null,
           claimed_at = now() - interval '3 hours'
     where campaign_id = ${seed.campaignId}`;
  await sql`
    update campaign_contacts
       set status = 'sent', current_step = 1, last_sent_at = null,
           next_send_at = now() - interval '1 minute'
     where campaign_id = ${seed.campaignId}`;
  return seed;
}

describe("nejistý výsledek odeslání", () => {
  it("se nikdy neopakuje automaticky", async () => {
    const seed = await acceptedButUnwritten();
    expect(await reapStuckSends()).toBe(1);

    sendMail.mockClear();
    for (let i = 0; i < 5; i++) {
      await clearPacing(seed.campaignId);
      await dispatchTick();
    }
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("záznam nezmizí a nese důvod", async () => {
    const seed = await acceptedButUnwritten();
    await reapStuckSends();

    const [row] = await sql<{ status: string; error: string; step_number: number }[]>`
      select status, error, step_number from email_sends where campaign_id = ${seed.campaignId}`;
    expect(row.status).toBe("unknown");
    expect(row.step_number).toBe(1);
    expect(row.error).toContain("will not be retried");
  });

  it("kontakt je viditelně označený k ruční kontrole", async () => {
    const seed = await acceptedButUnwritten();
    await reapStuckSends();

    const [row] = await sql<{ status: string; last_error: string }[]>`
      select status, last_error from campaign_contacts where campaign_id = ${seed.campaignId}`;
    expect(row.status).toBe("failed");
    expect(row.last_error).toContain("needs review");
  });

  it("DALŠÍ automatické kroky se neodešlou, dokud se to nevyřeší", async () => {
    const seed = await acceptedButUnwritten();
    await reapStuckSends();

    // Čas plyne, krok 2 by byl dávno splatný.
    await sql`update campaign_contacts set next_send_at = now() - interval '5 days'
               where campaign_id = ${seed.campaignId}`;
    sendMail.mockClear();
    for (let i = 0; i < 5; i++) {
      await clearPacing(seed.campaignId);
      await dispatchTick();
    }
    expect(sendMail).not.toHaveBeenCalled();

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from email_sends where campaign_id = ${seed.campaignId}`;
    expect(count).toBe(1);
  });

  it("je dohledatelný v aktivitě", async () => {
    const seed = await acceptedButUnwritten();
    await reapStuckSends();
    const rows = await sql<{ level: string; action: string; campaign_contact_id: string | null }[]>`
      select level, action, campaign_contact_id from activity_logs
       where campaign_id = ${seed.campaignId} order by created_at desc`;
    const entry = rows.find((r) => r.action.includes("neznámý výsledek"));
    expect(entry).toBeDefined();
    expect(entry!.level).toBe("error");
    // S vazbou na konkrétní kontakt, ať se dá dohledat od něj.
    expect(entry!.campaign_contact_id).not.toBeNull();
  });

  it("je vidět na kampani jako 'k prověření'", async () => {
    const seed = await acceptedButUnwritten();
    await reapStuckSends();
    const { listCampaignStats } = await import("@/lib/queries/dashboard");
    const stats = (await listCampaignStats()).find((s) => s.id === seed.campaignId);
    expect(stats?.needs_review).toBe(1);
  });

  it("je vidět v historii firmy", async () => {
    const seed = await acceptedButUnwritten();
    await reapStuckSends();
    const [contact] = await sql<{ company_id: string }[]>`
      select company_id from contacts where id = ${seed.contactIds[0]}`;
    if (!contact.company_id) return; // fixture nemusí firmu zakládat

    const { getCompanyTimeline } = await import("@/lib/queries/companies");
    const timeline = await getCompanyTimeline(contact.company_id);
    expect(timeline.some((e) => JSON.stringify(e).includes("neznám"))).toBe(true);
  });

  it("je vidět v historii kontaktu", async () => {
    const seed = await acceptedButUnwritten();
    await reapStuckSends();
    const { getContactTimeline } = await import("@/lib/queries/calling");
    const timeline = await getContactTimeline(seed.campaignContactIds[0]);
    expect(timeline.some((e) => JSON.stringify(e).toLowerCase().includes("neznám"))).toBe(true);
  });
});
