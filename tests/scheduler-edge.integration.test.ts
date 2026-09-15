import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode } from "./helpers/fixtures";
import { encryptSecret } from "@/lib/crypto";
import { planPools, poolTargets } from "@/lib/engine/pools";

/**
 * Hraniční případy scheduleru proti skutečné databázi.
 *
 * Doplňuje `scheduler.integration.test.ts`, který pokrývá hlavní scénář.
 * Tady jsou věci, které se v provozu stanou zřídka, ale když se stanou,
 * buď se překročí limit, nebo se tiše zastaví odesílání - a obojí se
 * pozná až pozdě.
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

interface Setup {
  mailboxes?: number;
  mailboxLimits?: number[];
  dailyLimit?: number;
  newRatio?: number;
  newContacts?: number;
  dueFollowUps?: number;
  timezone?: string;
}

async function setup(options: Setup = {}) {
  const tz = options.timezone ?? "Europe/Prague";
  const count = options.mailboxes ?? 1;
  const mailboxIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const limit = options.mailboxLimits?.[i] ?? 1000;
    const [row] = await sql<{ id: string }[]>`
      insert into mailboxes (name, from_name, from_email, smtp_host, smtp_port, smtp_username,
                             smtp_password_enc, smtp_secure, last_test_ok, daily_limit, timezone)
      values (${`M${i + 1}`}, 'T', ${`s${i + 1}@example.com`}, 'smtp.example.com', 465,
              ${`s${i + 1}@example.com`}, ${encryptSecret("x")}, true, true, ${limit}, ${tz})
      returning id`;
    mailboxIds.push(row.id);
  }

  const [campaign] = await sql<{ id: string }[]>`
    insert into campaigns (name, daily_limit, new_ratio, send_days, send_start_minute,
                           send_end_minute, timezone, status)
    values ('K', ${options.dailyLimit ?? 100}, ${options.newRatio ?? 70},
            ${[1, 2, 3, 4, 5, 6, 7] as unknown as number[]}, 0, 1440, ${tz}, 'active')
    returning id`;
  for (const id of mailboxIds) {
    await sql`insert into campaign_mailboxes (campaign_id, mailbox_id) values (${campaign.id}, ${id})`;
  }

  const stepIds: string[] = [];
  for (const [index, delay] of [0, 3, 4].entries()) {
    const [row] = await sql<{ id: string }[]>`
      insert into sequence_steps (campaign_id, step_number, delay_days, subject, body)
      values (${campaign.id}, ${index + 1}, ${delay}, ${`Krok ${index + 1}`}, 'text')
      returning id`;
    stepIds.push(row.id);
  }

  for (let i = 0; i < (options.newContacts ?? 0); i++) {
    const [c] = await sql<{ id: string }[]>`
      insert into contacts (email) values (${`n${i}@example.com`}) returning id`;
    await sql`
      insert into campaign_contacts (campaign_id, contact_id, status, current_step, next_send_at)
      values (${campaign.id}, ${c.id}, 'scheduled', 1, now() - interval '1 minute')`;
  }
  for (let i = 0; i < (options.dueFollowUps ?? 0); i++) {
    const [c] = await sql<{ id: string }[]>`
      insert into contacts (email) values (${`f${i}@example.com`}) returning id`;
    const [cc] = await sql<{ id: string }[]>`
      insert into campaign_contacts (campaign_id, contact_id, status, current_step,
                                     next_send_at, last_sent_at, sender_mailbox_id)
      values (${campaign.id}, ${c.id}, 'sent', 2,
              now() - ${`${(options.dueFollowUps ?? 0) - i + 1} hours`}::interval,
              now() - interval '3 days', ${mailboxIds[i % mailboxIds.length]})
      returning id`;
    await sql`
      insert into email_sends (campaign_id, campaign_contact_id, step_id, step_number, status,
                               to_email, intended_email, subject, body, mailbox_id, pool,
                               claimed_at, sent_at)
      values (${campaign.id}, ${cc.id}, ${stepIds[0]}, 1, 'sent', ${`f${i}@example.com`},
              ${`f${i}@example.com`}, 'Krok 1', 'text', ${mailboxIds[i % mailboxIds.length]},
              'new', now() - interval '3 days', now() - interval '3 days')`;
  }
  return { campaignId: campaign.id, mailboxIds, stepIds };
}

async function runDay(campaignId: string, maxTicks = 400) {
  for (let i = 0; i < maxTicks; i++) {
    await sql`update campaigns set next_slot_at = null where id = ${campaignId}`;
    const summary = await dispatch.dispatchTick();
    const outcome = summary.outcomes.find((o) => o.campaignId === campaignId);
    if (!outcome || (outcome.action !== "sent" && outcome.action !== "simulated")) return outcome;
  }
  return undefined;
}

async function sentToday(campaignId: string, tz = "Europe/Prague") {
  const [row] = await sql<{ total: number; pool_new: number; pool_follow: number }[]>`
    select count(*)::int as total,
           count(*) filter (where pool = 'new')::int as pool_new,
           count(*) filter (where pool = 'follow_up')::int as pool_follow
      from email_sends
     where campaign_id = ${campaignId}
       and status in ('sending','sent','unknown','skipped')
       and coalesce(sent_at, claimed_at)
           >= date_trunc('day', now() at time zone ${tz}) at time zone ${tz}`;
  return row;
}

// ===================================================== limity a zaokrouhlení

describe("hraniční limity", () => {
  it("limit 0 databáze vůbec nepustí", async () => {
    // Kampaň, která nesmí nic poslat, je rozbité nastavení, ne stav.
    // Constraint je tu od 0001 a je to správně - test hlídá, že zůstal.
    await expect(setup({ dailyLimit: 0, newContacts: 10 })).rejects.toThrow(/daily_limit/);
  });

  it("limit 0 v čisté aritmetice stejně nic nepustí", () => {
    // Pojistka pro případ, že by limit 0 někdy dorazil jinou cestou.
    expect(planPools({ dailyLimit: 0, newRatio: 70, sentNew: 0, sentFollowUp: 0 }).capReached).toBe(true);
  });

  it("limit 1 odešle právě jednu", async () => {
    const { campaignId } = await setup({ dailyLimit: 1, newContacts: 10, dueFollowUps: 10 });
    await runDay(campaignId);
    expect((await sentToday(campaignId)).total).toBe(1);
  });

  it("liché limity nikdy nepřetečou ani neztratí slot", async () => {
    for (const limit of [3, 7, 13, 17]) {
      await resetDatabase();
      await enableSimulateMode();
      const { campaignId } = await setup({ dailyLimit: limit, newRatio: 70, newContacts: 100, dueFollowUps: 100 });
      await runDay(campaignId);
      const c = await sentToday(campaignId);
      expect(c.total).toBe(limit);
      expect(c.pool_new + c.pool_follow).toBe(limit);
    }
  });

  it("zaokrouhlení poměru je předvídatelné a součet je vždy limit", () => {
    // Half-up na nových, zbytek follow-upům. Žádný slot se neztratí.
    expect(poolTargets(7, 70)).toEqual({ new: 5, follow_up: 2 });
    expect(poolTargets(3, 50)).toEqual({ new: 2, follow_up: 1 });
    expect(poolTargets(1, 70)).toEqual({ new: 1, follow_up: 0 });
    expect(poolTargets(1, 30)).toEqual({ new: 0, follow_up: 1 });
    for (let limit = 0; limit <= 200; limit++) {
      for (const ratio of [0, 1, 33, 50, 70, 99, 100]) {
        const t = poolTargets(limit, ratio);
        expect(t.new + t.follow_up).toBe(limit);
      }
    }
  });
});

describe("krajní poměry", () => {
  it("0/100 pošle jen follow-upy, dokud nějaké jsou", async () => {
    const { campaignId } = await setup({ dailyLimit: 20, newRatio: 0, newContacts: 100, dueFollowUps: 12 });
    await runDay(campaignId);
    const c = await sentToday(campaignId);
    expect(c.pool_follow).toBe(12);
    // Zbytek přeteče novým - poměr je cíl, ne rezervace.
    expect(c.pool_new).toBe(8);
    expect(c.total).toBe(20);
  });

  it("100/0 pošle jen nové, dokud nějaké jsou", async () => {
    const { campaignId } = await setup({ dailyLimit: 20, newRatio: 100, newContacts: 12, dueFollowUps: 100 });
    await runDay(campaignId);
    const c = await sentToday(campaignId);
    expect(c.pool_new).toBe(12);
    expect(c.pool_follow).toBe(8);
  });

  it("prázdný pool nezablokuje kapacitu druhého", async () => {
    const { campaignId } = await setup({ dailyLimit: 25, newRatio: 70, newContacts: 0, dueFollowUps: 100 });
    await runDay(campaignId);
    expect((await sentToday(campaignId)).pool_follow).toBe(25);
  });
});

// ====================================================== změny během dne

describe("změny nastavení během dne", () => {
  it("zvýšení limitu během dne pustí zbytek, ale nezapomene odeslané", async () => {
    const { campaignId } = await setup({ dailyLimit: 10, newRatio: 100, newContacts: 100 });
    await runDay(campaignId);
    expect((await sentToday(campaignId)).total).toBe(10);

    await sql`update campaigns set daily_limit = 25 where id = ${campaignId}`;
    await runDay(campaignId);
    // 25 celkem, ne 10 + 25.
    expect((await sentToday(campaignId)).total).toBe(25);
  });

  it("snížení limitu pod počet odeslaných okamžitě zastaví", async () => {
    const { campaignId } = await setup({ dailyLimit: 30, newRatio: 100, newContacts: 100 });
    await runDay(campaignId);
    expect((await sentToday(campaignId)).total).toBe(30);

    await sql`update campaigns set daily_limit = 10 where id = ${campaignId}`;
    const outcome = await runDay(campaignId);
    expect(outcome?.action).toBe("daily_limit_reached");
    // Nic navíc a hlavně nic se nemaže.
    expect((await sentToday(campaignId)).total).toBe(30);
  });

  it("změna poměru během dne platí od dalšího ticku", async () => {
    const { campaignId } = await setup({ dailyLimit: 20, newRatio: 100, newContacts: 100, dueFollowUps: 100 });
    // Půlka dne se 100 % nových.
    for (let i = 0; i < 10; i++) {
      await sql`update campaigns set next_slot_at = null where id = ${campaignId}`;
      await dispatch.dispatchTick();
    }
    expect((await sentToday(campaignId)).pool_new).toBe(10);

    await sql`update campaigns set new_ratio = 0 where id = ${campaignId}`;
    await runDay(campaignId);
    const c = await sentToday(campaignId);
    expect(c.total).toBe(20);
    // Cíl pro nové je teď 0, nových už je 10 - zbytek jde follow-upům.
    expect(c.pool_follow).toBe(10);
  });

  it("pozastavení kampaně zastaví odesílání okamžitě", async () => {
    const { campaignId } = await setup({ dailyLimit: 50, newRatio: 100, newContacts: 100 });
    for (let i = 0; i < 5; i++) {
      await sql`update campaigns set next_slot_at = null where id = ${campaignId}`;
      await dispatch.dispatchTick();
    }
    const before = (await sentToday(campaignId)).total;
    await sql`update campaigns set status = 'paused' where id = ${campaignId}`;
    await runDay(campaignId);
    expect((await sentToday(campaignId)).total).toBe(before);
  });
});

// ========================================================== účetní den

describe("účetní den a timezone", () => {
  it("odeslání z včerejška se nepočítá do dnešního limitu", async () => {
    const { campaignId, mailboxIds, stepIds } = await setup({
      dailyLimit: 5, newRatio: 100, newContacts: 50,
    });
    // Dvacet odeslání datovaných před dnešní místní půlnoc.
    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email) values ('vcera@example.com') returning id`;
    const [cc] = await sql<{ id: string }[]>`
      insert into campaign_contacts (campaign_id, contact_id, status, current_step)
      values (${campaignId}, ${contact.id}, 'completed', 3) returning id`;
    await sql`
      insert into email_sends (campaign_id, campaign_contact_id, step_id, step_number, status,
                               to_email, intended_email, subject, body, mailbox_id, pool,
                               claimed_at, sent_at)
      values (${campaignId}, ${cc.id}, ${stepIds[0]}, 1, 'sent', 'vcera@example.com',
              'vcera@example.com', 'x', 'y', ${mailboxIds[0]}, 'new',
              date_trunc('day', now() at time zone 'Europe/Prague') at time zone 'Europe/Prague'
                - interval '2 hours',
              date_trunc('day', now() at time zone 'Europe/Prague') at time zone 'Europe/Prague'
                - interval '2 hours')`;

    await runDay(campaignId);
    // Pět dnešních. Včerejšek limit nesnědl.
    expect((await sentToday(campaignId)).total).toBe(5);
  });

  it("den se počítá v timezone kampaně, ne v UTC", async () => {
    // Pacific je 9-10 hodin za Prahou: hranice dne je jinde.
    const { campaignId, mailboxIds, stepIds } = await setup({
      dailyLimit: 3, newRatio: 100, newContacts: 20, timezone: "Pacific/Auckland",
    });
    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email) values ('hranice@example.com') returning id`;
    const [cc] = await sql<{ id: string }[]>`
      insert into campaign_contacts (campaign_id, contact_id, status, current_step)
      values (${campaignId}, ${contact.id}, 'completed', 3) returning id`;
    // Těsně PŘED aucklandskou půlnocí: do dneška se nepočítá.
    await sql`
      insert into email_sends (campaign_id, campaign_contact_id, step_id, step_number, status,
                               to_email, intended_email, subject, body, mailbox_id, pool,
                               claimed_at, sent_at)
      values (${campaignId}, ${cc.id}, ${stepIds[0]}, 1, 'sent', 'hranice@example.com',
              'hranice@example.com', 'x', 'y', ${mailboxIds[0]}, 'new',
              date_trunc('day', now() at time zone 'Pacific/Auckland') at time zone 'Pacific/Auckland'
                - interval '1 minute',
              date_trunc('day', now() at time zone 'Pacific/Auckland') at time zone 'Pacific/Auckland'
                - interval '1 minute')`;
    await runDay(campaignId);
    expect((await sentToday(campaignId, "Pacific/Auckland")).total).toBe(3);
  });
});

// ============================================================== schránky

describe("schránky", () => {
  it("rozdílné limity: každá dostane jen svoje", async () => {
    const { campaignId, mailboxIds } = await setup({
      mailboxes: 3, mailboxLimits: [2, 5, 9], dailyLimit: 100, newRatio: 100, newContacts: 100,
    });
    await runDay(campaignId);
    const rows = await sql<{ mailbox_id: string; count: number }[]>`
      select mailbox_id, count(*)::int as count from email_sends
       where campaign_id = ${campaignId} group by mailbox_id`;
    const byId = Object.fromEntries(rows.map((r) => [r.mailbox_id, r.count]));
    expect(byId[mailboxIds[0]]).toBe(2);
    expect(byId[mailboxIds[1]]).toBe(5);
    expect(byId[mailboxIds[2]]).toBe(9);
    expect((await sentToday(campaignId)).total).toBe(16);
  });

  it("všechny schránky vyčerpané → hlásí nedostatek odesílatele, ne 'nic ke zpracování'", async () => {
    const { campaignId } = await setup({
      mailboxes: 2, mailboxLimits: [1, 1], dailyLimit: 100, newRatio: 100, newContacts: 50,
    });
    const outcome = await runDay(campaignId);
    expect((await sentToday(campaignId)).total).toBe(2);
    expect(outcome?.action).toBe("no_sender_available");
  });

  it("všechny schránky vypnuté → nic neodejde", async () => {
    const { campaignId } = await setup({ mailboxes: 3, dailyLimit: 50, newRatio: 100, newContacts: 50 });
    await sql`update mailboxes set enabled = false`;
    await runDay(campaignId);
    expect((await sentToday(campaignId)).total).toBe(0);
  });

  it("kontakt připnutý k vypnuté schránce se NEPŘEHODÍ na jinou", async () => {
    const { campaignId, mailboxIds } = await setup({
      mailboxes: 2, dailyLimit: 50, newRatio: 100, newContacts: 4,
    });
    await runDay(campaignId);
    const pinned = await sql<{ id: string; sender_mailbox_id: string }[]>`
      select id, sender_mailbox_id from campaign_contacts
       where campaign_id = ${campaignId} and sender_mailbox_id = ${mailboxIds[0]}`;
    expect(pinned.length).toBeGreaterThan(0);

    // Posuneme je na další krok a vypneme jejich schránku.
    await sql`
      update campaign_contacts set next_send_at = now() - interval '1 minute'
       where campaign_id = ${campaignId}`;
    await sql`update mailboxes set enabled = false where id = ${mailboxIds[0]}`;
    await runDay(campaignId);

    const after = await sql<{ mailbox_id: string }[]>`
      select distinct es.mailbox_id from email_sends es
       where es.campaign_contact_id = any(${pinned.map((p) => p.id)})`;
    // Nikdy jinou schránkou: vlákno se kvůli odeslání nerozbije.
    expect(after.map((a) => a.mailbox_id)).toEqual([mailboxIds[0]]);
  });

  it("dvě kampaně s různou timezone nad jednou schránkou nepřekročí její limit", async () => {
    const { campaignId, mailboxIds } = await setup({
      mailboxes: 1, mailboxLimits: [8], dailyLimit: 100, newRatio: 100, newContacts: 100,
      timezone: "Europe/Prague",
    });
    const [second] = await sql<{ id: string }[]>`
      insert into campaigns (name, daily_limit, new_ratio, send_days, send_start_minute,
                             send_end_minute, timezone, status)
      values ('Druhá', 100, 100, ${[1, 2, 3, 4, 5, 6, 7] as unknown as number[]},
              0, 1440, 'Pacific/Auckland', 'active')
      returning id`;
    await sql`insert into campaign_mailboxes (campaign_id, mailbox_id) values (${second.id}, ${mailboxIds[0]})`;
    await sql`
      insert into sequence_steps (campaign_id, step_number, delay_days, subject, body)
      values (${second.id}, 1, 0, 'x', 'y')`;
    for (let i = 0; i < 50; i++) {
      const [c] = await sql<{ id: string }[]>`
        insert into contacts (email) values (${`d${i}@example.com`}) returning id`;
      await sql`
        insert into campaign_contacts (campaign_id, contact_id, status, current_step, next_send_at)
        values (${second.id}, ${c.id}, 'scheduled', 1, now() - interval '1 minute')`;
    }

    for (let i = 0; i < 40; i++) {
      await sql`update campaigns set next_slot_at = null`;
      const s = await dispatch.dispatchTick();
      if (!s.outcomes.some((o) => o.action === "sent" || o.action === "simulated")) break;
    }
    const [row] = await sql<{ count: number }[]>`
      select count(*)::int as count from email_sends where mailbox_id = ${mailboxIds[0]}`;
    // Osm, ne osm na kampaň. Účetní období schránky je JEJÍ timezone.
    expect(row.count).toBe(8);
    void campaignId;
  });
});

// ========================================================= opakované ticky

describe("opakované a souběžné ticky", () => {
  it("opakovaný tick nad vyčerpanou kampaní nic nezmění", async () => {
    const { campaignId } = await setup({ dailyLimit: 5, newRatio: 100, newContacts: 50 });
    await runDay(campaignId);
    const before = await sentToday(campaignId);
    for (let i = 0; i < 5; i++) {
      await sql`update campaigns set next_slot_at = null where id = ${campaignId}`;
      await dispatch.dispatchTick();
    }
    expect(await sentToday(campaignId)).toEqual(before);
  });

  it("vypršení zámku dispatcheru nepustí přes strop", async () => {
    const { campaignId } = await setup({
      mailboxes: 4, dailyLimit: 15, newRatio: 100, newContacts: 200,
    });
    // Zámek necháme viset jako vypršelý: každý tick si ho vezme znovu,
    // takže se ticky můžou překrývat přesně jako v produkci po timeoutu.
    for (let round = 0; round < 10; round++) {
      await sql`update worker_locks set locked_until = now() - interval '1 hour'`;
      await sql`update campaigns set next_slot_at = null where id = ${campaignId}`;
      await Promise.all([dispatch.dispatchTick(), dispatch.dispatchTick(), dispatch.dispatchTick()]);
    }
    expect((await sentToday(campaignId)).total).toBeLessThanOrEqual(15);
  });

  it("pád po claimnutí nechá záznam dohledatelný a neodešle podruhé", async () => {
    const { campaignId, mailboxIds, stepIds } = await setup({
      dailyLimit: 10, newRatio: 100, newContacts: 3,
    });
    const [cc] = await sql<{ id: string }[]>`
      select id from campaign_contacts where campaign_id = ${campaignId} limit 1`;
    // Osiřelý claim, jako po zabitém workeru.
    await sql`
      insert into email_sends (campaign_id, campaign_contact_id, step_id, step_number, status,
                               to_email, intended_email, subject, body, mailbox_id, pool, claimed_at)
      values (${campaignId}, ${cc.id}, ${stepIds[0]}, 1, 'sending', 'x@example.com',
              'x@example.com', 's', 'b', ${mailboxIds[0]}, 'new', now() - interval '2 hours')`;

    const reaped = await dispatch.reapStuckSends();
    expect(reaped).toBe(1);
    const [row] = await sql<{ status: string; error: string }[]>`
      select status, error from email_sends where campaign_contact_id = ${cc.id}`;
    // Nikdy se neopakuje: mohl už dorazit.
    expect(row.status).toBe("unknown");
    expect(row.error).toContain("not be retried");

    await runDay(campaignId);
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from email_sends where campaign_contact_id = ${cc.id}`;
    expect(count).toBe(1);
  });
});

// ============================================================ pool plán

describe("plán poolů u hraničních hodnot", () => {
  it("limit 0 nevrátí žádný pool", () => {
    const plan = planPools({ dailyLimit: 0, newRatio: 70, sentNew: 0, sentFollowUp: 0 });
    expect(plan.capReached).toBe(true);
    expect(plan.order).toEqual([]);
  });

  it("odeslaných víc než limit znamená vyčerpáno, ne záporný zbytek", () => {
    const plan = planPools({ dailyLimit: 10, newRatio: 70, sentNew: 30, sentFollowUp: 5 });
    expect(plan.capReached).toBe(true);
    expect(plan.remainingTotal).toBe(0);
  });
});
