import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closeDatabase, resetDatabase } from "./helpers/db";
import { enableSimulateMode, seedCampaign } from "./helpers/fixtures";
import type { ParsedContactRow } from "@/lib/csv";

/**
 * Co se smí započítat do klientovy kvóty.
 *
 * VEXY prodává „až 300 relevantních lidí měsíčně". Když se do kampaně
 * zapíše člověk, kterému se stejně nikdy nesmí napsat ani zavolat, je to
 * dvojí problém: klientovi ubude z kvóty někdo, koho nikdy nedostane,
 * a operátor vidí v kampani čísla, která neodpovídají skutečné práci.
 *
 * Serverové guardy odesílání i volání fungují a nic se neodešle. Tenhle
 * soubor hlídá to druhé: aby se takový kontakt do kampaně vůbec nedostal
 * a import o něm řekl proč.
 */

let sql: typeof import("@/lib/db").sql;
let contacts: typeof import("@/lib/queries/contacts");

beforeEach(async () => {
  await resetDatabase();
  await enableSimulateMode();
  ({ sql } = await import("@/lib/db"));
  contacts = await import("@/lib/queries/contacts");
});

afterAll(async () => {
  await closeDatabase();
});

function row(email: string, overrides: Partial<ParsedContactRow> = {}): ParsedContactRow {
  return {
    email,
    first_name: "Ana",
    last_name: "Nováková",
    company: "Acme a.s.",
    website: null,
    phone: "+420777123456",
    position: null,
    ...overrides,
  } as ParsedContactRow;
}

/** Kampaň klienta VEXY, plus firma, kterou lze vyloučit. */
async function setup() {
  const [vexy] = await sql<{ id: string }[]>`insert into clients (name) values ('VEXY') returning id`;
  const seed = await seedCampaign({ contacts: [] });
  await sql`update campaigns set client_id = ${vexy.id} where id = ${seed.campaignId}`;
  const [company] = await sql<{ id: string }[]>`
    insert into companies (name, status, ico) values ('Acme a.s.', 'ready', '12345678') returning id`;
  return { clientId: vexy.id, campaignId: seed.campaignId, companyId: company.id };
}

async function enrolled(campaignId: string) {
  const [r] = await sql<{ count: number }[]>`
    select count(*)::int from campaign_contacts where campaign_id = ${campaignId}`;
  return r.count;
}

// ============================================ vyloučená firma se nezapíše

describe("klientské vyloučení se respektuje už při zápisu do kampaně", () => {
  it("kontakt z vyloučené firmy se do kampaně nedostane", async () => {
    const s = await setup();
    const suppression = await import("@/lib/queries/suppression");
    await suppression.excludeCompanyForClient({
      clientId: s.clientId, companyId: s.companyId, reason: "Vlastní zákazník.",
    });
    // Kontakt se naváže na tu vyloučenou firmu.
    await sql`insert into contacts (email, first_name, company, company_id)
              values ('ana@acme.test', 'Ana', 'Acme a.s.', ${s.companyId})`;

    const result = await contacts.importContacts([row("ana@acme.test")], s.campaignId);

    expect(await enrolled(s.campaignId)).toBe(0);
    expect(result.excluded).toBe(1);
    expect(result.addedToCampaign).toBe(0);
  });

  it("kontakt z nevyloučené firmy se zapíše normálně", async () => {
    const s = await setup();
    await sql`insert into contacts (email, first_name, company, company_id)
              values ('ana@acme.test', 'Ana', 'Acme a.s.', ${s.companyId})`;
    const result = await contacts.importContacts([row("ana@acme.test")], s.campaignId);
    expect(await enrolled(s.campaignId)).toBe(1);
    expect(result.addedToCampaign).toBe(1);
    expect(result.excluded).toBe(0);
  });

  it("vyloučení u JINÉHO klienta tuhle kampaň neomezí", async () => {
    const s = await setup();
    const [asn] = await sql<{ id: string }[]>`
      insert into clients (name) values ('ASN Plus') returning id`;
    const suppression = await import("@/lib/queries/suppression");
    await suppression.excludeCompanyForClient({
      clientId: asn.id, companyId: s.companyId, reason: "Konkurent.",
    });
    await sql`insert into contacts (email, first_name, company, company_id)
              values ('ana@acme.test', 'Ana', 'Acme a.s.', ${s.companyId})`;

    const result = await contacts.importContacts([row("ana@acme.test")], s.campaignId);
    expect(await enrolled(s.campaignId)).toBe(1);
    expect(result.excluded).toBe(0);
  });
});

// ================================================= klasifikace importu

describe("import řekne, co se s každým řádkem stalo", () => {
  it("rozliší nové, známé, vyloučené a suppressed — nic nezmizí potichu", async () => {
    const s = await setup();
    const suppression = await import("@/lib/queries/suppression");
    await suppression.excludeCompanyForClient({
      clientId: s.clientId, companyId: s.companyId, reason: "Vlastní zákazník.",
    });
    // vyloučený (firma), suppressed (globálně), známý, nový
    await sql`insert into contacts (email, first_name, company, company_id)
              values ('vylouceny@acme.test', 'A', 'Acme a.s.', ${s.companyId})`;
    await sql`insert into contacts (email, first_name) values ('znamy@jinde.test', 'B')`;
    await sql`insert into suppression_list (email, reason) values ('suppressed@jinde.test', 'unsubscribe')`;

    // Vyloučený je z Acme; ostatní schválně z jiné firmy, aby se
    // nevyloučili taky - vyloučení je vlastnost FIRMY, ne řádku.
    const jinde = { company: "Jinde s.r.o." };
    const result = await contacts.importContacts(
      [row("vylouceny@acme.test"), row("znamy@jinde.test", jinde),
       row("suppressed@jinde.test", jinde), row("novy@jinde.test", jinde)],
      s.campaignId,
    );

    // Součet klasifikací musí sedět na počet řádků. Žádný silent drop.
    const accounted = result.addedToCampaign + result.excluded + result.suppressed.length
      + result.alreadyInCampaign;
    expect(accounted).toBe(4);
    expect(result.excluded).toBe(1);
    expect(result.suppressed).toEqual(["suppressed@jinde.test"]);
    expect(result.addedToCampaign).toBe(2); // znamy + novy
  });

  it("stejný import podruhé nikoho nepřidá znovu", async () => {
    const s = await setup();
    const rows = [row("ana@acme.test"), row("petr@acme.test")];
    const first = await contacts.importContacts(rows, s.campaignId);
    expect(first.addedToCampaign).toBe(2);

    const second = await contacts.importContacts(rows, s.campaignId);
    expect(second.addedToCampaign).toBe(0);
    expect(second.alreadyInCampaign).toBe(2);
    expect(await enrolled(s.campaignId)).toBe(2);
  });

  it("import bez kampaně kontakty jen založí", async () => {
    const s = await setup();
    const result = await contacts.importContacts([row("ana@acme.test")]);
    expect(result.created).toBe(1);
    expect(result.addedToCampaign).toBe(0);
    void s;
  });
});

// ================================== součet kategorií musí sedět na řádky

describe("součet importu sedí na počet řádků", () => {
  const csv = (lines: string[]) => ["email,first_name,company", ...lines].join("\n");

  async function runImport(text: string, campaignId?: string) {
    const { parseContactsCsv } = await import("@/lib/csv");
    const parsed = parseContactsCsv(text);
    const result = await contacts.importContacts(parsed.rows, campaignId ?? null);
    const { summariseImport, describeImport } = await import("@/lib/queries/contacts");
    const summary = summariseImport(parsed, result, Boolean(campaignId));
    return { parsed, result, summary, text: describeImport(summary) };
  }

  it("směs všech kategorií v jednom importu", async () => {
    const s = await setup();
    const suppression = await import("@/lib/queries/suppression");
    await suppression.excludeCompanyForClient({
      clientId: s.clientId, companyId: s.companyId, reason: "Vlastní zákazník.",
    });
    await sql`insert into contacts (email, first_name, company, company_id)
              values ('vylouceny@acme.test','A','Acme a.s.',${s.companyId})`;
    await sql`insert into suppression_list (email, reason) values ('stop@jinde.test','unsubscribe')`;

    const { summary } = await runImport(csv([
      "vylouceny@acme.test,A,Acme a.s.",     // vyloučená firma
      "stop@jinde.test,B,Jinde s.r.o.",      // suppression
      "novy@jinde.test,C,Jinde s.r.o.",      // přijatý
      "novy@jinde.test,C,Jinde s.r.o.",      // duplicita v souboru
      "neni-email,D,Jinde s.r.o.",           // neplatný
      ",E,Jinde s.r.o.",                     // chybí e-mail
    ]), s.campaignId);

    expect(summary.totalRows).toBe(6);
    expect(summary.invalid).toBe(2);
    expect(summary.duplicatesInFile).toBe(1);
    expect(summary.suppressed).toBe(1);
    expect(summary.excluded).toBe(1);
    expect(summary.acceptedIntoCampaign).toBe(1);
    // A hlavně: nic se neztratilo.
    expect(summary.reconciles).toBe(true);
  });

  it("opakování stejného importu: podruhé se nikdo nepřijme, součet pořád sedí", async () => {
    const s = await setup();
    const text = csv(["a@jinde.test,A,Jinde s.r.o.", "b@jinde.test,B,Jinde s.r.o."]);

    const first = await runImport(text, s.campaignId);
    expect(first.summary.acceptedIntoCampaign).toBe(2);
    expect(first.summary.reconciles).toBe(true);

    const second = await runImport(text, s.campaignId);
    expect(second.summary.acceptedIntoCampaign).toBe(0);
    expect(second.summary.alreadyInCampaign).toBe(2);
    expect(second.summary.reconciles).toBe(true);
  });

  it("stejný kontakt ve dvou kampaních se počítá každé zvlášť", async () => {
    const s = await setup();
    const seed = await seedCampaign({ contacts: [] });
    await sql`update campaigns set client_id = ${s.clientId} where id = ${seed.campaignId}`;
    const text = csv(["a@jinde.test,A,Jinde s.r.o."]);

    expect((await runImport(text, s.campaignId)).summary.acceptedIntoCampaign).toBe(1);
    // Druhá kampaň téhož klienta: je to další oslovení, počítá se znovu.
    expect((await runImport(text, seed.campaignId)).summary.acceptedIntoCampaign).toBe(1);
  });

  it("částečně chybný soubor projde zbytkem a řekne, co vypadlo", async () => {
    const s = await setup();
    const { summary, text } = await runImport(csv([
      "ok1@jinde.test,A,Jinde s.r.o.",
      "rozbity radek bez carky",
      "ok2@jinde.test,B,Jinde s.r.o.",
    ]), s.campaignId);

    expect(summary.acceptedIntoCampaign).toBe(2);
    expect(summary.invalid).toBe(1);
    expect(summary.reconciles).toBe(true);
    expect(text).toContain("2 přijato do kampaně");
    expect(text).toContain("1 neplatných řádků");
  });

  it("import bez kampaně kontakty uloží, ale do kvóty nepočítá", async () => {
    const { summary } = await runImport(csv(["a@jinde.test,A,Jinde s.r.o."]));
    expect(summary.acceptedIntoCampaign).toBe(0);
    expect(summary.createdWithoutCampaign).toBe(1);
    expect(summary.reconciles).toBe(true);
  });

  it("prázdný soubor nespadne a nic nezapočítá", async () => {
    const { summary } = await runImport("email,first_name,company\n");
    expect(summary.totalRows).toBe(0);
    expect(summary.acceptedIntoCampaign).toBe(0);
    expect(summary.reconciles).toBe(true);
  });
});
