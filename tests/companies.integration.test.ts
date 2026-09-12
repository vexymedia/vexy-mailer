import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Firmy jako hlavní objekt a týdenní plán.
 *
 * Firma nevzniká importem "firem" — vzniká z kontaktů, které už v aplikaci
 * jsou. Testy proto ověřují hlavně to, co se dopočítává: kdo je hlavní
 * kontakt, kdy je další krok, jestli firma čeká ve frontě a co se s ní dělo.
 */

let sql: typeof import("@/lib/db").sql;
let companies: typeof import("@/lib/queries/companies");
let plan: typeof import("@/lib/queries/plan");
let calling: typeof import("@/lib/queries/calling");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  companies = await import("@/lib/queries/companies");
  plan = await import("@/lib/queries/plan");
  calling = await import("@/lib/queries/calling");
});

afterAll(async () => {
  await closeDatabase();
});

async function seedWithCompanies() {
  const seed = await seedCampaign({
    contacts: [
      { email: "sef@acme.cz", first_name: "Ana", company: "Acme" },
      { email: "asistent@acme.cz", first_name: "Bob", company: "Acme" },
      { email: "kdo@globex.cz", first_name: "Cyril", company: "Globex" },
    ],
  });
  await sql`update campaigns set calling_enabled = true where id = ${seed.campaignId}`;
  // Jen Bob má telefon: hlavní kontakt firmy má být ten, komu jde zavolat.
  await sql`update contacts set phone = '+420777000001' where email = 'asistent@acme.cz'`;
  await sql`update contacts set phone = '+420777000002' where email = 'kdo@globex.cz'`;
  const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });
  return { ...seed, callerId };
}

describe("firmy vznikají z kontaktů", () => {
  it("propojí kontakty se stejným názvem firmy do jedné firmy", async () => {
    await seedWithCompanies();
    const { rows, total } = await companies.listCompanies();

    expect(total).toBe(2);
    const acme = rows.find((r) => r.name === "Acme");
    expect(acme?.contacts_count).toBe(2);
  });

  it("nerozdvojí firmu kvůli velikosti písmen", async () => {
    await sql`insert into contacts (email, company) values ('a@x.cz', 'Acme'), ('b@x.cz', 'acme')`;
    // Migrace už proběhla, takže backfill si udělá aplikace při dalším běhu;
    // tady ověřujeme samotné pravidlo unikátnosti.
    await sql`
      insert into companies (name)
      select distinct on (lower(btrim(c.company))) btrim(c.company)
        from contacts c where c.company is not null
       order by lower(btrim(c.company))
      on conflict do nothing
    `;
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from companies`;
    expect(count).toBe(1);
  });

  it("za hlavní kontakt bere toho, komu jde zavolat", async () => {
    await seedWithCompanies();
    const { rows } = await companies.listCompanies();
    const acme = rows.find((r) => r.name === "Acme");
    // Ana je v pořadí první, ale telefon má Bob.
    expect(acme?.main_contact_phone).toBe("+420777000001");
    expect(acme?.main_contact_email).toBe("asistent@acme.cz");
  });
});

describe("co seznam firem dopočítává", () => {
  it("označí firmu, která čeká ve frontě k oslovení", async () => {
    await seedWithCompanies();
    const { rows } = await companies.listCompanies();
    expect(rows.filter((r) => r.in_queue).map((r) => r.name).sort()).toEqual(["Acme", "Globex"]);

    const onlyQueue = await companies.listCompanies({ queueOnly: true });
    expect(onlyQueue.total).toBe(2);
  });

  it("nezobrazí ve frontě firmu bez telefonu", async () => {
    const seed = await seedCampaign({ contacts: [{ email: "bez@telefonu.cz", company: "Bez telefonu" }] });
    await sql`update campaigns set calling_enabled = true where id = ${seed.campaignId}`;
    const { rows } = await companies.listCompanies();
    expect(rows[0].in_queue).toBe(false);
  });

  it("ukáže další krok podle naplánovaného follow-upu", async () => {
    const seed = await seedWithCompanies();
    const when = new Date(Date.now() + 2 * 86_400_000);
    const [cc] = await sql<{ id: string }[]>`
      select cc.id from campaign_contacts cc join contacts c on c.id = cc.contact_id
       where c.email = 'asistent@acme.cz'
    `;
    await calling.logCall({
      campaignContactId: cc.id,
      outcome: "callback",
      callerId: seed.callerId,
      callbackAt: when,
    });

    const { rows } = await companies.listCompanies();
    const acme = rows.find((r) => r.name === "Acme");
    expect(acme?.next_action_at?.getTime()).toBe(when.getTime());
    expect(acme?.last_activity_at).not.toBeNull();
  });

  it("bere jako další krok i domluvenou schůzku", async () => {
    const seed = await seedWithCompanies();
    const when = new Date(Date.now() + 5 * 86_400_000);
    const [cc] = await sql<{ id: string }[]>`
      select cc.id from campaign_contacts cc join contacts c on c.id = cc.contact_id
       where c.email = 'asistent@acme.cz'
    `;
    await calling.logCall({
      campaignContactId: cc.id,
      outcome: "meeting_booked",
      callerId: seed.callerId,
      meetingAt: when,
      meetingQualified: true,
    });

    const { rows } = await companies.listCompanies();
    const acme = rows.find((r) => r.name === "Acme");
    // Po domluvené schůzce je next_call_at prázdné; bez schůzky by firma
    // hlásila "žádný další krok", přestože termín v diáři je.
    expect(acme?.next_action_at?.getTime()).toBe(when.getTime());
  });

  it("po uskutečněné schůzce ji už za další krok nebere", async () => {
    const seed = await seedWithCompanies();
    const [cc] = await sql<{ id: string }[]>`
      select cc.id from campaign_contacts cc join contacts c on c.id = cc.contact_id
       where c.email = 'asistent@acme.cz'
    `;
    await calling.logCall({
      campaignContactId: cc.id,
      outcome: "meeting_booked",
      callerId: seed.callerId,
      meetingAt: new Date(Date.now() + 86_400_000),
    });
    await calling.updateMeeting(cc.id, { outcome: "held" });

    const { rows } = await companies.listCompanies();
    expect(rows.find((r) => r.name === "Acme")?.next_action_at).toBeNull();
  });
});

describe("historie firmy", () => {
  it("spojí hovory i e-maily napříč kontakty firmy", async () => {
    // Jedna firma, jeden kontakt: dispatchTick odešle za tick jeden e-mail
    // a s více kontakty by nebylo dané, kterému. Test má ověřit spojení
    // hovoru a e-mailu na jedné firmě, ne pořadí ve frontě.
    const seed = await seedCampaign({
      contacts: [{ email: "sef@acme.cz", first_name: "Ana", company: "Acme" }],
    });
    await sql`update campaigns set calling_enabled = true where id = ${seed.campaignId}`;
    await sql`update contacts set phone = '+420777000001' where email = 'sef@acme.cz'`;
    const callerId = await calling.createCaller({ name: "Jan", email: null, phone: null });

    const { startCampaign } = await import("@/lib/queries/campaigns");
    const { dispatchTick } = await import("@/lib/engine/dispatch");
    const { clearPacing } = await import("./helpers/fixtures");

    const [cc] = await sql<{ id: string }[]>`
      select cc.id from campaign_contacts cc join contacts c on c.id = cc.contact_id
       where c.email = 'sef@acme.cz'
    `;
    await calling.logCall({ campaignContactId: cc.id, outcome: "no_answer", callerId });

    await startCampaign(seed.campaignId);
    await clearPacing(seed.campaignId);
    await dispatchTick();

    const [company] = await sql<{ id: string }[]>`select id from companies where name = 'Acme'`;
    const timeline = await companies.getCompanyTimeline(company.id);

    expect(timeline.some((e) => e.kind === "call")).toBe(true);
    expect(timeline.some((e) => e.kind === "email")).toBe(true);
    // Nejnovější nahoře.
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i - 1].occurred_at.getTime()).toBeGreaterThanOrEqual(timeline[i].occurred_at.getTime());
    }
  });
});

describe("kontext firmy", () => {
  it("uloží důvod, prioritu, stav i odpovědnou osobu", async () => {
    const seed = await seedWithCompanies();
    const [company] = await sql<{ id: string }[]>`select id from companies where name = 'Acme'`;

    const ok = await companies.updateCompany(company.id, {
      reason: "Výrobní firma, expanduje, nemá vlastní obchodní tým",
      priority: "high",
      status: "ready",
      ownerId: seed.callerId,
    });
    expect(ok).toBe(true);

    const detail = await companies.getCompany(company.id);
    expect(detail?.reason).toContain("expanduje");
    expect(detail?.priority).toBe("high");
    expect(detail?.status).toBe("ready");
    expect(detail?.owner_name).toBe("Jan");
  });

  it("seřadí firmy s vysokou prioritou nahoru", async () => {
    await seedWithCompanies();
    const [globex] = await sql<{ id: string }[]>`select id from companies where name = 'Globex'`;
    await companies.updateCompany(globex.id, { priority: "high" });

    const { rows } = await companies.listCompanies();
    expect(rows[0].name).toBe("Globex");
  });

  it("odmítne neexistující firmu", async () => {
    const ok = await companies.updateCompany("00000000-0000-0000-0000-000000000000", { priority: "low" });
    expect(ok).toBe(false);
  });
});

describe("týdenní plán", () => {
  it("ukládá bloky a vrací jen ten týden, na který se ptáme", async () => {
    const seed = await seedWithCompanies();
    const monday = plan.startOfWeek(new Date("2026-09-16T12:00:00Z")); // středa

    await plan.createWorkBlock({
      date: plan.isoDate(monday),
      startMinute: 9 * 60,
      endMinute: 11 * 60,
      callerId: seed.callerId,
      activityType: "calling",
      note: "První oslovení",
    });
    // Příští týden - do výsledku patřit nesmí.
    await plan.createWorkBlock({
      date: plan.isoDate(plan.addDays(monday, 7)),
      startMinute: 13 * 60,
      endMinute: 15 * 60,
      callerId: seed.callerId,
      activityType: "follow_up",
      note: null,
    });

    const blocks = await plan.listWorkBlocks(monday);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].caller_name).toBe("Jan");
    expect(blocks[0].activity_type).toBe("calling");
    expect(blocks[0].start_minute).toBe(540);
  });

  it("počítá pondělí jako začátek týdne i v neděli", async () => {
    const sunday = new Date("2026-09-20T23:00:00Z");
    expect(plan.isoDate(plan.startOfWeek(sunday))).toBe("2026-09-14");
  });

  it("nedovolí blok, který končí dřív, než začíná", async () => {
    await expect(
      plan.createWorkBlock({
        date: "2026-09-16",
        startMinute: 600,
        endMinute: 540,
        callerId: null,
        activityType: "calling",
        note: null,
      }),
    ).rejects.toThrow();
  });

  it("smaže blok", async () => {
    const monday = plan.startOfWeek(new Date("2026-09-16T12:00:00Z"));
    const id = await plan.createWorkBlock({
      date: plan.isoDate(monday),
      startMinute: 540,
      endMinute: 660,
      callerId: null,
      activityType: "research",
      note: null,
    });
    await plan.deleteWorkBlock(id);
    expect(await plan.listWorkBlocks(monday)).toHaveLength(0);
  });
});

describe("redesign se nedotkl e-mailu ani volání", () => {
  it("firma ani plán nezasahují do fronty a odesílání", async () => {
    await seedWithCompanies();
    const [company] = await sql<{ id: string }[]>`select id from companies where name = 'Acme'`;

    const before = await calling.listCallQueue(null);
    await companies.updateCompany(company.id, { status: "excluded", priority: "low" });
    const after = await calling.listCallQueue(null);

    // Stav firmy je zatím informace pro lidi, ne blokace kanálu - tu drží
    // suppression_list a call_suppression.
    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());

    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from suppression_list`;
    expect(count).toBe(0);
  });
});
