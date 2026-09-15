import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, seedCampaign } from "./helpers/fixtures";

/**
 * Selhání kolem SMTP a co po nich zůstane.
 *
 * Běží s VYPNUTÝM testovacím režimem, takže jde o produkční větev;
 * nahrazený je jen `sendMail`. Otázka, na kterou to odpovídá, je vždycky
 * stejná: může po tomhle selhání dostat prospekt e-mail dvakrát?
 *
 * Doplňuje `engine.integration.test.ts` (retry, strop pokusů, souběžné
 * claimy) o scénáře, které tam nebyly: pád mezi SMTP a zápisem výsledku,
 * timeout a jednoznačná trvalá chyba.
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
});

afterAll(async () => {
  await closeDatabase();
});

async function oneDueContact() {
  const seed = await seedCampaign({
    steps: [
      { delay_days: 0, subject: "S1", body: "B1" },
      { delay_days: 3, subject: "S2", body: "B2" },
    ],
    contacts: [{ email: "cil@prospect.test" }],
  });
  await startCampaign(seed.campaignId);
  await clearPacing(seed.campaignId);
  return seed;
}

async function sendRow(campaignId: string) {
  const [row] = await sql<
    { status: string; error: string | null; attempt_count: number; next_retry_at: Date | null }[]
  >`select status, error, attempt_count, next_retry_at from email_sends where campaign_id = ${campaignId}`;
  return row;
}

async function contactRow(campaignId: string) {
  const [row] = await sql<
    { status: string; current_step: number; last_sent_at: Date | null; last_error: string | null }[]
  >`select status, current_step, last_sent_at, last_error from campaign_contacts where campaign_id = ${campaignId}`;
  return row;
}

describe("selhání před přijetím zprávy serverem", () => {
  it("dočasná chyba: sekvence se neposune a krok se smí zkusit znovu", async () => {
    const seed = await oneDueContact();
    sendMail.mockResolvedValue({
      ok: false, outcome: "failed", retryable: true,
      message: "451 4.3.2 try later", code: null, responseCode: 451,
    });
    await dispatchTick();

    const send = await sendRow(seed.campaignId);
    const contact = await contactRow(seed.campaignId);
    expect(send.status).toBe("failed");
    expect(send.next_retry_at).not.toBeNull();
    // Nic se neposunulo a nic se netváří jako odeslané.
    expect(contact.current_step).toBe(1);
    expect(contact.last_sent_at).toBeNull();
  });

  it("jednoznačná trvalá chyba: žádný další pokus, kontakt označený", async () => {
    const seed = await oneDueContact();
    sendMail.mockResolvedValue({
      ok: false, outcome: "failed", retryable: false,
      message: "550 5.7.1 rejected", code: null, responseCode: 550,
    });
    await dispatchTick();

    const send = await sendRow(seed.campaignId);
    const contact = await contactRow(seed.campaignId);
    expect(send.next_retry_at).toBeNull();
    expect(contact.status).toBe("failed");
    expect(contact.current_step).toBe(1);
  });

  it("chyba spojení před přenosem sekvenci neposune", async () => {
    const seed = await oneDueContact();
    sendMail.mockResolvedValue({
      ok: false, outcome: "failed", retryable: true,
      message: "connect ECONNREFUSED", code: "ESOCKET", responseCode: null,
    });
    await dispatchTick();
    expect((await contactRow(seed.campaignId)).current_step).toBe(1);
  });
});

describe("selhání s neznámým výsledkem", () => {
  it("timeout po DATA se nikdy neopakuje", async () => {
    const seed = await oneDueContact();
    sendMail.mockResolvedValue({
      ok: false, outcome: "unknown", retryable: false,
      message: "socket timeout", code: "ETIMEDOUT", responseCode: null,
    });
    await dispatchTick();

    expect((await sendRow(seed.campaignId)).status).toBe("unknown");
    expect((await contactRow(seed.campaignId)).status).toBe("failed");

    // Další tick ho nesmí vzít znovu.
    sendMail.mockClear();
    await clearPacing(seed.campaignId);
    await dispatchTick();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("pád procesu po claimu: reaper udělá 'neznámo', ne druhý pokus", async () => {
    const seed = await oneDueContact();
    // Worker zemřel mezi claimem a SMTP.
    sendMail.mockImplementation(() => { throw new Error("worker killed"); });
    await dispatchTick().catch(() => {});
    await sql`update email_sends set status = 'sending', claimed_at = now() - interval '3 hours'
               where campaign_id = ${seed.campaignId}`;

    expect(await reapStuckSends()).toBe(1);
    expect((await sendRow(seed.campaignId)).status).toBe("unknown");

    sendMail.mockReset();
    sendMail.mockResolvedValue({ ok: true, messageId: "<x@y>", response: "250" });
    await clearPacing(seed.campaignId);
    await dispatchTick();
    // Ani po zotavení se tentýž krok neodešle znovu.
    expect(sendMail).not.toHaveBeenCalled();
  });

  /**
   * SMTP zprávu PŘIJALO, ale zápis výsledku neprošel.
   *
   * Tohle SMTP protokol vyřešit neumí a aplikace to nepředstírá. Řádek
   * zůstane ve stavu `sending`, reaper z něj udělá `unknown` a kontakt
   * dostane „needs review" - tedy nikdy se neopakuje a člověk to vidí.
   * Cena je možný nedoručený follow-up; cena opaku by byl duplicitní
   * e-mail u prospekta, což je dražší.
   */
  it("SMTP přijalo, databáze ne: zůstane 'neznámo' k ruční kontrole a NIKDY se neopakuje", async () => {
    const seed = await oneDueContact();
    sendMail.mockResolvedValue({ ok: true, messageId: "<doruceno@example.com>", response: "250 ok" });

    // Zápis výsledku "selže": tick proběhne, pak výsledek přepíšeme zpět
    // na claimnutý stav, což je přesně to, co by po pádu zůstalo v DB.
    await dispatchTick();
    await sql`
      update email_sends
         set status = 'sending', sent_at = null, message_id = null,
             claimed_at = now() - interval '3 hours'
       where campaign_id = ${seed.campaignId}`;
    await sql`
      update campaign_contacts set status = 'sent', current_step = 1, last_sent_at = null
       where campaign_id = ${seed.campaignId}`;

    expect(await reapStuckSends()).toBe(1);
    const send = await sendRow(seed.campaignId);
    const contact = await contactRow(seed.campaignId);
    expect(send.status).toBe("unknown");
    expect(contact.status).toBe("failed");
    expect(contact.last_error).toContain("needs review");

    sendMail.mockClear();
    await clearPacing(seed.campaignId);
    await dispatchTick();
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe("sekvence se posouvá jen po prokazatelném přijetí", () => {
  it("úspěch posune krok a další splatnost počítá z reálného sent_at", async () => {
    const seed = await oneDueContact();
    sendMail.mockResolvedValue({ ok: true, messageId: "<a@b>", response: "250" });
    await dispatchTick();

    const [row] = await sql<{ current_step: number; last_sent_at: Date; next_send_at: Date }[]>`
      select current_step, last_sent_at, next_send_at from campaign_contacts
       where campaign_id = ${seed.campaignId}`;
    expect(row.current_step).toBe(2);
    const days = (row.next_send_at.getTime() - row.last_sent_at.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThan(3.1);
  });

  it("opakované spuštění téže úlohy nezaloží druhý záznam", async () => {
    const seed = await oneDueContact();
    sendMail.mockResolvedValue({ ok: true, messageId: "<a@b>", response: "250" });
    await dispatchTick();
    await sql`update campaign_contacts set current_step = 1, next_send_at = now() - interval '1 minute',
                                           status = 'scheduled'
               where campaign_id = ${seed.campaignId}`;
    sendMail.mockClear();
    await clearPacing(seed.campaignId);
    await dispatchTick();

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from email_sends where campaign_id = ${seed.campaignId} and step_number = 1`;
    expect(count).toBe(1);
    expect(sendMail).not.toHaveBeenCalled();
  });
});
