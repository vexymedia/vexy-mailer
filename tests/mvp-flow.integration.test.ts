import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";

/**
 * Chování, na kterém stojí denní práce: firma → člověk → hovor → výsledek →
 * další krok → schůzka.
 *
 * Každý blok pojmenovává díru, kterou hlídá. Bez těchhle testů se nejhorší
 * chyba produktu - firma, která tiše vypadne z procesu - projeví až tím, že
 * na ni nikdo nezavolá.
 */

let sql: typeof import("@/lib/db").sql;
let calling: typeof import("@/lib/queries/calling");
let companies: typeof import("@/lib/queries/companies");
let overview: typeof import("@/lib/queries/overview");
let plan: typeof import("@/lib/queries/plan");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  calling = await import("@/lib/queries/calling");
  companies = await import("@/lib/queries/companies");
  overview = await import("@/lib/queries/overview");
  plan = await import("@/lib/queries/plan");
});

afterAll(async () => {
  await closeDatabase();
});

async function seedWork(options: { contacts?: number; maxAttempts?: number } = {}) {
  const count = options.contacts ?? 2;
  const seed = await seedCampaign({
    contacts: Array.from({ length: count }, (_, i) => ({
      email: `p${i}@prospect.test`,
      first_name: `Jmeno${i}`,
      last_name: `Prijmeni${i}`,
      company: `Firma ${i}`,
    })),
  });
  await sql`
    update campaigns set calling_enabled = true, max_call_attempts = ${options.maxAttempts ?? 4}
     where id = ${seed.campaignId}
  `;
  for (const [index, contactId] of seed.contactIds.entries()) {
    await sql`update contacts set phone = ${`+4207770000${index}`} where id = ${contactId}`;
  }
  const callerId = await calling.createCaller({ name: "Jan Caller", email: null, phone: null });
  return { ...seed, ids: seed.campaignContactIds, callerId };
}

async function companyOf(email: string) {
  const [row] = await sql<{ id: string; status: string; name: string }[]>`
    select co.id, co.status, co.name
      from companies co join contacts c on c.company_id = co.id
     where c.email = ${email}
  `;
  return row;
}

// 1 + 2 --------------------------------------------------------------------
describe("Volat jindy", () => {
  it("nejde uložit bez data", async () => {
    const { ids } = await seedWork();
    const result = await calling.logCall({ campaignContactId: ids[0], outcome: "callback" });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("datum");

    // Nic se nesmí zapsat: ani pokus, ani aktivita.
    const [row] = await sql<{ call_attempts: number }[]>`
      select call_attempts from campaign_contacts where id = ${ids[0]}
    `;
    expect(row.call_attempts).toBe(0);
    const [{ count }] = await sql<{ count: number }[]>`select count(*)::int from call_activities`;
    expect(count).toBe(0);
  });

  it("s datem vytvoří další krok", async () => {
    const { ids } = await seedWork();
    const when = new Date(Date.now() + 3 * 86_400_000);
    const result = await calling.logCall({
      campaignContactId: ids[0],
      outcome: "callback",
      callbackAt: when,
    });
    expect(result.ok).toBe(true);

    const [row] = await sql<{ call_status: string; next_call_at: Date }[]>`
      select call_status, next_call_at from campaign_contacts where id = ${ids[0]}
    `;
    expect(row.call_status).toBe("callback");
    expect(row.next_call_at.getTime()).toBe(when.getTime());
  });
});

// 3 ------------------------------------------------------------------------
describe("Nebere telefon", () => {
  it("zvýší počet pokusů a naplánuje další follow-up", async () => {
    const { ids } = await seedWork();
    const before = new Date();
    const result = await calling.logCall({ campaignContactId: ids[0], outcome: "busy" });
    expect(result.ok).toBe(true);

    const [row] = await sql<{ call_attempts: number; call_status: string; next_call_at: Date | null }[]>`
      select call_attempts, call_status, next_call_at from campaign_contacts where id = ${ids[0]}
    `;
    expect(row.call_attempts).toBe(1);
    expect(row.call_status).toBe("in_progress");
    // Tohle je celé jádro: otevřená firma NIKDY nesmí zůstat bez data.
    expect(row.next_call_at).not.toBeNull();
    expect(row.next_call_at!.getTime()).toBeGreaterThan(before.getTime());
  });

  it("naplánovaný follow-up drží firmu mimo dnešní frontu", async () => {
    const { campaignId, ids } = await seedWork();
    await calling.logCall({ campaignContactId: ids[0], outcome: "busy" });

    const queue = await calling.listCallQueue(campaignId);
    expect(queue.map((q) => q.id)).not.toContain(ids[0]);

    // Až termín nastane, firma se vrátí sama.
    await sql`update campaign_contacts set next_call_at = now() - interval '1 minute' where id = ${ids[0]}`;
    const later = await calling.listCallQueue(campaignId);
    expect(later.map((q) => q.id)).toContain(ids[0]);
  });
});

// 4 ------------------------------------------------------------------------
describe("Schůzka sjednána", () => {
  it("uloží schůzku a vyřadí firmu z běžné calling fronty", async () => {
    const { campaignId, ids } = await seedWork();
    const when = new Date(Date.now() + 5 * 86_400_000);
    const result = await calling.logCall({
      campaignContactId: ids[0],
      outcome: "meeting_booked",
      meetingAt: when,
      meetingQualified: true,
    });
    expect(result.ok).toBe(true);

    const [row] = await sql<
      { meeting_booked: boolean; meeting_at: Date; meeting_outcome: string; call_status: string }[]
    >`
      select meeting_booked, meeting_at, meeting_outcome, call_status
        from campaign_contacts where id = ${ids[0]}
    `;
    expect(row.meeting_booked).toBe(true);
    expect(row.meeting_at.getTime()).toBe(when.getTime());
    expect(row.meeting_outcome).toBe("scheduled");
    expect(row.call_status).toBe("meeting_booked");

    expect((await calling.listCallQueue(campaignId)).map((q) => q.id)).not.toContain(ids[0]);
    expect((await companyOf("p0@prospect.test")).status).toBe("meeting");

    // Na detailu firmy je dalším krokem schůzka, ne hovor.
    const next = await calling.getCompanyNextStep((await companyOf("p0@prospect.test")).id);
    expect(next?.kind).toBe("meeting");
    expect(next?.at.getTime()).toBe(when.getTime());
  });
});

// 5 ------------------------------------------------------------------------
describe("Nekontaktovat", () => {
  it("zapíše call suppression a kontakt zmizí z fronty napříč kampaněmi", async () => {
    const { campaignId, ids, contactIds } = await seedWork();
    await calling.logCall({ campaignContactId: ids[0], outcome: "do_not_call" });

    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from call_suppression where contact_id = ${contactIds[0]}
    `;
    expect(count).toBe(1);
    expect((await calling.listCallQueue(campaignId)).map((q) => q.id)).not.toContain(ids[0]);
    expect((await companyOf("p0@prospect.test")).status).toBe("excluded");
  });
});

// 6 + 7 --------------------------------------------------------------------
describe("firma bez dalšího kroku", () => {
  it("aktivní firma bez dalšího kroku se hlásí jako problém", async () => {
    await seedWork();
    const company = await companyOf("p0@prospect.test");
    await companies.updateCompany(company.id, { status: "in_progress" });

    const detail = await companies.getCompany(company.id);
    expect(detail?.needs_attention).toBe(true);

    const { rows } = await companies.listCompanies({ nextAction: "none" });
    expect(rows.map((r) => r.id)).toContain(company.id);
    expect((await overview.getOverviewStats()).without_next_step).toBeGreaterThan(0);
  });

  it("uzavřená firma bez dalšího kroku problém není", async () => {
    await seedWork();
    const company = await companyOf("p0@prospect.test");
    await companies.updateCompany(company.id, { status: "lost" });

    const detail = await companies.getCompany(company.id);
    expect(detail?.needs_attention).toBe(false);

    const { rows } = await companies.listCompanies({ nextAction: "none" });
    expect(rows.map((r) => r.id)).not.toContain(company.id);
  });

  it("naplánování dalšího kroku problém odstraní", async () => {
    const { ids } = await seedWork();
    const company = await companyOf("p0@prospect.test");
    await companies.updateCompany(company.id, { status: "in_progress" });
    expect((await companies.getCompany(company.id))?.needs_attention).toBe(true);

    const when = new Date(Date.now() + 86_400_000);
    const result = await calling.scheduleNextStep(ids[0], when);
    expect(result.ok).toBe(true);

    const after = await companies.getCompany(company.id);
    expect(after?.needs_attention).toBe(false);
    expect(after?.next_action_at?.getTime()).toBe(when.getTime());
    // Naplánování není hovor - počet pokusů se nesmí hnout.
    const [row] = await sql<{ call_attempts: number }[]>`
      select call_attempts from campaign_contacts where id = ${ids[0]}
    `;
    expect(row.call_attempts).toBe(0);
  });
});

// 8 ------------------------------------------------------------------------
describe("suppression", () => {
  it("kontakt na do-not-call listu nejde aktivně zavolat", async () => {
    const { campaignId, ids, contactIds, callerId } = await seedWork();
    await sql`insert into call_suppression (contact_id, reason) values (${contactIds[0]}, 'do_not_call')`;

    expect((await calling.listCallQueue(campaignId)).map((q) => q.id)).not.toContain(ids[0]);

    // Ani přes rezervaci: claim ho nesmí vybrat.
    for (let i = 0; i < 5; i++) {
      const claimed = await calling.claimNextCall(campaignId, callerId);
      if (claimed === null) break;
      expect(claimed).not.toBe(ids[0]);
      await calling.releaseCall(claimed);
      await sql`update campaign_contacts set next_call_at = now() + interval '1 day' where id = ${claimed}`;
    }

    // A detail firmy to má označené, ne schované.
    const company = await companyOf("p0@prospect.test");
    const contacts = await companies.listCompanyContacts(company.id);
    const blocked = contacts.find((c) => c.email === "p0@prospect.test");
    expect(blocked?.do_not_call).toBe(true);
    expect(blocked?.callable).toBe(false);
  });
});

// 9 ------------------------------------------------------------------------
describe("pracovní blok", () => {
  it("Začít otevře frontu zúženou na typ bloku", async () => {
    const { campaignId, ids } = await seedWork({ contacts: 3 });
    // Firma 0 je rozvolaná, zbytek nevolaný.
    await calling.logCall({ campaignContactId: ids[0], outcome: "busy" });
    await sql`update campaign_contacts set next_call_at = now() - interval '1 minute' where id = ${ids[0]}`;

    const first = await calling.listCallQueue(campaignId, { mode: "first" });
    expect(first.every((r) => r.call_attempts === 0)).toBe(true);
    expect(first.map((r) => r.id)).not.toContain(ids[0]);

    const followUp = await calling.listCallQueue(campaignId, { mode: "followup" });
    expect(followUp.map((r) => r.id)).toEqual([ids[0]]);

    // Blok v plánu na tuhle frontu odkazuje, takže musí jít vytvořit.
    const monday = plan.startOfWeek(new Date());
    const blockId = await plan.createWorkBlock({
      date: plan.isoDate(monday),
      startMinute: 540,
      endMinute: 660,
      callerId: null,
      activityType: "follow_up",
      note: null,
    });
    expect(blockId).toBeTruthy();
  });

  it("rezervace respektuje režim bloku", async () => {
    const { campaignId, ids, callerId } = await seedWork({ contacts: 3 });
    await calling.logCall({ campaignContactId: ids[0], outcome: "busy" });
    await sql`update campaign_contacts set next_call_at = now() - interval '1 minute' where id = ${ids[0]}`;

    const claimed = await calling.claimNextCall(campaignId, callerId, "followup");
    expect(claimed).toBe(ids[0]);
  });
});

// 10 -----------------------------------------------------------------------
describe("plynulé pokračování", () => {
  it("po zápisu výsledku je hned připravená další firma", async () => {
    const { campaignId, ids, callerId } = await seedWork({ contacts: 3 });

    const first = await calling.claimNextCall(campaignId, callerId);
    expect(first).not.toBeNull();
    await calling.logCall({ campaignContactId: first!, outcome: "no_answer", callerId });

    // Přesně to, co udělá logCallAction hned po uložení výsledku.
    const second = await calling.claimNextCall(campaignId, callerId);
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);

    const held = await calling.getHeldCall(campaignId, callerId);
    expect(held?.prospect.id).toBe(second);
    expect(ids).toContain(held!.prospect.id);
  });
});

// 11 -----------------------------------------------------------------------
describe("počet pokusů", () => {
  it("počítá jen skutečné pokusy o volání", async () => {
    const { ids } = await seedWork({ contacts: 2 });
    const company = await companyOf("p0@prospect.test");

    // Editace firmy, naplánování kroku ani e-mail nejsou pokus o volání.
    await companies.updateCompany(company.id, { priority: "high" });
    await calling.scheduleNextStep(ids[0], new Date(Date.now() + 86_400_000));
    expect((await companies.getCompany(company.id))?.attempts).toBe(0);

    await calling.logCall({ campaignContactId: ids[0], outcome: "no_answer" });
    await sql`update campaign_contacts set next_call_at = now() - interval '1 minute' where id = ${ids[0]}`;
    await calling.logCall({ campaignContactId: ids[0], outcome: "gatekeeper" });

    expect((await companies.getCompany(company.id))?.attempts).toBe(2);
    const [{ count }] = await sql<{ count: number }[]>`
      select count(*)::int from call_activities where campaign_contact_id = ${ids[0]}
    `;
    expect(count).toBe(2);
  });

  it("sčítá pokusy přes všechny kontakty firmy", async () => {
    const seed = await seedCampaign({
      contacts: [
        { email: "a@acme.test", company: "Acme" },
        { email: "b@acme.test", company: "Acme" },
      ],
    });
    await sql`update campaigns set calling_enabled = true where id = ${seed.campaignId}`;
    await sql`update contacts set phone = '+420777000001'`;
    await calling.logCall({ campaignContactId: seed.campaignContactIds[0], outcome: "no_answer" });
    await calling.logCall({ campaignContactId: seed.campaignContactIds[1], outcome: "no_answer" });

    const company = await companyOf("a@acme.test");
    expect((await companies.getCompany(company.id))?.attempts).toBe(2);
  });
});

// 12 -----------------------------------------------------------------------
describe("Dnes řešit", () => {
  it("řadí po termínu před dnešek a dnešek před nové firmy", async () => {
    const { ids } = await seedWork({ contacts: 3 });

    await sql`update campaign_contacts set call_status = 'callback', call_attempts = 1,
                     next_call_at = now() - interval '3 days' where id = ${ids[0]}`;
    await sql`update campaign_contacts set call_status = 'callback', call_attempts = 1,
                     next_call_at = date_trunc('day', now()) + interval '10 hours' where id = ${ids[1]}`;

    const todo = await overview.getTodayWork();
    const kinds = todo.map((t) => t.kind);
    expect(kinds[0]).toBe("overdue");
    expect(kinds[1]).toBe("followup");
    // Nevolaná firma je až za splatnými follow-upy.
    expect(kinds.indexOf("queue")).toBeGreaterThan(kinds.indexOf("followup"));
  });

  it("nabídne i aktivní firmu, která nemá další krok", async () => {
    const { ids } = await seedWork({ contacts: 1 });
    const company = await companyOf("p0@prospect.test");
    await companies.updateCompany(company.id, { status: "in_progress" });
    // Kontakt uzavřeme, takže firma zůstane aktivní, ale bez dalšího kroku.
    await sql`update campaign_contacts set call_status = 'lost' where id = ${ids[0]}`;

    const todo = await overview.getTodayWork();
    const attention = todo.find((t) => t.kind === "attention");
    expect(attention?.title).toBe(company.name);
    expect(attention?.href).toBe(`/firmy/${company.id}`);
  });
});

// funnel -------------------------------------------------------------------
describe("provozní metriky", () => {
  it("dovolatelnost a meeting rate počítá ze skutečných hovorů", async () => {
    const { campaignId, ids } = await seedWork({ contacts: 3 });
    await calling.logCall({ campaignContactId: ids[0], outcome: "no_answer" });
    await calling.logCall({ campaignContactId: ids[1], outcome: "not_interested" });
    await calling.logCall({
      campaignContactId: ids[2],
      outcome: "meeting_booked",
      meetingAt: new Date(Date.now() + 86_400_000),
    });

    const report = await calling.getCampaignCallingReport(campaignId);
    expect(report.attempts).toBe(3);
    expect(report.counts.connected_calls).toBe(2);
    expect(report.rates.reach_rate).toBeCloseTo(2 / 3, 6);
    expect(report.rates.meeting_rate).toBeCloseTo(1 / 2, 6);
  });

  it("nevymýšlí si metriku, když chybí jmenovatel", async () => {
    const { campaignId } = await seedWork();
    const report = await calling.getCampaignCallingReport(campaignId);
    expect(report.rates.reach_rate).toBeNull();
    expect(report.rates.meeting_rate).toBeNull();
  });
});
