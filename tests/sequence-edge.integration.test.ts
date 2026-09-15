import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { clearPacing, seedCampaign } from "./helpers/fixtures";

/**
 * Sekvence u běžící kampaně.
 *
 * Kampaň se edituje za provozu: přibude krok, ubere se krok, změní se
 * text. Nic z toho nesmí poslat e-mail dvakrát, vrátit kontakt zpátky
 * ani přepsat historii, která už odešla.
 */

const sendMail = vi.hoisted(() => vi.fn());
vi.mock("@/lib/smtp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/smtp")>();
  return { ...actual, sendMail: (...args: unknown[]) => sendMail(...args) };
});

let sql: typeof import("@/lib/db").sql;
let dispatchTick: typeof import("@/lib/engine/dispatch").dispatchTick;
let startCampaign: typeof import("@/lib/queries/campaigns").startCampaign;

beforeEach(async () => {
  await resetDatabase();
  ({ sql } = await import("@/lib/db"));
  ({ dispatchTick } = await import("@/lib/engine/dispatch"));
  ({ startCampaign } = await import("@/lib/queries/campaigns"));
  await sql`update app_settings set test_mode = false where id = true`;
  sendMail.mockReset();
  sendMail.mockImplementation(async () => ({
    ok: true, messageId: `<m${Math.random()}@example.com>`, response: "250",
  }));
});

afterAll(async () => {
  await closeDatabase();
});

/** Odešle další splatný krok a vrátí stav kontaktu. */
async function tick(campaignId: string) {
  await sql`update campaign_contacts set next_send_at = now() - interval '1 minute'
             where campaign_id = ${campaignId} and status in ('scheduled','sent')`;
  await clearPacing(campaignId);
  await dispatchTick();
  const [row] = await sql<
    { status: string; current_step: number; last_sent_at: Date | null; thread_message_id: string | null;
      sender_mailbox_id: string | null }[]
  >`select status, current_step, last_sent_at, thread_message_id, sender_mailbox_id
      from campaign_contacts where campaign_id = ${campaignId}`;
  return row;
}

describe("tvar sekvence", () => {
  it("sekvence o jediném kroku skončí po prvním odeslání", async () => {
    const seed = await seedCampaign({
      steps: [{ delay_days: 0, subject: "Jediný", body: "B" }],
      contacts: [{ email: "a@example.com" }],
    });
    await startCampaign(seed.campaignId);
    const after = await tick(seed.campaignId);
    expect(after.status).toBe("completed");

    // Další tick už nic nepošle.
    sendMail.mockClear();
    await clearPacing(seed.campaignId);
    await dispatchTick();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("nulové zpoždění naplánuje další krok hned, ne do minulosti", async () => {
    const seed = await seedCampaign({
      steps: [
        { delay_days: 0, subject: "1", body: "B" },
        { delay_days: 0, subject: "2", body: "B" },
      ],
      contacts: [{ email: "a@example.com" }],
    });
    await startCampaign(seed.campaignId);
    await tick(seed.campaignId);
    const [row] = await sql<{ next_send_at: Date; last_sent_at: Date }[]>`
      select next_send_at, last_sent_at from campaign_contacts where campaign_id = ${seed.campaignId}`;
    expect(row.next_send_at.getTime()).toBeGreaterThanOrEqual(row.last_sent_at.getTime());
  });

  it("kontakt se nikdy nevrátí na předchozí krok", async () => {
    const seed = await seedCampaign({ contacts: [{ email: "a@example.com" }] });
    await startCampaign(seed.campaignId);
    const steps: number[] = [];
    for (let i = 0; i < 4; i++) {
      const row = await tick(seed.campaignId);
      steps.push(row.current_step);
    }
    // Monotónní: 2, 3, 3(completed)…
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1]);
    }
  });
});

describe("editace sekvence za běhu", () => {
  it("odstranění budoucího kroku kampaň nezastaví ani nespadne", async () => {
    const seed = await seedCampaign({ contacts: [{ email: "a@example.com" }] });
    await startCampaign(seed.campaignId);
    await tick(seed.campaignId); // odešle krok 1, kontakt je na kroku 2

    await sql`delete from sequence_steps where campaign_id = ${seed.campaignId} and step_number = 2`;
    const after = await tick(seed.campaignId);
    // Krok, který neexistuje, sekvenci bezpečně uzavře.
    expect(["completed", "sent"]).toContain(after.status);
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from email_sends where campaign_id = ${seed.campaignId} and step_number = 2`;
    expect(count).toBe(0);
  });

  it("přidání kroku do běžící kampaně nepošle už odeslaný krok znovu", async () => {
    const seed = await seedCampaign({
      steps: [{ delay_days: 0, subject: "1", body: "B" }],
      contacts: [{ email: "a@example.com" }],
    });
    await startCampaign(seed.campaignId);
    await tick(seed.campaignId);

    // Kampaň se po posledním kroku sama uzavřela. Přidání kroku ji
    // ZÁMĚRNĚ nerozjede - dokončená kampaň se musí spustit ručně, jinak
    // by editace sekvence mohla nečekaně rozeslat další vlnu.
    const [closed] = await sql<{ status: string }[]>`
      select status from campaigns where id = ${seed.campaignId}`;
    expect(closed.status).toBe("completed");

    await sql`
      insert into sequence_steps (campaign_id, step_number, delay_days, subject, body)
      values (${seed.campaignId}, 2, 1, 'Nový krok 2', 'B')`;
    await sql`update campaign_contacts set status = 'sent', current_step = 2
               where campaign_id = ${seed.campaignId}`;
    await sql`update campaigns set status = 'active' where id = ${seed.campaignId}`;
    await tick(seed.campaignId);

    const rows = await sql<{ step_number: number }[]>`
      select step_number from email_sends where campaign_id = ${seed.campaignId} order by step_number`;
    expect(rows.map((r) => r.step_number)).toEqual([1, 2]);
  });

  it("změna textu šablony nepřepíše už odeslanou historii", async () => {
    const seed = await seedCampaign({ contacts: [{ email: "a@example.com" }] });
    await startCampaign(seed.campaignId);
    await tick(seed.campaignId);
    const [before] = await sql<{ subject: string; body: string }[]>`
      select subject, body from email_sends where campaign_id = ${seed.campaignId}`;

    await sql`update sequence_steps set subject = 'ÚPLNĚ JINÝ', body = 'jiné'
               where campaign_id = ${seed.campaignId} and step_number = 1`;

    const [after] = await sql<{ subject: string; body: string }[]>`
      select subject, body from email_sends where campaign_id = ${seed.campaignId}`;
    expect(after.subject).toBe(before.subject);
    expect(after.body).toBe(before.body);
  });
});

describe("vlákno a odesílatel", () => {
  it("všechny kroky jednoho kontaktu jdou ze stejné schránky a do jednoho vlákna", async () => {
    const seed = await seedCampaign({ contacts: [{ email: "a@example.com" }] });
    // Druhá schránka do poolu, ať by bylo kam přepnout.
    const { encryptSecret } = await import("@/lib/crypto");
    const [second] = await sql<{ id: string }[]>`
      insert into mailboxes (name, from_name, from_email, smtp_host, smtp_port, smtp_username,
                             smtp_password_enc, smtp_secure, last_test_ok, daily_limit)
      values ('Druhá', 'T', 'druha@example.com', 'smtp.example.com', 465, 'druha@example.com',
              ${encryptSecret("x")}, true, true, 1000)
      returning id`;
    await sql`insert into campaign_mailboxes (campaign_id, mailbox_id) values (${seed.campaignId}, ${second.id})`;
    await startCampaign(seed.campaignId);

    await tick(seed.campaignId);
    const first = await tick(seed.campaignId);
    await tick(seed.campaignId);

    const rows = await sql<{ mailbox_id: string }[]>`
      select distinct mailbox_id from email_sends where campaign_id = ${seed.campaignId}`;
    expect(rows).toHaveLength(1);
    expect(first.thread_message_id).not.toBeNull();

    // Každý follow-up navazuje na Message-ID prvního kroku.
    const calls = sendMail.mock.calls.slice(1);
    for (const [, request] of calls) {
      expect((request as { inReplyTo?: string | null }).inReplyTo).toBe(first.thread_message_id);
    }
  });
});
