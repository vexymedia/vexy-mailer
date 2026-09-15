import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode } from "./helpers/fixtures";
import { encryptSecret } from "@/lib/crypto";

/**
 * Scheduler proti skutečné databázi.
 *
 * Hlavní use case, kvůli kterému tenhle soubor vznikl:
 *
 *     600 kontaktů, 10 schránek, denní limit 100, 70 % nových.
 *     → MAX 100 skutečně odeslaných e-mailů za den. Ne 10 × 100.
 *
 * Testuje se přes `dispatchTick()`, tedy přes to, co opravdu poběží -
 * ne přes pomocné funkce. Aplikace je v režimu simulace: engine projde
 * celý svůj cyklus včetně účtování limitů, jen nesáhne na SMTP.
 * `skipped` (simulovaný send) se do limitu počítá schválně, aby zkouška
 * na sucho dávkovala přesně jako ostrý provoz.
 */

let sql: typeof import("@/lib/db").sql;
let dispatch: typeof import("@/lib/engine/dispatch");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  dispatch = await import("@/lib/engine/dispatch");
});

afterAll(async () => {
  await closeDatabase();
});

interface SetupOptions {
  mailboxes?: number;
  mailboxDailyLimit?: number;
  dailyLimit?: number;
  newRatio?: number;
  /** Kontakty, které ještě nic nedostaly. */
  newContacts?: number;
  /** Kontakty uprostřed sekvence, splatné teď (nebo dřív). */
  dueFollowUps?: number;
  /** O kolik hodin do minulosti posunout splatnost follow-upů. */
  followUpOverdueHours?: number;
}

async function setup(options: SetupOptions = {}) {
  const mailboxCount = options.mailboxes ?? 1;
  const mailboxIds: string[] = [];
  for (let i = 0; i < mailboxCount; i++) {
    const [row] = await sql<{ id: string }[]>`
      insert into mailboxes (name, from_name, from_email, smtp_host, smtp_port, smtp_username,
                             smtp_password_enc, smtp_secure, last_test_ok, daily_limit, timezone)
      values (${`Schránka ${i + 1}`}, 'Tester', ${`sender${i + 1}@example.com`},
              'smtp.example.com', 465, ${`sender${i + 1}@example.com`},
              ${encryptSecret("secret")}, true, true, ${options.mailboxDailyLimit ?? 1000},
              'Europe/Prague')
      returning id
    `;
    mailboxIds.push(row.id);
  }

  const [campaign] = await sql<{ id: string }[]>`
    insert into campaigns (name, daily_limit, new_ratio, send_days,
                           send_start_minute, send_end_minute, timezone, status)
    values ('Kampaň', ${options.dailyLimit ?? 100}, ${options.newRatio ?? 70},
            ${[1, 2, 3, 4, 5, 6, 7] as unknown as number[]}, 0, 1440, 'Europe/Prague', 'active')
    returning id
  `;
  for (const mailboxId of mailboxIds) {
    await sql`insert into campaign_mailboxes (campaign_id, mailbox_id) values (${campaign.id}, ${mailboxId})`;
  }

  const stepIds: string[] = [];
  for (const [index, step] of [
    { delay_days: 0, subject: "Ahoj", body: "První oslovení." },
    { delay_days: 3, subject: "Re: Ahoj", body: "Follow-up 1." },
    { delay_days: 4, subject: "Re: Ahoj", body: "Follow-up 2." },
  ].entries()) {
    const [row] = await sql<{ id: string }[]>`
      insert into sequence_steps (campaign_id, step_number, delay_days, subject, body)
      values (${campaign.id}, ${index + 1}, ${step.delay_days}, ${step.subject}, ${step.body})
      returning id
    `;
    stepIds.push(row.id);
  }

  // Nové kontakty: nikdy nic nedostaly, splatné hned.
  for (let i = 0; i < (options.newContacts ?? 0); i++) {
    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email, first_name, company)
      values (${`new${i}@example.com`}, ${`Nový ${i}`}, 'Acme')
      returning id
    `;
    await sql`
      insert into campaign_contacts (campaign_id, contact_id, status, current_step, next_send_at)
      values (${campaign.id}, ${contact.id}, 'scheduled', 1, now() - interval '1 minute')
    `;
  }

  // Follow-upy: krok 1 už dostaly (last_sent_at není null), splatný je krok 2.
  const overdue = options.followUpOverdueHours ?? 1;
  for (let i = 0; i < (options.dueFollowUps ?? 0); i++) {
    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email, first_name, company)
      values (${`fu${i}@example.com`}, ${`Follow ${i}`}, 'Beta')
      returning id
    `;
    // Starší index = starší splatnost, aby šlo ověřit "nejstarší první".
    const hoursAgo = overdue + (options.dueFollowUps ?? 0) - i;
    const [cc] = await sql<{ id: string }[]>`
      insert into campaign_contacts (campaign_id, contact_id, status, current_step,
                                     next_send_at, last_sent_at, sender_mailbox_id)
      values (${campaign.id}, ${contact.id}, 'sent', 2,
              now() - ${`${hoursAgo} hours`}::interval,
              now() - interval '3 days', ${mailboxIds[i % mailboxIds.length]})
      returning id
    `;
    // Krok 1 v ledgeru, aby historie odpovídala stavu kontaktu.
    await sql`
      insert into email_sends (campaign_id, campaign_contact_id, step_id, step_number, status,
                               to_email, intended_email, subject, body, mailbox_id, pool,
                               claimed_at, sent_at)
      values (${campaign.id}, ${cc.id}, ${stepIds[0]}, 1, 'sent',
              ${`fu${i}@example.com`}, ${`fu${i}@example.com`}, 'Ahoj', 'První oslovení.',
              ${mailboxIds[i % mailboxIds.length]}, 'new',
              now() - interval '3 days', now() - interval '3 days')
    `;
  }

  return { campaignId: campaign.id, mailboxIds, stepIds };
}

/** Odbaví celý den: tiká, dokud engine něco posílá. */
async function runDay(campaignId: string, maxTicks = 400): Promise<number> {
  let sent = 0;
  for (let i = 0; i < maxTicks; i++) {
    // Kurzor rozložení je pro tenhle test šum - zajímá nás strop, ne tempo.
    await sql`update campaigns set next_slot_at = null where id = ${campaignId}`;
    const summary = await dispatch.dispatchTick();
    const outcome = summary.outcomes.find((o) => o.campaignId === campaignId);
    if (!outcome) break;
    if (outcome.action === "sent" || outcome.action === "simulated") {
      sent++;
      continue;
    }
    break;
  }
  return sent;
}

async function counts(campaignId: string) {
  const [row] = await sql<{ total: number; pool_new: number; pool_follow: number }[]>`
    select count(*)::int as total,
           count(*) filter (where pool = 'new')::int as pool_new,
           count(*) filter (where pool = 'follow_up')::int as pool_follow
      from email_sends
     where campaign_id = ${campaignId}
       and status in ('sent', 'unknown', 'skipped')
       and coalesce(sent_at, claimed_at) >= date_trunc('day', now() at time zone 'Europe/Prague')
                                            at time zone 'Europe/Prague'
  `;
  return row;
}

// ==================================================================== strop

describe("tvrdý denní strop", () => {
  it("600 kontaktů a limit 100 → za den odejde přesně 100", async () => {
    const { campaignId } = await setup({ dailyLimit: 100, newRatio: 100, newContacts: 600 });
    await runDay(campaignId);
    expect((await counts(campaignId)).total).toBe(100);
  });

  it("10 schránek limit nenásobí: 100, ne 1000", async () => {
    const { campaignId } = await setup({
      mailboxes: 10,
      mailboxDailyLimit: 100,
      dailyLimit: 100,
      newRatio: 100,
      newContacts: 600,
    });
    await runDay(campaignId);
    expect((await counts(campaignId)).total).toBe(100);
  });

  it("strop se nepřekročí, ani když jsou obě fronty plné", async () => {
    const { campaignId } = await setup({
      dailyLimit: 40, newRatio: 70, newContacts: 300, dueFollowUps: 300,
    });
    await runDay(campaignId);
    expect((await counts(campaignId)).total).toBe(40);
  });
});

// ============================================================ 70/30 alokace

describe("rozdělení nových a follow-upů", () => {
  it("při dostatku obou front drží poměr 70/30", async () => {
    const { campaignId } = await setup({
      dailyLimit: 100, newRatio: 70, newContacts: 300, dueFollowUps: 300,
    });
    await runDay(campaignId);
    const c = await counts(campaignId);
    expect(c.total).toBe(100);
    expect(c.pool_new).toBe(70);
    expect(c.pool_follow).toBe(30);
  });

  it("jen 10 follow-upů → nevyužitá kapacita propadne novým", async () => {
    const { campaignId } = await setup({
      dailyLimit: 100, newRatio: 70, newContacts: 300, dueFollowUps: 10,
    });
    await runDay(campaignId);
    const c = await counts(campaignId);
    expect(c.pool_follow).toBe(10);
    expect(c.pool_new).toBe(90);
    expect(c.total).toBe(100);
  });

  it("jen 20 nových → nevyužitá kapacita propadne follow-upům", async () => {
    const { campaignId } = await setup({
      dailyLimit: 100, newRatio: 70, newContacts: 20, dueFollowUps: 300,
    });
    await runDay(campaignId);
    const c = await counts(campaignId);
    expect(c.pool_new).toBe(20);
    expect(c.pool_follow).toBe(80);
    expect(c.total).toBe(100);
  });

  it("backlog follow-upů nesebere rezervovaný pool nových", async () => {
    const { campaignId } = await setup({
      dailyLimit: 50, newRatio: 70, newContacts: 200, dueFollowUps: 500,
    });
    await runDay(campaignId);
    const c = await counts(campaignId);
    // Cíl pro nové je 35. Backlog 500 follow-upů ho nesmí umazat.
    expect(c.pool_new).toBe(35);
    expect(c.pool_follow).toBe(15);
  });
});

// ======================================================== follow-up backlog

describe("follow-up se neztratí", () => {
  it("45 due follow-upů při cíli 30: 15 zůstane splatných", async () => {
    const { campaignId } = await setup({
      dailyLimit: 100, newRatio: 70, newContacts: 0, dueFollowUps: 45,
    });
    await runDay(campaignId);
    const c = await counts(campaignId);
    // Nové nejsou, takže follow-upy si vezmou i jejich kapacitu -
    // ale je jich jen 45, takže odejde 45. Pro test zbytku snížíme limit.
    expect(c.pool_follow).toBe(45);
  });

  it("nevyužitý follow-up zůstane splatný, nesmaže se a neposune krok", async () => {
    const { campaignId } = await setup({
      dailyLimit: 10, newRatio: 0, newContacts: 0, dueFollowUps: 25,
    });
    await runDay(campaignId);
    const c = await counts(campaignId);
    expect(c.pool_follow).toBe(10);

    const [left] = await sql<{ still_due: number; wrong_step: number; completed: number }[]>`
      select count(*) filter (where cc.next_send_at <= now() and cc.status = 'sent')::int as still_due,
             count(*) filter (where cc.current_step <> 2)::int as wrong_step,
             count(*) filter (where cc.status = 'completed')::int as completed
        from campaign_contacts cc
        left join email_sends es
          on es.campaign_contact_id = cc.id and es.step_number = 2
       where cc.campaign_id = ${campaignId}
         and es.id is null
    `;
    // 15 nedotčených: pořád splatné, pořád na kroku 2, nic dokončeného.
    expect(left.still_due).toBe(15);
    expect(left.wrong_step).toBe(0);
    expect(left.completed).toBe(0);
  });

  it("nejstarší po termínu jde první", async () => {
    const { campaignId } = await setup({
      dailyLimit: 3, newRatio: 0, newContacts: 0, dueFollowUps: 10,
    });
    await runDay(campaignId);

    const rows = await sql<{ intended_email: string }[]>`
      select intended_email from email_sends
       where campaign_id = ${campaignId} and step_number = 2
       order by claimed_at asc
    `;
    // fu0 má nejstarší splatnost (viz setup), pak fu1, fu2.
    expect(rows.map((r) => r.intended_email)).toEqual([
      "fu0@example.com", "fu1@example.com", "fu2@example.com",
    ]);
  });
});

// =============================================================== schránky

describe("schránky", () => {
  it("limit schránky se nepřekročí", async () => {
    const { campaignId, mailboxIds } = await setup({
      mailboxes: 2, mailboxDailyLimit: 7, dailyLimit: 100, newRatio: 100, newContacts: 300,
    });
    await runDay(campaignId);
    const rows = await sql<{ mailbox_id: string; count: number }[]>`
      select mailbox_id, count(*)::int as count from email_sends
       where campaign_id = ${campaignId} group by mailbox_id
    `;
    for (const row of rows) expect(row.count).toBeLessThanOrEqual(7);
    // Dvě schránky po sedmi: dohromady 14, ne 100.
    expect(rows.reduce((sum, r) => sum + r.count, 0)).toBe(14);
    expect(rows).toHaveLength(mailboxIds.length);
  });

  it("vypnutá schránka nedostane práci", async () => {
    const { campaignId, mailboxIds } = await setup({
      mailboxes: 2, mailboxDailyLimit: 1000, dailyLimit: 20, newRatio: 100, newContacts: 100,
    });
    await sql`update mailboxes set enabled = false where id = ${mailboxIds[0]}`;
    await runDay(campaignId);
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from email_sends
       where campaign_id = ${campaignId} and mailbox_id = ${mailboxIds[0]}
    `;
    expect(row.count).toBe(0);
  });

  it("schránka bez úspěšného testu spojení nedostane práci", async () => {
    const { campaignId, mailboxIds } = await setup({
      mailboxes: 2, dailyLimit: 20, newRatio: 100, newContacts: 100,
    });
    await sql`update mailboxes set last_test_ok = null where id = ${mailboxIds[1]}`;
    await runDay(campaignId);
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from email_sends
       where campaign_id = ${campaignId} and mailbox_id = ${mailboxIds[1]}
    `;
    expect(row.count).toBe(0);
  });

  it("schránka sdílená dvěma kampaněmi nepřekročí svůj vlastní denní strop", async () => {
    const { campaignId, mailboxIds, stepIds } = await setup({
      mailboxes: 1, mailboxDailyLimit: 12, dailyLimit: 100, newRatio: 100, newContacts: 100,
    });
    void stepIds;
    // Druhá kampaň nad stejnou schránkou, taky s limitem 100.
    const [second] = await sql<{ id: string }[]>`
      insert into campaigns (name, daily_limit, new_ratio, send_days,
                             send_start_minute, send_end_minute, timezone, status)
      values ('Druhá', 100, 100, ${[1, 2, 3, 4, 5, 6, 7] as unknown as number[]},
              0, 1440, 'Europe/Prague', 'active')
      returning id
    `;
    await sql`insert into campaign_mailboxes (campaign_id, mailbox_id) values (${second.id}, ${mailboxIds[0]})`;
    await sql`
      insert into sequence_steps (campaign_id, step_number, delay_days, subject, body)
      values (${second.id}, 1, 0, 'Ahoj', 'Druhá kampaň.')
    `;
    for (let i = 0; i < 100; i++) {
      const [contact] = await sql<{ id: string }[]>`
        insert into contacts (email) values (${`second${i}@example.com`}) returning id
      `;
      await sql`
        insert into campaign_contacts (campaign_id, contact_id, status, current_step, next_send_at)
        values (${second.id}, ${contact.id}, 'scheduled', 1, now() - interval '1 minute')
      `;
    }

    for (let i = 0; i < 60; i++) {
      await sql`update campaigns set next_slot_at = null`;
      const summary = await dispatch.dispatchTick();
      if (!summary.outcomes.some((o) => o.action === "sent" || o.action === "simulated")) break;
    }

    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from email_sends where mailbox_id = ${mailboxIds[0]}
    `;
    // 12, ne 12 na kampaň a rozhodně ne 200.
    expect(row.count).toBe(12);
    void campaignId;
  });
});

// ============================================================ concurrency

describe("souběžní workeři", () => {
  it("nepřekročí strop kampaně, ani když běží najednou", async () => {
    const { campaignId } = await setup({
      mailboxes: 4, mailboxDailyLimit: 1000, dailyLimit: 25, newRatio: 100, newContacts: 300,
    });

    // Bez globálního zámku dispatcheru: testuje se transakční rezervace,
    // ne to, že se ticky navzájem vyloučí. Zámek je druhá pojistka, ale
    // jeho lease může uprostřed dlouhého ticku vypršet - a přesně tam
    // vzniká souběh, který musí ustát databáze.
    const { processCampaignForTest } = await import("@/lib/engine/dispatch");
    const settings = await (await import("@/lib/settings")).getSettings();

    for (let round = 0; round < 12; round++) {
      await sql`update campaigns set next_slot_at = null where id = ${campaignId}`;
      const [campaign] = await sql<import("@/lib/types").Campaign[]>`
        select * from campaigns where id = ${campaignId}
      `;
      await Promise.all(
        Array.from({ length: 6 }, () => processCampaignForTest(campaign, settings)),
      );
    }

    expect((await counts(campaignId)).total).toBeLessThanOrEqual(25);
  });

  it("nepřekročí strop schránky, ani když běží najednou", async () => {
    const { campaignId, mailboxIds } = await setup({
      mailboxes: 1, mailboxDailyLimit: 9, dailyLimit: 1000, newRatio: 100, newContacts: 200,
    });
    const { processCampaignForTest } = await import("@/lib/engine/dispatch");
    const settings = await (await import("@/lib/settings")).getSettings();

    for (let round = 0; round < 8; round++) {
      await sql`update campaigns set next_slot_at = null where id = ${campaignId}`;
      const [campaign] = await sql<import("@/lib/types").Campaign[]>`
        select * from campaigns where id = ${campaignId}
      `;
      await Promise.all(
        Array.from({ length: 5 }, () => processCampaignForTest(campaign, settings)),
      );
    }

    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from email_sends where mailbox_id = ${mailboxIds[0]}
    `;
    expect(row.count).toBeLessThanOrEqual(9);
  });

  it("stejný krok nejde odeslat dvakrát", async () => {
    const { campaignId } = await setup({ dailyLimit: 100, newRatio: 100, newContacts: 5 });
    await runDay(campaignId);
    const [row] = await sql<{ dupes: number }[]>`
      select count(*)::int as dupes from (
        select campaign_contact_id, step_id, count(*) as n
          from email_sends where campaign_id = ${campaignId}
         group by campaign_contact_id, step_id having count(*) > 1
      ) d
    `;
    expect(row.dupes).toBe(0);
  });
});

// ======================================================= sekvence a stavy

describe("sekvence se posouvá až po skutečném odeslání", () => {
  it("úspěšný send posune krok a další splatnost počítá z reálného sent_at", async () => {
    const { campaignId } = await setup({ dailyLimit: 1, newRatio: 100, newContacts: 1 });
    await runDay(campaignId);

    const [cc] = await sql<
      { current_step: number; status: string; last_sent_at: Date; next_send_at: Date }[]
    >`select current_step, status, last_sent_at, next_send_at from campaign_contacts
       where campaign_id = ${campaignId}`;
    expect(cc.current_step).toBe(2);
    expect(cc.status).toBe("sent");
    // Krok 2 má delay 3 dny. Splatnost musí vyjít z last_sent_at, ne
    // z původně plánovaného času.
    const deltaDays = (cc.next_send_at.getTime() - cc.last_sent_at.getTime()) / 86_400_000;
    expect(deltaDays).toBeGreaterThan(2.9);
    expect(deltaDays).toBeLessThan(3.1);
  });

  it("odpověď před odesláním zruší frontovaný follow-up", async () => {
    const { campaignId } = await setup({ dailyLimit: 10, newRatio: 0, dueFollowUps: 3 });
    await sql`
      update campaign_contacts set status = 'replied', replied_at = now(), next_send_at = null
       where campaign_id = ${campaignId}
    `;
    await runDay(campaignId);
    expect((await counts(campaignId)).total).toBe(0);
  });

  it("suppression před odesláním zruší frontovaný krok", async () => {
    const { campaignId } = await setup({ dailyLimit: 10, newRatio: 100, newContacts: 3 });
    await sql`
      insert into suppression_list (email, reason, reason_code)
      select email, 'test', 'manual_dnc' from contacts
    `;
    await runDay(campaignId);
    expect((await counts(campaignId)).total).toBe(0);
  });

  it("terminální stav z CRM zastaví e-mail stejně jako odpověď", async () => {
    const { campaignId } = await setup({ dailyLimit: 10, newRatio: 100, newContacts: 3 });
    await sql`update campaign_contacts set call_status = 'meeting_booked' where campaign_id = ${campaignId}`;
    await runDay(campaignId);
    // Ani se nezaloží: uzavřený kontakt nesmí sníst slot z denního limitu.
    const [row] = await sql<{ any_send: number }[]>`
      select count(*)::int as any_send from email_sends where campaign_id = ${campaignId}
    `;
    expect(row.any_send).toBe(0);
  });

  it("pozastavená kampaň neodešle nic", async () => {
    const { campaignId } = await setup({ dailyLimit: 10, newRatio: 100, newContacts: 5 });
    await sql`update campaigns set status = 'paused' where id = ${campaignId}`;
    await runDay(campaignId);
    expect((await counts(campaignId)).total).toBe(0);
  });
});
