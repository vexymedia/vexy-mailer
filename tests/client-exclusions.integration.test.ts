import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Vyloučení firmy pro JEDNOHO klienta.
 *
 * Věc, kvůli které to existuje: „Acme je už klientem ASN Plus" nesmí
 * schovat Acme celé VEXY databázi. A opačně - zrušení vyloučení nesmí
 * jedním kliknutím vypustit všechny follow-upy, které se mezitím
 * nahromadily.
 */

let sql: typeof import("@/lib/db").sql;
let suppression: typeof import("@/lib/queries/suppression");
let dispatch: typeof import("@/lib/engine/dispatch");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  suppression = await import("@/lib/queries/suppression");
  dispatch = await import("@/lib/engine/dispatch");
});

afterAll(async () => {
  await closeDatabase();
});

/** Jedna firma, dva klienti, každý se svou kampaní na vlastní kontakt. */
async function twoClients() {
  const [asn] = await sql<{ id: string }[]>`insert into clients (name) values ('ASN Plus') returning id`;
  const [vexy] = await sql<{ id: string }[]>`insert into clients (name) values ('VEXY') returning id`;
  const [company] = await sql<{ id: string }[]>`
    insert into companies (name, status, ico) values ('Sdílená a.s.', 'ready', '25596641') returning id`;

  const campaigns: Record<string, string> = {};
  for (const [label, clientId] of [["asn", asn.id], ["vexy", vexy.id]] as const) {
    const seed = await seedCampaign({ contacts: [{ email: `${label}@sdilena.test`, company: "Sdílená a.s." }] });
    await sql`update campaigns set client_id = ${clientId}, status = 'active' where id = ${seed.campaignId}`;
    await sql`update contacts set company_id = ${company.id} where email = ${`${label}@sdilena.test`}`;
    await sql`update campaign_contacts set status = 'scheduled', next_send_at = now() - interval '1 minute'
               where campaign_id = ${seed.campaignId}`;
    campaigns[label] = seed.campaignId;
  }
  return { asnId: asn.id, vexyId: vexy.id, companyId: company.id, campaigns };
}

async function runTicks(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await sql`update campaigns set next_slot_at = null`;
    await dispatch.dispatchTick();
  }
}

async function sendCounts(campaigns: Record<string, string>) {
  const [row] = await sql<{ asn: number; vexy: number }[]>`
    select count(*) filter (where campaign_id = ${campaigns.asn})::int as asn,
           count(*) filter (where campaign_id = ${campaigns.vexy})::int as vexy
      from email_sends`;
  return row;
}

describe("izolace klientů", () => {
  it("vyloučení pro ASN Plus nechá firmu dostupnou pro VEXY", async () => {
    const { asnId, companyId, campaigns } = await twoClients();
    await suppression.excludeCompanyForClient({ clientId: asnId, companyId });
    await runTicks();

    const counts = await sendCounts(campaigns);
    expect(counts.asn).toBe(0);
    expect(counts.vexy).toBeGreaterThan(0);
  });

  it("nezmění globální status firmy", async () => {
    const { asnId, companyId } = await twoClients();
    await suppression.excludeCompanyForClient({ clientId: asnId, companyId });
    const [company] = await sql<{ status: string }[]>`
      select status from companies where id = ${companyId}`;
    expect(company.status).toBe("ready");
  });

  it("nezaloží globální suppression e-mailu", async () => {
    const { asnId, companyId } = await twoClients();
    await suppression.excludeCompanyForClient({ clientId: asnId, companyId });
    const [row] = await sql<{ count: number }[]>`select count(*)::int as count from suppression_list`;
    expect(row.count).toBe(0);
  });

  it("opakované vyloučení nezaloží duplicitu", async () => {
    const { asnId, companyId } = await twoClients();
    await suppression.excludeCompanyForClient({ clientId: asnId, companyId, reason: "První" });
    await suppression.excludeCompanyForClient({ clientId: asnId, companyId, reason: "Druhý" });
    const rows = await sql<{ reason: string }[]>`
      select reason from client_company_exclusions where client_id = ${asnId} and company_id = ${companyId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("Druhý");
  });

  it("jedna firma může být vyloučená pro víc klientů zvlášť", async () => {
    const { asnId, vexyId, companyId, campaigns } = await twoClients();
    await suppression.excludeCompanyForClient({ clientId: asnId, companyId });
    await suppression.excludeCompanyForClient({ clientId: vexyId, companyId });
    await runTicks();
    const counts = await sendCounts(campaigns);
    expect(counts.asn).toBe(0);
    expect(counts.vexy).toBe(0);
  });
});

describe("vyloučení uprostřed běžící sekvence", () => {
  it("zastaví budoucí kroky", async () => {
    const { asnId, companyId, campaigns } = await twoClients();
    await runTicks(2);
    const before = (await sendCounts(campaigns)).asn;
    expect(before).toBeGreaterThan(0);

    await suppression.excludeCompanyForClient({ clientId: asnId, companyId });
    await sql`update campaign_contacts set next_send_at = now() - interval '1 minute'
               where campaign_id = ${campaigns.asn} and status in ('scheduled','sent')`;
    await runTicks();
    expect((await sendCounts(campaigns)).asn).toBe(before);
  });

  it("ZRUŠENÍ vyloučení neodešle nahromaděné follow-upy", async () => {
    const { asnId, companyId, campaigns } = await twoClients();
    await runTicks(2);
    const before = (await sendCounts(campaigns)).asn;

    await suppression.excludeCompanyForClient({ clientId: asnId, companyId });

    // Vyloučení naplánované kroky ZAHODÍ. Kdyby je jen filtrovalo,
    // `next_send_at` by dál ubíhalo do minulosti a v den zrušení by
    // odletěla celá zadržená várka.
    const [paused] = await sql<{ pending: number }[]>`
      select count(*) filter (where next_send_at is not null)::int as pending
        from campaign_contacts where campaign_id = ${campaigns.asn}`;
    expect(paused.pending).toBe(0);

    const [row] = await sql<{ id: string }[]>`
      select id from client_company_exclusions where client_id = ${asnId} and company_id = ${companyId}`;
    await suppression.removeClientExclusion(row.id);
    await runTicks();

    // Sekvence se sama nerozjede. Kdo ji chce zpátky, naplánuje ji.
    expect((await sendCounts(campaigns)).asn).toBe(before);
  });
});

describe("volání", () => {
  it("vyloučená firma se neobjeví ve frontě volání daného klienta", async () => {
    const { asnId, companyId, campaigns } = await twoClients();
    const calling = await import("@/lib/queries/calling");
    await sql`update campaigns set calling_enabled = true where id = any(${Object.values(campaigns)})`;
    await sql`update contacts set phone = '+420777123456' where company_id = ${companyId}`;

    const before = await calling.listCallQueue(campaigns.asn, { limit: 50 });
    expect(before.length).toBeGreaterThan(0);

    await suppression.excludeCompanyForClient({ clientId: asnId, companyId });
    const after = await calling.listCallQueue(campaigns.asn, { limit: 50 });
    expect(after).toHaveLength(0);

    // Pro druhého klienta se nic nezměnilo.
    expect((await calling.listCallQueue(campaigns.vexy, { limit: 50 })).length).toBeGreaterThan(0);
  });
});

describe("suppression neobejdeš", () => {
  it("velká písmena a mezery v adrese blokaci neobejdou", async () => {
    const contacts = await import("@/lib/queries/contacts");
    await contacts.suppressEmail("  ANA@Acme.TEST  ", "manual");
    const [row] = await sql<{ email: string }[]>`select email from suppression_list`;
    expect(row.email).toBe("ana@acme.test");

    // Kontakt s jinou velikostí písmen se do kampaně nedostane.
    const seed = await seedCampaign({ contacts: [{ email: "jiny@acme.test" }] });
    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email) values ('ana@acme.test') returning id`;
    await expect(
      sql`insert into campaign_contacts (campaign_id, contact_id)
          values (${seed.campaignId}, ${contact.id})`,
    ).rejects.toThrow(/suppression/);
  });

  it("duplicitní suppression nerozbije stav", async () => {
    const contacts = await import("@/lib/queries/contacts");
    await contacts.suppressEmail("x@acme.test", "unsubscribe", undefined, {
      reasonCode: "unsubscribe", source: "unsubscribe_link",
    });
    await contacts.suppressEmail("x@acme.test", "manual");
    const rows = await sql<{ reason_code: string }[]>`
      select reason_code from suppression_list where email = 'x@acme.test'`;
    expect(rows).toHaveLength(1);
    // První důvod vyhrává: odhlášení se nepřepíše slabší ruční blokací.
    expect(rows[0].reason_code).toBe("unsubscribe");
  });

  it("odhlášený kontakt se nedá vrátit do kampaně ani ručním vložením", async () => {
    const seed = await seedCampaign({ contacts: [{ email: "a@example.com" }] });
    const contacts = await import("@/lib/queries/contacts");
    await contacts.suppressEmail("novy@acme.test", "unsubscribe", undefined, {
      reasonCode: "unsubscribe", source: "unsubscribe_link",
    });
    const [contact] = await sql<{ id: string }[]>`
      insert into contacts (email) values ('novy@acme.test') returning id`;
    await expect(
      sql`insert into campaign_contacts (campaign_id, contact_id)
          values (${seed.campaignId}, ${contact.id})`,
    ).rejects.toThrow();
  });
});

describe("zahájení hovoru", () => {
  it("vyloučenou firmu nejde vytočit ani přímo z detailu", async () => {
    const { asnId, companyId, campaigns } = await twoClients();
    const calls = await import("@/lib/queries/calls");
    const calling = await import("@/lib/queries/calling");
    await sql`update contacts set phone = '+420777123456' where company_id = ${companyId}`;
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });

    const [contact] = await sql<{ id: string; cc: string }[]>`
      select c.id, cc.id as cc from contacts c
        join campaign_contacts cc on cc.contact_id = c.id
       where cc.campaign_id = ${campaigns.asn} limit 1`;

    // Před vyloučením se volat dá.
    const before = await calls.startCall({ campaignContactId: contact.cc, callerId });
    expect(before.ok).toBe(true);

    await suppression.excludeCompanyForClient({ clientId: asnId, companyId });

    const after = await calls.startCall({ campaignContactId: contact.cc, callerId });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.code).toBe("client_excluded");
  });

  it("pro druhého klienta se volat dá dál", async () => {
    const { asnId, companyId, campaigns } = await twoClients();
    const calls = await import("@/lib/queries/calls");
    const calling = await import("@/lib/queries/calling");
    await sql`update contacts set phone = '+420777123456' where company_id = ${companyId}`;
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
    await suppression.excludeCompanyForClient({ clientId: asnId, companyId });

    const [contact] = await sql<{ cc: string }[]>`
      select cc.id as cc from campaign_contacts cc where cc.campaign_id = ${campaigns.vexy} limit 1`;
    const result = await calls.startCall({ campaignContactId: contact.cc, callerId });
    expect(result.ok).toBe(true);
  });
});
